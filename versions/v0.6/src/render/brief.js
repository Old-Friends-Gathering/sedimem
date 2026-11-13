// render/brief.js — 确定性渲染（RendererPort）。同输入必同输出。
// suspicious 命中（policy.suspiciousPatterns 或 tags 含 'suspicious'）绝不渲染正文，
// 只渲染占位行，防止投毒内容进入 prompt（eval I5）。
//
// v0.3 C 路（issue #51）：新增分层渲染。blocks 非空数组时按
// policy.brief.quota = {L2, L3}（缺省即 0 份额）把行预算切成 L2 块目录 / L3 画像 / 散条三层，
// 总字符上限 policy.brief.totalChars ?? 8000，超限先砍散条 → 再砍 L3 → 最后砍 L2。
// blocks 为空或 null 时走原扁平路径，输出与改造前完全一致（视图是可选加速层，不是依赖）。

import { readFileSync } from 'node:fs';
import { detectSuspicious } from '../hygiene/suspicious.js';
// S-04（adv）：brief 输出的每行若含 <memory-context> / </memory-context> 会被宿主
// 当成围栏边界提前闭合注入围栏。转义规则与 inject.js 单一来源（inject.js 只依赖
// config/paths，不反向依赖本文件，无循环依赖）。
import { neutraliseFence } from './inject.js';

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
 *          clock?: object, dedupeCandidates?: number,
 *          policy?: object, now?: number|string, blocks?: object[]|null}} input
 * @returns {string}
 */
export function renderBrief(a, b = {}) {
  // v0.3 冻结接口（docs/plans/v0.3-layered-views.md §3）：renderBrief(records, { policy, now, blocks })
  // 与旧单对象签名并存；首参为数组即按新签名归一，保证旧调用零改动。
  const input = Array.isArray(a)
    ? { scope: b.scope, records: a, lines: b.lines ?? 80, clock: b.clock,
        dedupeCandidates: b.dedupeCandidates, policy: b.policy, now: b.now, blocks: b.blocks }
    : (a ?? {});
  if (!input.scope || typeof input.scope !== 'string') {
    const err = new Error('renderBrief: scope is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (!Array.isArray(input.records)) {
    const err = new Error('renderBrief: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (input.lines === undefined) input.lines = 80;
  if (!Number.isInteger(input.lines) || input.lines < 1) {
    const err = new Error(`renderBrief: lines must be a positive integer, got ${input.lines}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }

  if (input.dedupeCandidates !== undefined && (typeof input.dedupeCandidates !== 'number' || !Number.isFinite(input.dedupeCandidates) || input.dedupeCandidates < 0)) {
    const err = new Error(`renderBrief: dedupeCandidates must be a non-negative number, got ${JSON.stringify(input.dedupeCandidates)}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }

  // 分层路径：blocks 为非空数组才启用；null / 空数组 / 未传 → 扁平降级（字节一致）。
  if (Array.isArray(input.blocks) && input.blocks.length > 0) {
    return renderLayered(input);
  }
  return renderFlat(input);
}

function renderFlat({ scope, records, lines = 80, dedupeCandidates }) {

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
  // S-04：逐行转义围栏标记（含 title/正文带进来的），再进字符裁剪。
  const flat = (rows) => clampChars(rows.map(neutraliseFence).join('\n'), POLICY?.brief?.totalChars ?? DEFAULT_TOTAL_CHARS, rows);
  if (all.length <= lines) return flat(all);

  const budget = footer ? lines - 1 : lines; // 截断时给末节留 1 行
  const kept = all.slice(0, budget - 1);
  const rest = all.length - (budget - 1) - (footer ? 1 : 0);
  return flat([...kept, `… 其余 ${rest} 条见 memory_search`, ...(footer ? [footer] : [])]);
}

/**
 * 按字符上限硬截断（对抗审核③：`memo brief` 实测吐出 16132 字节，
 * 而 policy.brief.totalChars=8000 —— 上限只写在分层路径里，扁平路径根本没读它）。
 * 策略：从尾部砍，footer（末行提示）优先保留。
 */
function clampChars(text, maxChars, rows) {
  if (!Number.isInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const keep = [];
  const footer = rows.length > 1 ? rows[rows.length - 1] : null;
  let used = footer ? footer.length + 1 : 0;
  for (const row of rows) {
    if (footer && row === footer) continue;
    if (used + row.length + 1 > maxChars) break;
    keep.push(row);
    used += row.length + 1;
  }
  const dropped = rows.length - keep.length - (footer ? 1 : 0);
  const tail = `… 另有 ${Math.max(dropped, 0)} 行因字符上限省略（调 policy.brief.totalChars 或 memory_search）`;
  return [...keep, tail, ...(footer ? [footer] : [])].join('\n');
}

function lineFor(record, suspicious) {
  // 裁决 16：suspicious 正文绝不进入 brief 输出；整行替换为占位行，不含任何原句。
  if (suspicious) {
    return `- [suspicious withheld]（id ${record.id}）`;
  }
  const asOf = String(record.validFrom ?? '').slice(0, 10) || 'unknown';
  // W1 写侧粒度契约：行首优先 title；无 title 用 `subject · predicate`（结构化三元组），
  // 不再用 text 全文兜底——长文进 brief 只会挤掉别的行，正文靠 memory_search / memory_get 下钻。
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const head = title !== ''
    ? title
    : `${String(record.subject ?? '')} · ${String(record.predicate ?? '')}`.trim();
  return `- [${record.kind}] ${head}  (as of ${asOf})`;
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

// ─── v0.3 C 路：分层渲染（issue #51） ─────────────────────────────────────────

const DEFAULT_LAYERED_QUOTA = { L2: 0.25, L3: 0.15 };
const DEFAULT_TOTAL_CHARS = 8000;

/** block 归层：显式 layer/level/type 标 L3 的进画像层，其余按 L2 场景块。 */
function isL3Block(block) {
  if (block?.layer === 'L3') return true;
  if (block?.level === 3) return true;
  return typeof block?.type === 'string' && block.type.toLowerCase() === 'l3';
}

function blockCount(block) {
  return block.count ?? block.size ?? (Array.isArray(block.recordIds) ? block.recordIds.length : 1);
}

function blockSpan(block) {
  const first = block.firstAt ?? block.stats?.firstAt ?? block.validFrom ?? block.createdAt ?? '';
  const last = block.lastAt ?? block.stats?.lastAt ?? block.validTo ?? block.createdAt ?? '';
  return `${String(first).slice(0, 10) || 'unknown'}~${String(last).slice(0, 10) || 'unknown'}`;
}

// L2 只给目录不展开 recordIds（渐进披露：Agent 用 memory_search / trace 下钻）。
function l2Line(block) {
  // key 里的 \u0001 是分隔符（防 subject 含 '/' 撞键），给 Agent 看要换成 '/'
  const label = String(block.key ?? block.blockId ?? '?').replace(/\u0001/g, '/');
  return `· ${label}（${blockCount(block)} 条，${blockSpan(block)}）`;
}

function l3Line(block) {
  const n = Array.isArray(block.sourceRefs) && block.sourceRefs.length > 0
    ? block.sourceRefs.length
    : blockCount(block);
  return `◇ ${String(block.text ?? block.key ?? '?')}（${n} 条，${blockSpan(block)}）`;
}

/**
 * 分层渲染：行预算按 quota 切三层（每层非空时 Math.max(1, floor(share*lines)) 保底，
 * 防止小层永远分到 0 —— D3/风险表「配额让某层饿死」），剩余给散条；
 * 总字符超限时按 散条 → L3 → L2 的顺序砍，被砍层末尾标「…略去 N 条」。
 * @param {{scope: string, records: object[], lines?: number, dedupeCandidates?: number,
 *          policy?: object, blocks: object[]}} input
 */
function renderLayered({ scope, records, lines = 80, dedupeCandidates, policy, blocks }) {
  const quota = policy?.brief?.quota ?? DEFAULT_LAYERED_QUOTA;
  const totalChars = policy?.brief?.totalChars ?? DEFAULT_TOTAL_CHARS;

  const active = records.filter(
    (r) => r && r.status === 'active' && r.validTo === null && !r.expiredAt,
  );

  const counts = { fact: 0, pref: 0, decision: 0, gotcha: 0, state: 0 };
  for (const r of active) if (r.kind in counts) counts[r.kind] += 1;

  const header = [
    `# memo · ${scope}`,
    `active: ${active.length} (fact ${counts.fact} / pref ${counts.pref} / decision ${counts.decision} / gotcha ${counts.gotcha} / state ${counts.state})`,
  ];

  const l2Blocks = [];
  const l3Blocks = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    (isL3Block(b) ? l3Blocks : l2Blocks).push(b);
  }
  // 确定性排序：块大小降序（目录价值高的在前）→ blockId 升序 tie-break。
  const byBlock = (mk) => (a, b) => {
    const d = blockCount(b) - blockCount(a);
    if (d !== 0) return d;
    const ka = String(a.blockId ?? a.key ?? '');
    const kb = String(b.blockId ?? b.key ?? '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  l2Blocks.sort(byBlock());
  l3Blocks.sort(byBlock());

  const l2Budget = l2Blocks.length > 0 ? Math.max(1, Math.floor((quota?.L2 ?? 0) * lines)) : 0;
  const l3Budget = l3Blocks.length > 0 ? Math.max(1, Math.floor((quota?.L3 ?? 0) * lines)) : 0;
  const scatBudget = Math.max(0, lines - l2Budget - l3Budget);

  const suspiciousSet = new Set(
    active.filter((r) => isSuspicious(r)).map((r) => r.id),
  );
  const ordered = [...active].sort((a, b) => {
    const ka = KIND_ORDER[a.kind] ?? 9;
    const kb = KIND_ORDER[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    if ((b.hits ?? 0) !== (a.hits ?? 0)) return (b.hits ?? 0) - (a.hits ?? 0);
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
  const scatAll = ordered.map((r) => lineFor(r, suspiciousSet.has(r.id)));

  // cutRank 越小越先被砍：散条(0) → L3(1) → L2(2)。
  const groups = [
    { title: '## L2 场景块', mark: '· ', cutRank: 2, kept: l2Blocks.slice(0, l2Budget).map(l2Line), dropped: 0, total: l2Blocks.length },
    { title: '## L3 画像', mark: '◇ ', cutRank: 1, kept: l3Blocks.slice(0, l3Budget).map(l3Line), dropped: 0, total: l3Blocks.length },
    { title: '## 记录', mark: '- ', cutRank: 0, kept: scatAll.slice(0, scatBudget), dropped: 0, total: scatAll.length },
  ];

  const footer = typeof dedupeCandidates === 'number' && dedupeCandidates > 0
    ? `待裁决去重候选 ${dedupeCandidates} 条（memory_dedupe_scan 查看）`
    : null;

  const assemble = (withMarkers) => {
    const parts = [...header];
    for (const g of groups) {
      if (g.kept.length === 0 && g.dropped === 0) continue;
      parts.push(g.title, ...g.kept);
      if (withMarkers && g.dropped > 0) parts.push(`…略去 ${g.dropped} 条`);
    }
    if (footer) parts.push(footer);
    // S-04：分层路径同样逐行转义围栏标记。
    return parts.map(neutraliseFence).join('\n');
  };

  // 剩余量（层内预算外 + 已被砍的都不再回流）只减不增，循环必然终止。
  const cutNext = () => {
    const victim = groups
      .filter((g) => g.kept.length > 0)
      .sort((x, y) => x.cutRank - y.cutRank)[0];
    if (!victim) return false;
    victim.kept.pop();
    victim.dropped = victim.total - victim.kept.length;
    return true;
  };
  while (assemble(true).length > totalChars && cutNext()) { /* 逐行砍至总字符达标 */ }
  let text = assemble(true);
  if (text.length > totalChars) text = assemble(false); // 退化：连标记行都放不下时丢标记保上限
  return text;
}
