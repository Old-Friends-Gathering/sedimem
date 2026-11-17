// core/trust.js — 信任等级（trust）与污点集合（taint）的单一来源
// 契约：docs/02-data-model-and-contract.md §3.24（P0b B2）
//
// 为什么集中在这里：写路径、supersede、去重合并、存量派生、promote 都会碰到
// 「这条记录能信到什么程度」；条件散落各处时，任何一条新写路径都能把 T2 洗成 T0。
// 本模块只放纯函数，不读盘、不抛业务错误（校验错误由 record.js 统一转 E_INVALID_RECORD）。

/** 合法信任等级（T0 最高、T3 最低；T2 是缺省/未标注） */
export const TRUST_LEVELS = Object.freeze(['T0', 'T1', 'T2', 'T3']);

/** 缺省信任等级：没有 trust 字段的记录按 T2 读（不是 T0） */
export const DEFAULT_TRUST = 'T2';

/** 等级 → 强度（数字越小越可信；排序用，不写入真相层） */
const RANK = Object.freeze({ T0: 0, T1: 1, T2: 2, T3: 3 });

/**
 * 存量 backfill 的可信来源：这些 agent 写下的旧记录（无 adapter/sourceRefs/import 痕迹）
 * 在**读取时**派生为 T0。capture 记录例外——它们来自会话捕获，不是维护者手写。
 * 注意：这是读时派生规则，不是写路径授权；普通 write 仍然只能得到 T2。
 */
export const LEGACY_TRUSTED_AGENTS = Object.freeze(new Set(['cli', 'dsh', 'claude', 'codex', 'test']));

/** @param {unknown} value */
export function isTrustLevel(value) {
  return typeof value === 'string' && Object.hasOwn(RANK, value);
}

/** 等级强度；非法值按缺省 T2 处理（调用方应先校验） */
export function trustRank(value) {
  return isTrustLevel(value) ? RANK[value] : RANK[DEFAULT_TRUST];
}

/**
 * 取最弱（最不可信）的等级。taint/trust 都是「只能变保守」：合并、取代、晋升
 * 只能取两侧更弱的那一个，绝不允许把 T2 洗成 T0。
 * @param {...(string|undefined|null)} levels
 */
export function weakestTrust(...levels) {
  let out = null;
  for (const level of levels) {
    if (!isTrustLevel(level)) continue;
    if (out === null || trustRank(level) > trustRank(out)) out = level;
  }
  return out ?? DEFAULT_TRUST;
}

/**
 * taint 校验：缺省合法；出现时必须是非空字符串数组（元素去首尾空白后仍非空）。
 * @param {unknown} taint
 * @returns {string|null} 错误文本；合法返回 null
 */
export function taintError(taint) {
  if (taint === undefined) return null;
  if (!Array.isArray(taint)) return `taint: must be an array of non-empty strings, got ${typeof taint}`;
  for (const item of taint) {
    if (typeof item !== 'string' || item.trim() === '') {
      return `taint: every entry must be a non-empty string, got ${JSON.stringify(item)}`;
    }
  }
  return null;
}

/**
 * 归一 taint：去首尾空白、去重、排序（确定性输出，便于事件/测试逐字节比较）。
 * 空数组是合法值（表示「没有已知污点」）；非法输入先由 taintError 拦下。
 * @param {string[]|undefined} taint
 * @returns {string[]}
 */
export function normalizeTaint(taint) {
  if (!Array.isArray(taint)) return [];
  const out = new Set();
  for (const item of taint) {
    if (typeof item === 'string' && item.trim() !== '') out.add(item.trim());
  }
  return [...out].sort();
}

/**
 * 污点并集（单调不减的唯一实现）：supersede/merge/noop 吸收都走这里。
 * @param {...(string[]|undefined)} lists
 * @returns {string[]}
 */
export function unionTaint(...lists) {
  const out = new Set();
  for (const list of lists) {
    for (const item of normalizeTaint(list)) out.add(item);
  }
  return [...out].sort();
}

/**
 * 两条 taint 是否等价（归一后比较；用于「noop 路径是否需要追加 v+1 快照」）。
 * @param {string[]|undefined} a
 * @param {string[]|undefined} b
 */
export function sameTaint(a, b) {
  const na = normalizeTaint(a);
  const nb = normalizeTaint(b);
  return na.length === nb.length && na.every((item, i) => item === nb[i]);
}

/**
 * 派生信任等级。**所有** trust 缺省规则都必须走这里。
 *
 * mode='write'：普通写路径（memory_write / CLI / capture accept）一律 T2；
 *   调用方即使自报 T0/T1 也不得提升——真实等级只能由人工 `memo trust promote` 改。
 * mode='read'（缺省）：存量记录没有 trust 字段时按 backfill 规则派生：
 *   source.agent ∈ LEGACY_TRUSTED_AGENTS 且 tags 不含 'capture' → T0，否则 T2。
 *   这是读时视图，不修改真相层（ADR 说明见 docs/02 §3.24）。
 *
 * @param {{source?: {agent?: string}, tags?: string[]}} recordLike
 * @param {{mode?: 'read'|'write'}} [opts]
 * @returns {'T0'|'T1'|'T2'|'T3'}
 */
export function deriveTrust(recordLike, { mode = 'read' } = {}) {
  if (mode === 'write') return DEFAULT_TRUST;
  const agent = recordLike?.source?.agent;
  const tags = Array.isArray(recordLike?.tags) ? recordLike.tags : [];
  if (typeof agent === 'string' && LEGACY_TRUSTED_AGENTS.has(agent) && !tags.includes('capture')) {
    return 'T0';
  }
  return DEFAULT_TRUST;
}

/**
 * 读取视图里的有效 trust：显式字段优先，缺失才派生。
 * @param {{trust?: string, source?: object, tags?: string[]}} record
 */
export function effectiveTrust(record) {
  return isTrustLevel(record?.trust) ? record.trust : deriveTrust(record);
}

/** 读取视图里的有效 taint（归一、去重、排序；缺省空数组） */
export function effectiveTaint(record) {
  return normalizeTaint(record?.taint);
}
