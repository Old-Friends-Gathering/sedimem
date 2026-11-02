// render/brief.js — 确定性渲染（RendererPort）。同输入必同输出。
// suspicious 命中（policy.suspiciousPatterns 或 tags 含 'suspicious'）绝不渲染正文，
// 只渲染占位行，防止投毒内容进入 prompt（eval I5）。

import { readFileSync } from 'node:fs';
import { detectSuspicious } from '../hygiene/suspicious.js';

// 策略单一来源（裁决 20）：优先 src/config/policy.js 的 loadPolicy()，缺失时回退读 config/policy.json。
async function loadPolicySafe() {
  try {
    const m = await import('../config/policy.js');
    if (typeof m.loadPolicy === 'function') return m.loadPolicy();
  } catch { /* 模块缺失 → 回退 */ }
  const url = new URL('../../config/policy.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const POLICY = await loadPolicySafe();

const SUSPICIOUS_PATTERNS = (POLICY?.suspiciousPatterns ?? []).map((p) => String(p));
const KIND_ORDER = { pref: 0, decision: 1, gotcha: 2, fact: 3, state: 4 };

/**
 * 裁决 23：末节追加「待裁决去重候选」提示（N 来自入参 dedupeCandidates，>0 才输出；
 * render 保持纯函数，不在渲染内读盘/扫描）。该行作为最后一行，截断时也保留。
 * @param {{scope: string, records: import('../core/record.js').MemoryRecord[], lines?: number,
 *          clock?: object, dedupeCandidates?: number}} input
 * @returns {string}
 */
export function renderBrief({ scope, records, lines = 80, dedupeCandidates } = {}) {
  if (!scope || typeof scope !== 'string') {
    const err = new Error('renderBrief: scope is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (!Array.isArray(records)) {
    const err = new Error('renderBrief: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (!Number.isInteger(lines) || lines < 1) {
    const err = new Error(`renderBrief: lines must be a positive integer, got ${lines}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }

  if (dedupeCandidates !== undefined && (typeof dedupeCandidates !== 'number' || !Number.isFinite(dedupeCandidates) || dedupeCandidates < 0)) {
    const err = new Error(`renderBrief: dedupeCandidates must be a non-negative number, got ${JSON.stringify(dedupeCandidates)}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }

  const footer = typeof dedupeCandidates === 'number' && dedupeCandidates > 0
    ? `待裁决去重候选 ${dedupeCandidates} 条（memory_dedupe_scan 查看）`
    : null;

  const active = records.filter(
    (r) => r && r.status === 'active' && r.validTo === null && !r.expiredAt,
  );

  const counts = { fact: 0, pref: 0, decision: 0, gotcha: 0, state: 0 };
  for (const r of active) if (r.kind in counts) counts[r.kind] += 1;

  const header = [
    `# memo · ${scope}`,
    `active: ${active.length} (fact ${counts.fact} / pref ${counts.pref} / decision ${counts.decision} / gotcha ${counts.gotcha} / state ${counts.state})`,
  ];

  const suspiciousSet = new Set(
    active.filter((r) => isSuspicious(r)).map((r) => r.id),
  );

  // 排序：kind 优先级（pref/decision/gotcha 前）→ hits 降序 → createdAt 降序 → id（确定性）
  const ordered = [...active].sort((a, b) => {
    const ka = KIND_ORDER[a.kind] ?? 9;
    const kb = KIND_ORDER[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    if ((b.hits ?? 0) !== (a.hits ?? 0)) return (b.hits ?? 0) - (a.hits ?? 0);
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });

  const body = ordered.map((r) => lineFor(r, suspiciousSet.has(r.id)));

  const all = [...header, ...body];
  if (footer) all.push(footer);
  if (all.length <= lines) return all.join('\n');

  const budget = footer ? lines - 1 : lines; // 截断时给末节留 1 行
  const kept = all.slice(0, budget - 1);
  const rest = all.length - (budget - 1) - (footer ? 1 : 0);
  return [...kept, `… 其余 ${rest} 条见 memory_search`, ...(footer ? [footer] : [])].join('\n');
}

function lineFor(record, suspicious) {
  // 裁决 16：suspicious 正文绝不进入 brief 输出；整行替换为占位行，不含任何原句。
  if (suspicious) {
    return `- [suspicious withheld]（id ${record.id}）`;
  }
  const asOf = String(record.validFrom ?? '').slice(0, 10) || 'unknown';
  return `- [${record.kind}] ${String(record.text ?? '')}  (as of ${asOf})`;
}

function isSuspicious(record) {
  if (Array.isArray(record.tags) && record.tags.includes('suspicious')) return true;
  // 纵深防御：渲染前对每行正文再跑一次 detectSuspicious（归一化 + 启发式），
  // 防止写入时漏标（如新变体）的投毒原文进入 prompt。
  const text = String(record.text ?? '');
  if (text === '') return false;
  return detectSuspicious(
    text, SUSPICIOUS_PATTERNS, { heuristics: POLICY?.suspiciousHeuristics },
  ).suspicious;
}
