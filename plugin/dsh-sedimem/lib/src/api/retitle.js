// api/retitle.js — `memo retitle` 回填（issue #61 第 5 项）
// 只补「没有 title」的旧记录：把 subject 归一成人能读的短标题，追加一条 v+1 快照 + retitle 事件。
// 为什么不在原地改：items/<scope>.jsonl 是 append-only 真相层（docs/02 §3），改字段只能追加
// 同 id 的补丁行；原行必须留着——as-of 回查与审计都依赖它，行数只增不减。

import { withPatch, validateRecord, normalizeTitle } from '../core/record.js';
import { invalidArg } from '../core/errors.js';
import { withLock } from '../storage/lock.js';
import { nowIso } from '../core/time.js';

/** 回填标题的显示上限（含末尾 `…`）。core/record.js 的 MAX_TITLE(40) 是「合法性上限」，这里是「显示长度」。 */
export const TITLE_MAX = 24;

// 尾部日期 slug：2026-11-03 / 2026/11/03 / 20261103。只吃日期本体，后面的中文（如「停摆」）原样保留。
const DATE_SLUGS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{4}\/\d{2}\/\d{2}\b/g,
  /\b\d{8}\b/g,
];
// 明确的标签前缀（冒号 + 空白）。`proposal-` / `scheme-` 这类裸连字符前缀**故意不匹配**：
// 归一后它们和正常单词无法区分，盲删会把语义切掉（见 isSlugLike 的保守处理）。
const LEADING_LABEL = /^[A-Za-z][A-Za-z0-9._-]{0,40}:\s+/;

/** `_` / `-` → 空格，连续空白折成 1 个，trim。 */
function humanize(s) {
  return String(s ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** slug 形态：>60% ASCII 且含 ≥2 个空格。这种 subject 本身就是机器生成的标识符，原样保留最安全。 */
function isSlugLike(s) {
  const chars = [...s];
  if (chars.length === 0) return false;
  const spaces = chars.filter((c) => c === ' ').length;
  if (spaces < 2) return false;
  const ascii = chars.filter((c) => c.charCodeAt(0) < 0x80).length;
  return ascii / chars.length > 0.6;
}

/**
 * 截到 max 个字符（含末尾 `…`），按码点切，避免劈开代理对。
 * 若切点落在英文单词中间，退到最近的空格（只回退 ≤8 字符，否则宁可硬切），
 * 这样「Mac mini A4x Business Review」不会显示成「Mac mini A4x Business R…」。
 */
function clipTitle(s, max = TITLE_MAX) {
  const chars = [...s];
  if (chars.length <= max) return s;
  let cut = chars.slice(0, max - 1); // 给 `…` 留一位
  const dropped = chars[max - 1];
  if (dropped && /[A-Za-z0-9]/.test(dropped) && /[A-Za-z0-9]/.test(cut[cut.length - 1] ?? '')) {
    const at = cut.lastIndexOf(' ');
    if (at > 0 && at >= cut.length - 8) cut = cut.slice(0, at);
  }
  return `${cut.join('').trimEnd()}…`;
}

/**
 * 从一条记录派生短标题（纯函数，不碰磁盘）。
 * - 已有非空 `title` → 原样返回（调用方负责跳过这类记录，绝不改写人工标题）；
 * - 否则用 `subject`：去日期 slug → 非 slug 才剥 `label:` 前缀 → 折成单行 → 截到 24 字符；
 * - `subject` 为空（或只剩日期/分隔符）→ 返回空串（空标题不许写进真相层）。
 * @param {{title?: unknown, subject?: unknown}} [record]
 * @returns {string}
 */
export function deriveTitle(record) {
  const existing = record?.title;
  if (typeof existing === 'string' && existing.trim() !== '') return existing;

  let s = String(record?.subject ?? '');
  if (s.trim() === '') return '';

  for (const re of DATE_SLUGS) s = s.replace(re, ' ');
  s = s.trim();
  if (s === '') return '';

  // 保守前缀处理：slug 形态一律原样（连字符/下划线是结构的一部分，不是噪声）；
  // 只有明确不是 slug 时，才剥「ASCII 标签 + 冒号 + 空白」这种无歧义的前缀。
  if (!isSlugLike(humanize(s))) s = s.replace(LEADING_LABEL, '');

  s = humanize(s);
  return s === '' ? '' : clipTitle(s);
}

/** 有非空 title 才算「已有标题」；空串/空白串视为缺失（历史脏数据也一并回填）。 */
function hasTitle(rec) {
  return typeof rec?.title === 'string' && rec.title.trim() !== '';
}

/**
 * 回填缺 title 的记录（dryRun 默认 false；limit=0 表示不限制）。
 *
 * 数据源是 `svc.exportRecords({status:'all'})`（含 superseded/tombstoned），但导出是**投影**，
 * 所以每条再按 id 回 `svc._records` 取完整快照；同一 id 多版本时以 v 最大的那条判断。
 *
 * 非 dryRun 在跨进程写锁内逐条追加 `withPatch(r, {title})` + `{ts, op:'retitle', ...}` 事件，
 * 锁内先增量重读一次，避免覆盖别的进程刚写好的 title；写完全量重载（title 补丁不改
 * contentHash/status/hits，增量 fold 会把它当重复快照跳过，必须全量才看得到新 title）。
 *
 * @param {import('./service.js').MemoryService} svc
 * @param {{dryRun?: boolean, limit?: number}} [opts]
 * @returns {Promise<{total: number, changed: number, failed: {id: string, error: string}[],
 *           samples: {id: string, subject: string, title: string}[], dryRun?: boolean, limited: boolean}>}
 */
export async function retitleRecords(svc, { dryRun = false, limit = 0 } = {}) {
  svc._ensureOpen();
  if (!Number.isInteger(limit) || limit < 0) {
    throw invalidArg(`retitle: limit must be a non-negative integer, got ${JSON.stringify(limit)}`);
  }

  const exported = await svc.exportRecords({ status: 'all', limit: 1000000 });
  const latest = new Map(); // id -> 完整记录（v 最大）
  for (const row of exported.records) {
    const full = svc._records?.get?.(row.id) ?? row;
    const prev = latest.get(row.id);
    if (!prev || (full.v ?? 1) > (prev.v ?? 1)) latest.set(row.id, full);
  }

  const total = latest.size;
  const planned = [];
  for (const rec of latest.values()) {
    if (hasTitle(rec)) continue; // 已有标题：不动
    if (String(rec.subject ?? '').trim() === '') continue; // 没素材，写空标题是无意义变更
    const title = deriveTitle(rec);
    if (title === '') continue;
    planned.push({ rec, title });
  }
  const targets = limit > 0 ? planned.slice(0, limit) : planned;
  const samples = targets.slice(0, 5).map(({ rec, title }) => ({ id: rec.id, subject: rec.subject, title }));
  const limited = exported.limited === true;

  if (dryRun) return { total, changed: targets.length, samples, dryRun: true, limited };

  const failed = [];
  const appliedSamples = [];
  let changed = 0;

  if (targets.length > 0) {
    await withLock(svc.memoHome, async () => {
      // 锁内增量重读：并发进程可能刚补过 title 或改过 subject（裁决 13 的写路径约定）
      await svc.refreshView();
      for (const { rec } of targets) {
        const current = svc._records.get(rec.id);
        if (!current) {
          failed.push({ id: rec.id, error: 'record disappeared before retitle' });
          continue;
        }
        if (hasTitle(current)) continue; // 已被别人补齐：不覆盖人工标题
        const title = deriveTitle(current);
        if (title === '') continue;
        const patched = withPatch(current, { title });
        const check = validateRecord(patched);
        if (!check.ok) {
          failed.push({ id: current.id, error: check.errors.join('; ') });
          continue;
        }
        try {
          await svc.store.appendImmediate(patched);
          await svc.store.appendEventImmediate({
            ts: nowIso(svc.clock),
            op: 'retitle',
            scope: svc.scope,
            id: patched.id,
            detail: { title },
          });
        } catch (e) {
          failed.push({ id: current.id, error: e.message });
          continue;
        }
        changed += 1;
        if (appliedSamples.length < 5) {
          appliedSamples.push({ id: patched.id, subject: patched.subject, title });
        }
      }
    });
    // 全量重载：title 补丁不改 contentHash/status/hits，增量 fold 的快照相等判定会跳过它
    await svc._reload();
  }

  return { total, changed, failed, samples: appliedSamples, limited };
}

/**
 * 用外部给的 `[{id, title}]` 批量写标题（Agent 产出用，比纯规则更像人话）。
 *
 * 为什么不复用 `retitleRecords`：那条路径的 title 由规则推导；这里 title 由调用方（通常是
 * 正在跑的 Agent）读完正文后自己写，规则只需要做「形状校验 + 落盘 + 幂等」。
 *
 * 校验（全部逐条、绝不整批失败）：
 *  - `id` 必须是库里存在的记录；`title` 非空串
 *  - `title` 走 `normalizeTitle`（折单行 → trim → ≤40 截断）；与现有 title 相同则跳过（幂等）
 *  - 落盘走 append-only 补丁行（v+1）+ `op:'retitle_apply'` 事件，原行不动
 * @param {object} svc createMemoryService 的实例
 * @param {Array<{id: string, title: string}>} list
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{planned:number, changed:number, skipped:number, failed:Array<{id:string,error:string}>}>}
 */
export async function applyTitles(svc, list, { dryRun = false } = {}) {
  svc._ensureOpen();
  if (!Array.isArray(list)) throw invalidArg('applyTitles: list must be an array of {id,title}');
  const failed = [];
  const plan = [];
  for (const row of list) {
    const id = row?.id;
    if (typeof id !== 'string' || id === '') {
      failed.push({ id: String(id ?? ''), error: 'id 必须是非空字符串' });
      continue;
    }
    if (typeof row?.title !== 'string') {
      failed.push({ id, error: 'title 必须是字符串' });
      continue;
    }
    const title = normalizeTitle(row.title);
    if (title === '') {
      failed.push({ id, error: 'title 归一化后为空' });
      continue;
    }
    plan.push({ id, title });
  }

  let changed = 0;
  let skipped = 0;
  if (plan.length > 0) {
    if (dryRun) {
      for (const p of plan) {
        const cur = svc._records.get(p.id);
        if (!cur) failed.push({ id: p.id, error: 'record not found' });
        else if (cur.title === p.title) skipped += 1;
        else changed += 1;
      }
      return { planned: plan.length, changed, skipped, failed, dryRun: true };
    }
    await withLock(svc.memoHome, async () => {
      await svc.refreshView();
      for (const p of plan) {
        const cur = svc._records.get(p.id);
        if (!cur) {
          failed.push({ id: p.id, error: 'record not found' });
          continue;
        }
        if (cur.title === p.title) {
          skipped += 1;
          continue;
        }
        const patched = withPatch(cur, { title: p.title });
        const check = validateRecord(patched);
        if (!check.ok) {
          failed.push({ id: p.id, error: check.errors.join('; ') });
          continue;
        }
        try {
          await svc.store.appendImmediate(patched);
          await svc.store.appendEventImmediate({
            ts: nowIso(svc.clock),
            op: 'retitle_apply',
            scope: svc.scope,
            id: patched.id,
            detail: { title: p.title },
          });
        } catch (e) {
          failed.push({ id: p.id, error: e.message });
          continue;
        }
        changed += 1;
      }
    });
    await svc._reload();
  }
  return { planned: plan.length, changed, skipped, failed };
}
