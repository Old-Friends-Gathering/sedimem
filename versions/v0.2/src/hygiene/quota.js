// hygiene/quota.js — 配额淘汰：只选墓碑候选，绝不物理删
// value = kindWeight × hits × recencyDecay × confidence，单调性可测。

import { readFileSync } from 'node:fs';
import { monotonicDecay } from './conflict.js';

/**
 * 策略单一来源（裁决 20）：优先 src/config/policy.js 的 loadPolicy()，
 * 缺失时回退直接读 config/policy.json；构造参数仍可覆盖。
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

export class QuotaPolicy {
  /** @param {{maxActive?: number, kindWeight?: Record<string,number>, recencyHalfLifeMs?: number}} opts */
  constructor({ maxActive = POLICY?.quota?.maxActive ?? 5000, kindWeight, recencyHalfLifeMs } = {}) {
    if (!Number.isInteger(maxActive) || maxActive < 1) {
      const err = new Error(`QuotaPolicy: maxActive must be a positive integer, got ${maxActive}`);
      err.code = 'E_INVALID_QUOTA';
      throw err;
    }
    this.maxActive = maxActive;
    this.kindWeight = kindWeight ?? POLICY?.kindWeight ?? { pref: 1.3, decision: 1.4, gotcha: 1.2, fact: 1.0, state: 0.6 };
    this.recencyHalfLifeMs =
      recencyHalfLifeMs ?? POLICY?.search?.recencyHalflifeMs ?? 7776000000;
  }

  /**
   * kindWeight × hits × recencyDecay × confidence。
   * 对 hits、confidence、recency 各自单调（value 随它们不减）。
   * @param {import('../core/record.js').MemoryRecord} record
   * @param {{nowMs(): number}} clock
   */
  value(record, clock) {
    if (!record || typeof record !== 'object') {
      const err = new Error('value: record is required');
      err.code = 'E_INVALID_RECORD';
      throw err;
    }
    if (typeof clock?.nowMs !== 'function') {
      const err = new Error('value: clock.nowMs is required');
      err.code = 'E_INVALID_RECORD';
      throw err;
    }
    const weight = this.kindWeight[record.kind];
    if (typeof weight !== 'number' || !Number.isFinite(weight)) {
      const err = new Error(`value: unknown kind ${record.kind}`);
      err.code = 'E_INVALID_KIND';
      throw err;
    }
    const hits = Number(record.hits ?? 0);
    const confidence = Number(record.confidence ?? 0);
    if (!Number.isFinite(hits) || hits < 0 || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      const err = new Error(`value: bad hits/confidence on ${record.id}`);
      err.code = 'E_INVALID_RECORD';
      throw err;
    }
    const createdAtMs = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAtMs)) {
      const err = new Error(`value: bad createdAt on ${record.id}`);
      err.code = 'E_INVALID_RECORD';
      throw err;
    }
    const recency = monotonicDecay(Math.max(0, clock.nowMs() - createdAtMs), this.recencyHalfLifeMs);
    return weight * hits * recency * confidence;
  }

  /**
   * 超配时返回应淘汰（写墓碑）的 id 数组，按价值升序（最该淘汰在前）。
   * 未超配 → []。只考虑 active 记录；不物理删、不改入参。
   * @param {import('../core/record.js').MemoryRecord[]} records
   * @param {{max?: number}} [opts]
   */
  selectEvictions(records, { max = this.maxActive } = {}) {
    if (!Array.isArray(records)) {
      const err = new Error('selectEvictions: records must be an array');
      err.code = 'E_INVALID_RECORD';
      throw err;
    }
    if (!Number.isInteger(max) || max < 0) {
      const err = new Error(`selectEvictions: max must be a non-negative integer, got ${max}`);
      err.code = 'E_INVALID_QUOTA';
      throw err;
    }
    const active = records.filter((r) => r && r.status === 'active');
    if (active.length <= max) return [];
    // 用固定时钟快照保证同批内可比；值同则按 createdAt 升序、再按 id，保证确定性。
    const nowMs = Math.max(...active.map((r) => Date.parse(r.createdAt) || 0), 0);
    const pseudoClock = { nowMs: () => nowMs };
    const surplus = active.length - max;
    return active
      .map((r) => ({ id: r.id, v: this.value(r, pseudoClock), createdAt: r.createdAt, kind: r.kind }))
      .sort((a, b) => {
        if (a.v !== b.v) return a.v - b.v;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      })
      .slice(0, surplus)
      .map((x) => x.id);
  }
}
