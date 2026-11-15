// llm/outbox.js — 派生 outbox 队列（契约：docs/plans/v1.0.0-refactor.md §2.x）
//
// 路径：$MEMO_HOME/derive-queue/<scopeKey>.jsonl，append-only 状态流。
// 每行 {op: 'enqueue'|'claim'|'done'|'dead', id, validFrom, ts, ...}；
// 条目状态 = 该 (id, validFrom) 的**最后一个 op** 决定：
//   enqueue → pending；claim → claimed（attempts = claim 行数）；done → 完成；dead → 死信。
// claimBatch 在 withLock 锁内完成「读状态 → 选条目 → 写 claim」，多进程并发不会重复领取；
// attempts 达到 3 写 dead 行并跳过。坏行（半行 JSON）跳过不阻塞。

import path from 'node:path';
import fsp from 'node:fs/promises';
import { scopeKeyOf } from '../config/paths.js';
// Q15：llm 层不得 import storage/**，锁用本层 llm/lock.js 的 withPathLock
import { withPathLock } from './lock.js';

/** attempts 上限：第 3 次 claim 前判死（契约） */
export const MAX_ATTEMPTS = 3;

function queueFilePath(memoHome, scope) {
  return path.join(memoHome, 'derive-queue', `${scopeKeyOf(scope)}.jsonl`);
}

/** 逐行解析；坏行跳过 */
function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && typeof obj.op === 'string') out.push(obj);
    } catch { /* 坏行：跳过 */ }
  }
  return out;
}

async function readOps(filePath) {
  try {
    return parseLines(await fsp.readFile(filePath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return [];
  }
}

async function appendOp(filePath, op) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(op)}\n`, 'utf8');
}

/**
 * 从 op 流重建每个 (id, validFrom) 的状态。
 * @returns {Map<string, {id, validFrom, state, attempts, payload}>}
 *   state ∈ pending | claimed | done | dead
 */
function buildState(ops) {
  const map = new Map();
  for (const op of ops) {
    if (typeof op.id !== 'string' || typeof op.validFrom !== 'string') continue;
    const key = `${op.id}@${op.validFrom}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { id: op.id, validFrom: op.validFrom, state: 'pending', attempts: 0, payload: {} };
      map.set(key, entry);
    }
    if (op.op === 'enqueue') {
      entry.state = 'pending';
      // 队列负载（给 claimBatch 回传用）：record 快照等
      if (op.record && typeof op.record === 'object') entry.payload = op.record;
    } else if (op.op === 'claim') {
      entry.state = 'claimed';
      entry.attempts += 1;
    } else if (op.op === 'done') {
      entry.state = 'done';
    } else if (op.op === 'dead') {
      entry.state = 'dead';
    }
  }
  return map;
}

/**
 * 入队一条派生任务。已 done 的条目再入队返回 {enqueued:false}（幂等，不重复派生）。
 * @param {{memoHome, scope, id, validFrom, record?, clock?}} opts
 * @returns {Promise<{enqueued: boolean}>}
 */
export async function enqueueDerive({ memoHome, scope, id, validFrom, record, clock } = {}) {
  if (!memoHome || typeof memoHome !== 'string' || typeof id !== 'string' || typeof validFrom !== 'string') {
    const err = new Error('enqueueDerive: memoHome/id/validFrom 均为必填字符串');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const now = clock?.now ?? (() => new Date().toISOString());
  return withPathLock(path.join(memoHome, "derive-queue"), `${scopeKeyOf(scope)}.lock`, async () => {
    const filePath = queueFilePath(memoHome, scope);
    const state = buildState(await readOps(filePath));
    const entry = state.get(`${id}@${validFrom}`);
    if (entry && entry.state === 'done') return { enqueued: false };
    await appendOp(filePath, {
      op: 'enqueue', id, validFrom, ts: now(),
      ...(record && typeof record === 'object' ? { record } : {}),
    });
    return { enqueued: true };
  });
}

/**
 * 锁内批量领取可处理条目并写 claim 行。
 * 可处理 = 当前 pending；领取前 attempts 已达 MAX_ATTEMPTS 的写 dead 行并跳过。
 * @param {{memoHome, scope, limit?, clock?}} opts
 * @returns {Promise<{items: {id, validFrom, attempts, record?}[]}>}
 */
export async function claimBatch({ memoHome, scope, limit = 10, clock } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error(`claimBatch: memoHome required, got ${JSON.stringify(memoHome)}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const now = clock?.now ?? (() => new Date().toISOString());
  return withPathLock(path.join(memoHome, "derive-queue"), `${scopeKeyOf(scope)}.lock`, async () => {
    const filePath = queueFilePath(memoHome, scope);
    const state = buildState(await readOps(filePath));
    const items = [];
    for (const entry of state.values()) {
      if (items.length >= limit) break;
      if (entry.state !== 'pending') continue;
      // 进入本轮前已经 claim 满 3 次仍未 done：判死（此后 pending 不可能，防御性兜底）
      if (entry.attempts >= MAX_ATTEMPTS) {
        await appendOp(filePath, { op: 'dead', id: entry.id, validFrom: entry.validFrom, ts: now(), reason: 'max-attempts' });
        continue;
      }
      await appendOp(filePath, { op: 'claim', id: entry.id, validFrom: entry.validFrom, ts: now() });
      items.push({
        id: entry.id,
        validFrom: entry.validFrom,
        attempts: entry.attempts + 1, // 本条 claim 行计入后的尝试次数
        ...(entry.payload && Object.keys(entry.payload).length > 0 ? { record: entry.payload } : {}),
      });
    }
    return { items };
  });
}

/**
 * 标记一条领取的任务完成或失败。
 * 成功 → done；失败 → 重新 enqueue（回到 pending 等待下次 claim，
 * claimBatch 的 attempts 计数会在满 3 次后把它判死，避免无限重试）。
 * @param {{memoHome, scope, id, validFrom, ok, reason?, clock?}} opts
 * @returns {Promise<{op: string}>}
 */
export async function completeItem({ memoHome, scope, id, validFrom, ok = true, reason, clock } = {}) {
  if (!memoHome || typeof memoHome !== 'string' || typeof id !== 'string' || typeof validFrom !== 'string') {
    const err = new Error('completeItem: memoHome/id/validFrom 均为必填字符串');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const now = clock?.now ?? (() => new Date().toISOString());
  return withPathLock(path.join(memoHome, "derive-queue"), `${scopeKeyOf(scope)}.lock`, async () => {
    const filePath = queueFilePath(memoHome, scope);
    if (ok) {
      await appendOp(filePath, { op: 'done', id, validFrom, ts: now() });
      return { op: 'done' };
    }
    const state = buildState(await readOps(filePath));
    const entry = state.get(`${id}@${validFrom}`);
    const attempts = entry ? entry.attempts : 0;
    if (attempts >= MAX_ATTEMPTS) {
      await appendOp(filePath, { op: 'dead', id, validFrom, ts: now(), reason: reason ?? 'max-attempts' });
      return { op: 'dead' };
    }
    await appendOp(filePath, { op: 'enqueue', id, validFrom, ts: now(), retry: true });
    return { op: 'enqueue' };
  });
}

/**
 * 队列统计：各状态条目数。
 * @param {{memoHome, scope}} opts
 * @returns {Promise<{pending: number, claimed: number, done: number, dead: number, total: number}>}
 */
export async function deriveQueueStats({ memoHome, scope } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error(`queueStats: memoHome required, got ${JSON.stringify(memoHome)}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const filePath = queueFilePath(memoHome, scope);
  const stats = { pending: 0, claimed: 0, done: 0, dead: 0, total: 0 };
  for (const entry of buildState(await readOps(filePath)).values()) {
    if (stats[entry.state] !== undefined) stats[entry.state] += 1;
    stats.total += 1;
  }
  return stats;
}

// 兼容别名：历史调用点用 queueStats，新增 CLI 用 deriveQueueStats（语义相同）。
export const queueStats = deriveQueueStats;
