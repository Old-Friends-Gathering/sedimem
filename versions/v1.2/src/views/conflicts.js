// views/conflicts.js — 分歧视图（施工图 D4：把冲突做成一等公民只读视图 + 一键修复）
// 原则：只加派生能力，不动真相层语义。listConflicts 只读；resolveConflicts
// 复用 service.curateApply 的 ids 形状 a_wins 语义（败者 superseded + tag 'merged'，
// append-only 非破坏、幂等），本文件不自己写盘。

import { dedupeSlotKey, isUnstructured, textSimilarity } from '../hygiene/conflict.js';
import { withLock } from '../storage/lock.js';

/** 分歧视图最多返回的 slot 组数（与 dedupeScan 的默认 limit 对齐） */
const MAX_SLOTS = 50;
/** limit 硬上限（防止调用方用 ?limit=100000 把服务打死） */
const MAX_SLOTS_MAX = 200;
/** 单 slot 返回的候选对上限（pairs 是 O(n²)，见审核 S-8） */
const PAIR_CAP = 200;
/** exportRecords 的取数上限：视图要全量分组，不能被默认 2000 截断后「在子集里找冲突」 */
const EXPORT_LIMIT = 1000000;

/** 错误工厂：E_INVALID_ARG（本模块自持，不 import service.js 避免循环依赖） */
function invalidArg(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_ARG';
  return err;
}

/** 数值统一保留 6 位小数（与 dedupeScan 的 round 口径一致，便于对照） */
function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * 取全量记录（含 disputed/superseded）——只走 service 公开方法 exportRecords，
 * 不读私有字段（service._records 等）。
 * @param {object} service MemoryService
 * @returns {Promise<object[]>}
 */
async function allRecords(service) {
  const { records } = await service.exportRecords({ status: 'all', limit: EXPORT_LIMIT });
  return records;
}

/**
 * 分歧列表（D4）：按 dedupeSlotKey 分组，只收 status ∈ {active, disputed} 的记录，
 * 组内 ≥2 条才算一个分歧 slot。按组内 disputed 记录数降序（同数按 key 升序），最多 50 组。
 * 只读：不写 events、不改记录。
 * @param {{service: object}} args
 * @returns {Promise<{slots: {key: string,
 *    records: {id: string, text: string, subject: string, predicate: string,
 *              status: string, validFrom: string|null, createdAt: string, hits: number}[],
 *    pairs: {aId: string, bId: string, similarity: number}[],
 *    disputedCount: number}[],
 *    disputedCount: number, supersededCount: number, scanned: number}>}
 */
export async function listConflicts({ service, limit } = {}) {
  if (!service || typeof service.exportRecords !== 'function') {
    throw invalidArg('listConflicts: service (MemoryService) is required');
  }
  const records = await allRecords(service);

  let disputedCount = 0;
  let supersededCount = 0;
  const groups = new Map(); // dedupeSlotKey -> 参与判定的记录（active+disputed）
  for (const r of records) {
    if (r.status === 'disputed') disputedCount++;
    else if (r.status === 'superseded') supersededCount++;
    if (r.status !== 'active' && r.status !== 'disputed') continue;
    // 对抗审核 B3：无结构记录（subject/predicate 都是默认 text）**不是**同一个 slot。
    // 它们共用 dedupeSlotKey 的超组只是为了让「近似重复扫描」能两两比较；
    // 但「同 slot 不同值 = 分歧」这条语义对自由文本不成立——三条无关自由文本
    // 曾因此同组，一次 resolve 把另外两条全部 superseded。
    // 自由文本的分歧只能来自 dedupeScan 的近似重复候选（Agent 裁决路径）。
    if (isUnstructured(r)) continue;
    const key = dedupeSlotKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_SLOTS_MAX) : MAX_SLOTS;
  const slots = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue; // 单条记录的 slot 不构成分歧
    const sorted = [...members].sort((a, b) => (
      String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id))
    ));
    // 组内逐对相似度：给 Agent/人看「哪两条像」，与 dedupeScan 的 containment 同源实现
    const pairs = [];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        pairs.push({
          aId: sorted[i].id,
          bId: sorted[j].id,
          similarity: round6(textSimilarity(sorted[i].text, sorted[j].text)),
        });
      }
    }
    pairs.sort((a, b) => (b.similarity - a.similarity)
      || (a.aId < b.aId ? -1 : a.aId > b.aId ? 1 : 0));
    // 对抗审核 S-8：同 slot 很多条时 pairs 是 O(n²)，1000 条就是 50 万对。
    // 只回最像的 200 对（人/Agent 逐对裁决也用不到更多），并标出被截断。
    const pairTotal = pairs.length;
    const pairsKept = pairs.slice(0, PAIR_CAP);
    slots.push({
      key,
      records: sorted.map((r) => ({
        id: r.id,
        text: r.text,
        subject: r.subject,
        predicate: r.predicate,
        status: r.status,
        validFrom: r.validFrom ?? null,
        createdAt: String(r.createdAt),
        hits: r.hits ?? 0,
      })),
      pairs: pairsKept,
      pairTotal,
      pairsTruncated: pairTotal > pairsKept.length,
      disputedCount: sorted.filter((r) => r.status === 'disputed').length,
    });
  }

  slots.sort((a, b) => (b.disputedCount - a.disputedCount) || (a.key < b.key ? -1 : 1));
  return {
    // 对抗审核 S-11：pairs 是 O(n²) 结构（1000 条同 slot 实测 43MB）。
    // 用 limit 卡住返回的 slot 数，并显式告诉调用方被截断了（不静默少给）。
    slots: slots.slice(0, cap),
    truncated: slots.length > cap,
    totalSlots: slots.length,
    disputedCount,
    supersededCount,
    scanned: records.length,
  };
}

/**
 * 修复一个分歧 slot（D4）：同 slot 的其它 active/disputed 记录逐个落败。
 * 落盘走 service.curateApply({decisions:[{ids:[winnerId, loserId], decision:'a_wins'}]})：
 * a_wins 语义 = 败者 superseded(validTo=now)+tag 'merged'、胜者 active——append-only
 * 非破坏（真相层行数只增不减）、自带幂等（重复 apply 返回 applied:false）。
 * @param {{service: object, slot: string, winnerId: string, note?: string}} args
 * @returns {Promise<{resolved: {id: string}[], skipped: {id: string, reason: string}[]}>}
 */
export async function resolveConflicts({ service, slot, winnerId, note } = {}) {
  if (!service || typeof service.exportRecords !== 'function'
    || typeof service.curateApply !== 'function') {
    throw invalidArg('resolveConflicts: service (MemoryService) is required');
  }
  if (typeof slot !== 'string' || slot.length === 0) {
    throw invalidArg(`resolveConflicts: slot (non-empty string) is required, got ${JSON.stringify(slot)}`);
  }
  if (typeof winnerId !== 'string' || winnerId.length === 0) {
    throw invalidArg(`resolveConflicts: winnerId (non-empty string) is required, got ${JSON.stringify(winnerId)}`);
  }

  const records = await allRecords(service);
  const winner = records.find((r) => r.id === winnerId);
  if (!winner) {
    throw invalidArg(`resolveConflicts: winner ${winnerId} not found`);
  }
  if (isUnstructured(winner)) {
    throw invalidArg('resolveConflicts: 无结构记录（subject/predicate 都是 text）不构成 slot 分歧，'
      + '请用 dedupeScan + curateApply 处理近似重复');
  }
  if (dedupeSlotKey(winner) !== slot) {
    throw invalidArg(`resolveConflicts: winner ${winnerId} is not in slot ${JSON.stringify(slot)}`);
  }
  if (winner.status !== 'active') {
    throw invalidArg(`resolveConflicts: winner ${winnerId} is not active (status=${winner.status})`);
  }

  // 对抗审核 S-5：两个进程同时 resolve 同一 slot 时，两边都读到「败者仍 active」，
  // 于是各自 apply 一次 → curate_apply 事件翻倍（实测 4 次）。修法是把整段放进 scope 锁，
  // 并在锁内重读（否则锁只保护写、不保护判定所依赖的快照）。
  const resolved = [];
  const skipped = [];
  await withLock(service.memoHome, async () => {
    service._inScopeLock = true;
    try {
      const fresh = await allRecords(service);
      const freshLosers = fresh.filter((r) => r.id !== winnerId
        && (r.status === 'active' || r.status === 'disputed')
        && !isUnstructured(r)
        && dedupeSlotKey(r) === slot);
      for (const loser of freshLosers) {
        const out = await service.curateApply({
          decisions: [{ ids: [winnerId, loser.id], decision: 'a_wins', note }],
        });
        const one = out.applied[0];
        if (one && one.applied) {
          resolved.push({ id: loser.id });
        } else {
          // service 侧幂等命中（败者已 superseded 且带 merged tag）或并发已处理
          skipped.push({ id: loser.id, reason: 'idempotent (already applied)' });
        }
      }
    } finally {
      service._inScopeLock = false;
    }
  });
  return { resolved, skipped };
}
