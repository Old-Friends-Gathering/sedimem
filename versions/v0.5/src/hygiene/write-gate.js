// hygiene/write-gate.js — 写路径判定的唯一策略点（契约见 docs/02-data-model-and-contract.md §3）
// 只吃 record + candidates[]，不 import storage。fail-loud：异常均带 err.code。

import { readFileSync } from 'node:fs';
import { normalizeText } from '../core/hash.js';
import { decideConflict, sameSlot, textSimilarity } from './conflict.js';

/** 测试与下游直接从 write-gate 取用（定义见 conflict.js） */
export { textSimilarity };

/**
 * 策略单一来源（裁决 20）：优先 src/config/policy.js 的 loadPolicy()；
 * 该模块尚不存在时回退到直接读 config/policy.json（裁决 5 的 URL 定位）。
 * 均允许调用方通过 ctx 覆盖。
 */
async function loadPolicySafe() {
  try {
    const m = await import('../config/policy.js');
    if (typeof m.loadPolicy === 'function') return m.loadPolicy();
  } catch { /* 模块缺失 → 回退 */ }
  const url = new URL('../../config/policy.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const POLICY = await loadPolicySafe();

/** 近重复阈值：ctx 覆盖 > policy.dedupe.nearDupThreshold > 0.85（裁决 14，不写死） */
function nearDupThresholdOf(ctx) {
  const fromCtx = ctx?.policy?.dedupe?.nearDupThreshold ?? ctx?.nearDupThreshold;
  if (typeof fromCtx === 'number' && Number.isFinite(fromCtx)) return fromCtx;
  const fromPolicy = POLICY?.dedupe?.nearDupThreshold;
  if (typeof fromPolicy === 'number' && Number.isFinite(fromPolicy)) return fromPolicy;
  return 0.85;
}

/** unstructured：subject/predicate 未显式给出时的默认 slot 'text'/'text'（裁决 14） */
function isUnstructured(r) {
  return (
    normalizeText(String(r?.subject ?? '')) === 'text' &&
    normalizeText(String(r?.predicate ?? '')) === 'text'
  );
}

/**
 * 判定一条待写记录相对同 scope 既有候选的动作。
 *
 * @param {import('../core/record.js').MemoryRecord} record 待写记录（已含 contentHash）
 * @param {import('../core/record.js').MemoryRecord[]} candidates 同 scope、status 允许参与判定的记录
 * @param {{clock: import('../core/clock.js').systemClock}} ctx
 * @returns {{action:'created'|'noop_duplicate'|'noop_same_value'|'supersede'|'disputed',
 *            record: import('../core/record.js').MemoryRecord,
 *            superseded?: import('../core/record.js').MemoryRecord,
 *            reason: string, duplicateOf?: string, similarity?: number}}
 */
export function decideWrite(record, candidates, ctx = {}) {
  if (!record || typeof record !== 'object') {
    const err = new Error('decideWrite: record is required');
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  if (!Array.isArray(candidates)) {
    const err = new Error('decideWrite: candidates must be an array');
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  if (!ctx || typeof ctx.clock?.now !== 'function') {
    const err = new Error('decideWrite: ctx.clock is required');
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  if (!record.contentHash || !record.contentHash.startsWith('sha256:')) {
    const err = new Error(`decideWrite: bad contentHash on record ${record.id}`);
    err.code = 'E_INVALID_RECORD';
    throw err;
  }

  const inScope = candidates.filter((c) => c && c.scope === record.scope);

  // 1) contentHash 命中同 scope 的 active 或 disputed → noop_duplicate
  const dup = inScope
    .filter((c) => c.contentHash === record.contentHash && (c.status === 'active' || c.status === 'disputed'))
    .sort(byRecencyDesc)[0];
  if (dup) {
    return {
      action: 'noop_duplicate',
      record: dup,
      reason: `contentHash ${record.contentHash} already exists as ${dup.id} (status=${dup.status})`,
    };
  }

  // 2) 同 slot（scope+subject+predicate 归一化相等）检查
  const slotPeers = inScope
    .filter((c) => c.status === 'active' || c.status === 'disputed')
    .filter((c) => sameSlot(c, record))
    .sort(byRecencyDesc);

  // 2a) 同 slot 且归一化值相等 → noop_same_value
  const sameValue = slotPeers.find(
    (c) => normalizeText(String(c.value ?? '')) === normalizeText(String(record.value ?? '')),
  );
  if (sameValue) {
    return {
      action: 'noop_same_value',
      record: sameValue,
      reason: `same slot (${record.subject}/${record.predicate}) already holds an equal normalized value in ${sameValue.id}`,
    };
  }

  // 2b) 近重复判定（裁决 14/15）：同 slot、或新记录为 unstructured 时，
  //     与候选的文本相似度 ≥ policy.dedupe.nearDupThreshold → noop_same_value，
  //     reason='near_duplicate'，附 duplicateOf/similarity（service 据此给原记录打 tag 'variant'）。
  //     必须在 conflict 判定之前，避免「同事实换措辞」沦为 disputed 垃圾。
  //     例外（裁决 15 的目的）：结构化 slot 且值可比、新值更晚 → supersede 优先，
  //     近重复防线针对的是 disputed 垃圾，不否决合法的状态推进。
  const threshold = nearDupThresholdOf(ctx);
  const nearPool = isUnstructured(record)
    ? inScope
        .filter((c) => c.status === 'active' || c.status === 'disputed')
        .filter((c) => sameSlot(c, record) || isUnstructured(c))
    : slotPeers;
  let best = null;
  let bestSim = 0;
  for (const c of nearPool) {
    const sim = textSimilarity(record.text, c.text);
    if (sim > bestSim) { bestSim = sim; best = c; }
  }
  const nearDupHit = !!(best && bestSim >= threshold);
  const nearDupResult = () => ({
    action: 'noop_same_value',
    record: best,
    reason: `near_duplicate: similarity ${bestSim.toFixed(4)} >= threshold ${threshold} with ${best.id} (${best.subject}/${best.predicate})`,
    duplicateOf: best.id,
    similarity: bestSim,
  });

  // 2c) unstructured（slot 'text'/'text'）不携带可比语义，异值冲突判定无意义：
  //     近重复命中 → noop；未命中 → 直接 created（裁决 14 的前提正是 unstructured slot
  //     不做冲突裁决，否则任何自由文本写入都会沦为 disputed 垃圾）。
  if (isUnstructured(record)) {
    if (nearDupHit) return nearDupResult();
    return {
      action: 'created',
      record,
      reason: `unstructured record ${record.id} below near-duplicate threshold (${bestSim.toFixed(4)} < ${threshold}); no slot-conflict semantics for text/text`,
    };
  }

  // 2d) 结构化同 slot 异值 → 冲突裁决（可比且更新 → supersede；否则 disputed，绝不静默覆盖）
  const peer = slotPeers[0];
  if (peer) {
    const verdict = decideConflict(record, peer, ctx);
    if (verdict.action === 'supersede') {
      return {
        action: 'supersede',
        record,
        superseded: peer,
        reason: `${verdict.reason}; new record ${record.id} supersedes ${peer.id}`,
      };
    }
    // dispute 或不确定时，若近重复命中 → 吸收为 variant，而非 disputed
    if (nearDupHit) return nearDupResult();
    // 真冲突 → disputed（返回副本并标记状态，由调用方落盘）
    return {
      action: 'disputed',
      record: { ...record, status: 'disputed' },
      reason: `${verdict.reason}; new record ${record.id} disputes ${peer.id}`,
    };
  }

  // 3) 无命中 → created
  return {
    action: 'created',
    record,
    reason: `no duplicate contentHash and no same-slot peer for ${record.id}`,
  };
}

/** createdAt 降序（同刻用 id 打破平局，保证确定性） */
function byRecencyDesc(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}
