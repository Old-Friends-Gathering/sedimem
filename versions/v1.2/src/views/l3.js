// views/l3.js — L3 画像层（issue #52，施工图 §3 B 路；调研 docs/research/layered-memory-2026.md）
// 为什么是纯函数 + 预算硬上限：
// - Memobase 把 profile 巩固压到「固定调用次数」——给 L2→L3 一个成本上界（N 进 policy），
//   不是「有多少候选调用多少次」；超了排队到下次（skipped 计数）。
// - Letta 的 memory blocks 可 diff / 回滚：前提是画像可溯源——每条 L3 必须带 sourceRefs
//   指回 record id，概括可重算、可删除、可重建（D2：视图是派生物不是真相）。
// - Graphiti 强制溯源：无出处的断言（「他/她/用户是…」）一律在 validateL3Draft 拒绝。
// 本模块零 IO、零 LLM、不碰系统时钟（now 由调用方注入）——driving（真正调 judge/LLM、
// 逐条写库）由 Lead 的 CLI 做，这样测试能用假 judge 精确断言调用次数。
// 注意（真相层不变式）：status 'active' 的记录必须 validTo=null（core/record.js
// validateRecord），所以 L3 的 TTL 用 expiredAt 表达（与 hygiene/decay.js 的 state 类
// 同款语义），validTo 留给 superseded 生命周期。

/** ULID 形状（与 core/ids.js 同源判定，不重抄字符表） */
import { isId } from '../core/ids.js';
// 与 buildL2 用同一个归一化，避免「视图在 / 视图缺」两种分组结果不一致
import { normalizeText } from '../core/hash.js';

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_CALLS = 20;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const MAX_TEXT = 2000;

/**
 * 「无出处断言词」规则表（Graphiti 式强制溯源）：L3 概括里出现这些模式却没有
 * sourceRefs 支撑时直接拒绝。表可解释、可扩展——每条 = 一个正则 + 一个 code + 一句人话。
 */
export const UNSOURCED_ASSERTION_RULES = [
  {
    code: 'E_L3_UNSOURCED_PRONOUN',
    pattern: /(他|她)(就是|是|喜欢|讨厌|想要|认为|总是|从不)/,
    message: '第三人称代词断言（"他/她是…"）无法从 sourceRefs 还原出处',
  },
  {
    code: 'E_L3_UNSOURCED_USER_CLAIM',
    pattern: /用户(就是|是|喜欢|讨厌|想要|认为|总是|从不)/,
    message: '「用户是/喜欢…」类人格断言必须有逐条 record 证据，否则拒绝',
  },
  {
    code: 'E_L3_UNSOURCED_ALWAYS',
    pattern: /(他|她|用户|这个人).{0,6}(总是|从不|永远)/,
    message: '全称量词断言（总是/从不/永远）是画像最易失真的句式，无出处不收',
  },
];

/** kind 权重：单一来源 policy.kinds[kind].weight，缺 kind 记 0（不进优先级，但仍可成块） */
function kindWeightOf(policy, kind) {
  const w = policy?.kinds?.[kind]?.weight;
  return typeof w === 'number' ? w : 0;
}

/** 该 record 当前是否有效可见（active 且未过期）——只看字段，不查时钟 */
function isLive(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.status !== 'active') return false;
  if (r.validTo !== null && r.validTo !== undefined) return false;
  if (r.expiredAt) return false;
  return true;
}

/** L3 覆盖集：所有未过期的 L3 记录（tags 含 'L3'）的 sourceRefs 并集 */
function coveredIds(records) {
  const covered = new Set();
  for (const r of records) {
    if (!isLive(r)) continue;
    if (!Array.isArray(r.tags) || !r.tags.includes('L3')) continue;
    if (!Array.isArray(r.sourceRefs)) continue;
    for (const id of r.sourceRefs) covered.add(String(id));
  }
  return covered;
}

/**
 * 规划一轮 L3 画像（纯函数：不读盘、不写盘、不调 LLM、不修改入参）。
 * 候选来源 = active 未过期、未被既有 L3 覆盖的记录；分组键优先取 L2 块
 * （blocks 提供 recordIds→key 映射），无块信息的回落到 slot 键（subject␟predicate）。
 * 排序 = 组内最大 kind 权重降序（decision/gotcha/pref 天然排在 fact 前，权重来自
 * policy.kinds），同分按组大小降序、再按 key 升序保证确定序。
 * 预算硬上限：candidates ≤ min(policy.l3.batchSize ?? 10, policy.l3.maxCallsPerRun ?? 20)，
 * 每个候选预计 1 次 LLM 调用（Memobase 式固定上界）；超出的组截断并计入 skipped。
 * @param {object[]} records 真相层记录
 * @param {{blocks?: {key: string, recordIds: string[]}[]}|null} blocks L2 块信息（可空）
 * @param {{policy?: object, now?: object}} opts now 未用但保留签名（纯函数不查时钟）
 * @returns {{candidates: {key: string, recordIds: string[], kinds: string[], text: string}[], callsEstimate: number, skipped: number}}
 */
export function planL3(records, blocks, { policy, now } = {}) {
  if (!Array.isArray(records)) {
    const err = new Error('planL3: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const batchSize = Number.isInteger(policy?.l3?.batchSize) && policy.l3.batchSize > 0
    ? policy.l3.batchSize : DEFAULT_BATCH_SIZE;
  const maxCalls = Number.isInteger(policy?.l3?.maxCallsPerRun) && policy.l3.maxCallsPerRun > 0
    ? policy.l3.maxCallsPerRun : DEFAULT_MAX_CALLS;

  // L2 块归属：recordId → block.key（只读 blocks，不改）
  const blockKeyOf = new Map();
  if (Array.isArray(blocks?.blocks)) blocks = blocks.blocks; // 容错：直接传 buildL2 结果也行
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (!b || !Array.isArray(b.recordIds)) continue;
      for (const id of b.recordIds) {
        if (!blockKeyOf.has(String(id))) blockKeyOf.set(String(id), String(b.key ?? b.blockId ?? ''));
      }
    }
  }

  const covered = coveredIds(records);
  let skipped = 0;

  // 分组：组键 = L2 块 key（有块）或 slot 键（无块）；已被覆盖的记录跳过并计数
  const groups = new Map(); // key → {recordIds: string[], kinds: Set, weight: number, texts: string[]}
  for (const r of records) {
    if (!isLive(r)) continue;
    const id = String(r.id ?? '');
    if (id === '') continue;
    if (covered.has(id)) { skipped++; continue; }
    const kind = String(r.kind ?? 'fact');
    // 回落键必须与 buildL2 同形（normalizeText + \u0001），否则「有视图」与「无视图」分组结果
    // 会因大小写/空白差异而漂移（架构审核建议 2）
    const key = blockKeyOf.get(id) ?? `slot:${normalizeText(String(r.subject ?? 'text'))}\u0001${normalizeText(String(r.predicate ?? 'text'))}`;
    if (!groups.has(key)) groups.set(key, { recordIds: [], kinds: new Set(), weight: 0, texts: [] });
    const g = groups.get(key);
    g.recordIds.push(id);
    g.kinds.add(kind);
    const w = kindWeightOf(policy, kind);
    if (w > g.weight) g.weight = w;
    if (g.texts.length < 3 && typeof r.text === 'string' && r.text !== '') g.texts.push(r.text);
  }

  // 确定序：权重降序 → 组大小降序 → key 升序
  const ordered = [...groups.entries()].sort((a, b) => {
    if (b[1].weight !== a[1].weight) return b[1].weight - a[1].weight;
    if (b[1].recordIds.length !== a[1].recordIds.length) return b[1].recordIds.length - a[1].recordIds.length;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  // 预算硬上限：批次 ≤ batchSize 且预计调用 ≤ maxCalls，超出截断进 skipped
  const limit = Math.min(batchSize, maxCalls);
  const kept = ordered.slice(0, limit);
  skipped += ordered.length - kept.length;

  const candidates = kept.map(([key, g]) => ({
    key,
    recordIds: [...g.recordIds],
    kinds: [...g.kinds].sort(),
    // text 只是给 judge 的原料摘要（≤2000，与 validateL3Draft 同一上限），不是最终概括
    text: g.texts.join('\n').slice(0, MAX_TEXT),
  }));

  return { candidates, callsEstimate: candidates.length, skipped };
}

/**
 * 校验 L3 草稿（judge/LLM 产出后的硬门）。规则全部 fail-loud，返回可解释 code。
 * @param {object} draft {text, sourceRefs, confidence}
 * @returns {{ok: true}|{ok: false, code: string, message: string}}
 */
export function validateL3Draft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, code: 'E_L3_DRAFT_SHAPE', message: 'validateL3Draft: draft must be an object' };
  }
  const refs = draft.sourceRefs;
  if (!Array.isArray(refs) || refs.length === 0) {
    return { ok: false, code: 'E_L3_SOURCEREFS_EMPTY', message: 'sourceRefs 必须是非空字符串数组（无出处不成 L3）' };
  }
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref === '') {
      return { ok: false, code: 'E_L3_SOURCEREFS_SHAPE', message: `sourceRefs 含非字符串项: ${JSON.stringify(ref)}` };
    }
    if (!isId(ref)) {
      return { ok: false, code: 'E_L3_SOURCEREFS_NOT_ULID', message: `sourceRefs 含非 ULID（26 位 Crockford base32）项: ${JSON.stringify(ref)}` };
    }
  }
  const text = draft.text;
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, code: 'E_L3_TEXT_EMPTY', message: 'text 必须非空' };
  }
  if (text.length > MAX_TEXT) {
    return { ok: false, code: 'E_L3_TEXT_TOO_LONG', message: `text 长度 ${text.length} 超过 ${MAX_TEXT}` };
  }
  const c = draft.confidence;
  if (typeof c !== 'number' || !(c > 0 && c <= 1)) {
    return { ok: false, code: 'E_L3_CONFIDENCE_RANGE', message: `confidence 必须在 (0,1]，got ${JSON.stringify(c)}` };
  }
  // 无出处断言词（规则表见 UNSOURCED_ASSERTION_RULES，可解释可扩展）
  for (const rule of UNSOURCED_ASSERTION_RULES) {
    if (rule.pattern.test(text)) {
      return { ok: false, code: rule.code, message: `${rule.message}（命中规则 ${rule.code}）` };
    }
  }
  return { ok: true };
}

/** now（Date|number|ISO string）→ 毫秒；拒绝缺失（纯函数不碰系统时钟） */
function toNowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string') {
    const t = Date.parse(now);
    if (Number.isFinite(t)) return t;
  }
  const err = new Error('buildL3Record: now (Date|number|ISO string) is required');
  err.code = 'E_INVALID_ARG';
  throw err;
}

/**
 * 把校验通过的草稿变成可直接交给 service.write 的输入对象（纯函数）。
 * - kind：draft.kind ?? 'pref'（画像缺省是偏好/倾向类）
 * - tags：追加 'L3'（planL3 靠它识别覆盖）
 * - TTL：expiredAt = now + policy.l3.ttlMs（默认 30 天）。注意不用 validTo——
 *   真相层不变式要求 active 记录 validTo=null（见文件头注释）。
 * - sourceRefs 原样带上（数组拷贝，防外层事后改动污染）。
 * @param {object} draft
 * @param {{now: Date|number|string, policy?: object}} opts
 * @returns {object} service.write 输入
 */
export function buildL3Record(draft, { now, policy } = {}) {
  if (!draft || typeof draft !== 'object') {
    const err = new Error('buildL3Record: draft must be an object');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const nowMs = toNowMs(now);
  const ttlMs = Number.isFinite(policy?.l3?.ttlMs) && policy.l3.ttlMs > 0
    ? policy.l3.ttlMs : DEFAULT_TTL_MS;
  const tags = Array.isArray(draft.tags) ? [...draft.tags] : [];
  if (!tags.includes('L3')) tags.push('L3');
  return {
    kind: draft.kind ?? 'pref',
    subject: draft.subject ?? 'profile',
    predicate: draft.predicate ?? 'l3-summary',
    text: String(draft.text ?? ''),
    value: draft.value ?? draft.text,
    confidence: draft.confidence,
    tags,
    expiredAt: new Date(nowMs + ttlMs).toISOString(),
    sourceRefs: Array.isArray(draft.sourceRefs) ? [...draft.sourceRefs] : [],
    source: draft.source ?? { agent: 'l3' },
  };
}

/**
 * L3 溯源 + 漂移检测（纯函数）：sourceRefs 里哪些 record 已不在真相层（missing）、
 * 哪些还在但已 superseded/tombstoned（stale，Letta 式「画像可回滚」的前提是能发现失效）。
 * @param {object} l3Record buildL3Record 产物（或任何带 sourceRefs 的对象）
 * @param {object[]} records 当前真相层记录
 * @returns {{sourceRefs: string[], missing: string[], stale: {id: string, status: string}[]}}
 */
export function traceL3(l3Record, records) {
  if (!Array.isArray(records)) {
    const err = new Error('traceL3: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const refs = Array.isArray(l3Record?.sourceRefs)
    ? l3Record.sourceRefs.map(String)
    : [];
  const byId = new Map();
  for (const r of records) {
    if (r && typeof r === 'object' && r.id != null) byId.set(String(r.id), r);
  }
  const missing = [];
  const stale = [];
  for (const id of refs) {
    const r = byId.get(id);
    if (!r) { missing.push(id); continue; }
    if (r.status === 'superseded' || r.status === 'tombstoned') {
      stale.push({ id, status: String(r.status) });
    }
  }
  return { sourceRefs: refs, missing, stale };
}
