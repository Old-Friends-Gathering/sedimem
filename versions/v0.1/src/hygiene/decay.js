// hygiene/decay.js — TTL / 衰减（半衰期来自策略单一来源，构造可覆盖）
// 策略单一来源（裁决 20）：优先 src/config/policy.js 的 loadPolicy()，
// 缺失时回退直接读 config/policy.json（相对路径 ../../config/policy.json）。

import { readFileSync } from 'node:fs';

async function loadPolicySafe() {
  let policy;
  try {
    const m = await import('../config/policy.js');
    if (typeof m.loadPolicy === 'function') policy = m.loadPolicy();
  } catch { /* 模块缺失 → 回退 */ }
  if (!policy) {
    const url = new URL('../../config/policy.json', import.meta.url);
    policy = JSON.parse(readFileSync(url, 'utf8'));
  }
  if (!policy || typeof policy.halfLifeMs !== 'object' || policy.halfLifeMs === null) {
    const err = new Error('decay: policy.halfLifeMs missing');
    err.code = 'E_POLICY';
    throw err;
  }
  return policy;
}

/** @type {{pref:number, decision:number, fact:number, gotcha:number, state:number}} */
export const HALF_LIFE_MS = (await loadPolicySafe()).halfLifeMs;

/**
 * state 类返回 nowMs + halfLife（ISO）；其余 kind 返回 null（靠整合期标记，不设 TTL）。
 * @param {'fact'|'pref'|'decision'|'gotcha'|'state'} kind
 * @param {number} nowMs
 * @param {number} [halfLifeMsOverride] 构造期覆盖（默认取 HALF_LIFE_MS.state）
 * @returns {string|null}
 */
export function expiryFor(kind, nowMs, halfLifeMsOverride) {
  if (!(kind in HALF_LIFE_MS)) {
    const err = new Error(`expiryFor: unknown kind ${kind}`);
    err.code = 'E_INVALID_KIND';
    throw err;
  }
  if (!Number.isFinite(nowMs)) {
    const err = new Error(`expiryFor: nowMs must be finite, got ${nowMs}`);
    err.code = 'E_INVALID_AGE';
    throw err;
  }
  if (kind !== 'state') return null;
  const halfLife = halfLifeMsOverride ?? HALF_LIFE_MS.state;
  if (!Number.isFinite(halfLife) || halfLife <= 0) {
    const err = new Error(`expiryFor: halfLife must be positive, got ${halfLife}`);
    err.code = 'E_INVALID_HALF_LIFE';
    throw err;
  }
  return new Date(nowMs + halfLife).toISOString();
}

/**
 * expiredAt 标记已写，或（state 类）validFrom 距今已过一个半衰期 TTL。
 * 非 state 且无 expiredAt → false。
 * @param {import('../core/record.js').MemoryRecord} record
 * @param {{nowMs(): number}} clock
 */
export function isExpired(record, clock, halfLifeMsOverride) {
  if (!record || typeof record !== 'object') {
    const err = new Error('isExpired: record is required');
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  if (typeof clock?.nowMs !== 'function') {
    const err = new Error('isExpired: clock.nowMs is required');
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  if (record.expiredAt) return true;
  if (record.kind !== 'state') return false;
  const validFromMs = Date.parse(record.validFrom);
  if (!Number.isFinite(validFromMs)) {
    const err = new Error(`isExpired: bad validFrom on ${record.id}`);
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  const halfLife = halfLifeMsOverride ?? HALF_LIFE_MS.state;
  return clock.nowMs() - validFromMs >= halfLife;
}
