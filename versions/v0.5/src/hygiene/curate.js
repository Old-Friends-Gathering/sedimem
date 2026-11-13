// hygiene/curate.js — 离线裁决队列：queue/curate-<batchId>.json，全走文件。
// 本模块不 import storage 实现；真正的 supersede 落盘由 api 层消费 applyDecisions 的结果执行。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DECISIONS = new Set(['a_wins', 'b_wins', 'merge', 'keep_both']);

export class CurateQueue {
  /**
   * @param {{memoHome: string, clock: {now(): string, nowMs(): number}}} opts
   */
  constructor({ memoHome, clock }) {
    if (!memoHome || typeof memoHome !== 'string') {
      const err = new Error('CurateQueue: memoHome is required');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    if (typeof clock?.now !== 'function' || typeof clock?.nowMs !== 'function') {
      const err = new Error('CurateQueue: clock with now()/nowMs() is required');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    this.memoHome = memoHome;
    this.clock = clock;
    this.queueDir = join(memoHome, 'queue');
  }

  /**
   * 把冲突对导出成 queue/curate-<batchId>.json（batchId = 时间 + 随机）。
   * @param {{a: object, b: object, reason: string}[]} pairs
   * @param {{limit?: number}} [opts]
   * @returns {Promise<{batchId: string, createdAt: string, pairs: {a: object, b: object, reason: string}[], path: string}>}
   */
  async exportBatch(pairs, { limit = 20 } = {}) {
    if (!Array.isArray(pairs)) {
      const err = new Error('exportBatch: pairs must be an array');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    if (!Number.isInteger(limit) || limit < 1) {
      const err = new Error(`exportBatch: limit must be a positive integer, got ${limit}`);
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const batchId = `${this.clock.nowMs().toString(36)}-${randomBytes(4).toString('hex')}`;
    const createdAt = this.clock.now();
    const batch = {
      batchId,
      createdAt,
      status: 'pending',
      pairs: pairs.slice(0, limit).map((p, i) => ({
        pairIndex: i,
        a: p.a,
        b: p.b,
        reason: p.reason ?? '',
      })),
      applied: [],
    };
    mkdirSync(this.queueDir, { recursive: true });
    const path = join(this.queueDir, `curate-${batchId}.json`);
    writeFileSync(path, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
    return { batchId, createdAt, pairs: batch.pairs, path };
  }

  /**
   * @param {string} batchId
   * @returns {Promise<object>} batch（含 batchId/createdAt/pairs/applied）
   */
  async readBatch(batchId) {
    if (!batchId || typeof batchId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(batchId)) {
      const err = new Error(`readBatch: invalid batchId ${JSON.stringify(batchId)}`);
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const path = join(this.queueDir, `curate-${batchId}.json`);
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (cause) {
      const err = new Error(`readBatch: batch ${batchId} not found`);
      err.code = 'E_BATCH_NOT_FOUND';
      err.cause = cause;
      throw err;
    }
    try {
      const batch = JSON.parse(raw);
      batch.path = path;
      return batch;
    } catch (cause) {
      const err = new Error(`readBatch: batch ${batchId} is not valid JSON`);
      err.code = 'E_BATCH_NOT_FOUND';
      err.cause = cause;
      throw err;
    }
  }

  /**
   * 对批次应用裁决。decision ∈ a_wins|b_wins|merge|keep_both。
   * 本层只把裁决 + 审计信息写回批次文件并返回结果；不直接改 items/*.jsonl
   *（真相层写盘由 api 层在拿到结果后执行——hygiene 不 import storage）。
   * @param {object} batch readBatch 返回的批次
   * @param {{pairIndex: number, decision: string, note?: string}[]} decisions
   * @returns {Promise<{pairIndex: number, applied: boolean, decision: string, note?: string, appliedAt: string, newRecord: null}[]>}
   */
  async applyDecisions(batch, decisions) {
    if (!batch || !Array.isArray(batch.pairs)) {
      const err = new Error('applyDecisions: batch with pairs[] is required');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    if (!Array.isArray(decisions)) {
      const err = new Error('applyDecisions: decisions must be an array');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const appliedAt = this.clock.now();
    const results = [];
    for (const d of decisions) {
      if (!d || !DECISIONS.has(d.decision)) {
        const err = new Error(
          `applyDecisions: decision must be one of ${[...DECISIONS].join('|')}, got ${JSON.stringify(d?.decision)}`,
        );
        err.code = 'E_INVALID_ARG';
        throw err;
      }
      const pair = batch.pairs[d.pairIndex];
      if (!pair) {
        const err = new Error(`applyDecisions: pairIndex ${d.pairIndex} out of range (0..${batch.pairs.length - 1})`);
        err.code = 'E_INVALID_ARG';
        throw err;
      }
      const already = (batch.applied ?? []).find((x) => x.pairIndex === d.pairIndex);
      if (already) {
        results.push({
          pairIndex: d.pairIndex,
          applied: false,
          decision: d.decision,
          note: `pair ${d.pairIndex} already decided as ${already.decision} at ${already.appliedAt}`,
          appliedAt,
          newRecord: null,
        });
        continue;
      }
      batch.applied = [...(batch.applied ?? []), {
        pairIndex: d.pairIndex,
        decision: d.decision,
        note: d.note ?? null,
        appliedAt,
        audit: {
          batchId: batch.batchId,
          winner: d.decision === 'a_wins' ? 'a' : d.decision === 'b_wins' ? 'b' : null,
          a: pair.a?.id ?? null,
          b: pair.b?.id ?? null,
        },
      }];
      results.push({
        pairIndex: d.pairIndex,
        applied: true,
        decision: d.decision,
        note: d.note ?? null,
        appliedAt,
        newRecord: null, // 真实的新记录由 api 层基于该裁决落盘
      });
    }
    batch.status = batch.applied.length >= batch.pairs.length ? 'applied' : 'partial';
    const path = batch.path ?? join(this.queueDir, `curate-${batch.batchId}.json`);
    const toPersist = { ...batch };
    delete toPersist.path;
    writeFileSync(path, `${JSON.stringify(toPersist, null, 2)}\n`, 'utf8');
    return results;
  }

  /**
   * @returns {Promise<{batchId: string, size: number, createdAt: string}[]>}
   */
  async listBatches() {
    mkdirSync(this.queueDir, { recursive: true });
    const out = [];
    for (const name of readdirSync(this.queueDir)) {
      if (!name.startsWith('curate-') || !name.endsWith('.json')) continue;
      try {
        const b = JSON.parse(readFileSync(join(this.queueDir, name), 'utf8'));
        out.push({ batchId: b.batchId, size: Array.isArray(b.pairs) ? b.pairs.length : 0, createdAt: b.createdAt });
      } catch (cause) {
        const err = new Error(`listBatches: unreadable batch file ${name} (${cause.message})`);
        err.code = 'E_BATCH_NOT_FOUND';
        err.cause = cause;
        throw err;
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.batchId < b.batchId ? 1 : -1));
    return out;
  }
}
