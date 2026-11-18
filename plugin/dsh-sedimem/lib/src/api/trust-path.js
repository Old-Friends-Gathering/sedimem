// api/trust-path.js — 人工信任提升（P0b B2 / docs/02 §3.24）
//
// 契约：`memo trust promote <id> --to T0|T1 --reason ...` 是**唯一**能改变 trust
// 或缩减 taint 的动作。普通 write/supersede/merge 只能让信任变保守（T2/T3、taint 并集），
// 所以去污必须留下一条带理由的审计事件，不能借任何自动路径静默完成。

import { createHash } from 'node:crypto';

import { withPatch } from '../core/record.js';
import { invalidArg, notFound } from '../core/errors.js';
import {
  isTrustLevel, trustRank, effectiveTrust, effectiveTaint, unionTaint, TRUST_LEVELS,
} from '../core/trust.js';

/** 审计里不写 taint 原文（可能夹带路径/URL/凭据痕迹，只留短哈希供对账）。 */
function taintFingerprint(entry) {
  return `sha256:${createHash('sha256').update(entry).digest('hex').slice(0, 12)}`;
}

/**
 * @param {import('./service.js').MemoryService} svc
 * @param {{id: string, to: string, reason: string, dropTaint?: string[]}} input
 */
export async function promoteTrust(svc, { id, to, reason, dropTaint } = {}) {
  svc._ensureOpen();
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw invalidArg('trust promote: --reason (non-empty) is required');
  }
  if (!isTrustLevel(to)) {
    throw invalidArg(`trust promote: --to must be one of ${TRUST_LEVELS.join('|')}, got ${JSON.stringify(to)}`);
  }
  const rec = svc._records.get(id);
  if (!rec) throw notFound(`trust promote: record ${id} not found`);
  if (rec.status === 'tombstoned') {
    throw invalidArg(`trust promote: record ${id} is tombstoned（已删除记录不再提升信任）`);
  }

  const current = effectiveTrust(rec);
  // promote 只允许「变强」（rank 变小）：T2 → T0/T1。反向或持平没有意义，
  // 必须拒绝而不是写一条看起来成功的审计。
  if (trustRank(to) >= trustRank(current)) {
    throw invalidArg(`trust promote: target ${to} is not stronger than current ${current}`);
  }

  const before = effectiveTaint(rec);
  const drop = new Set(Array.isArray(dropTaint) ? dropTaint.map((x) => String(x).trim()).filter(Boolean) : []);
  const after = drop.size > 0 ? before.filter((entry) => !drop.has(entry)) : before;
  const removed = before.filter((entry) => !after.includes(entry));

  const detail = {
    reason: reason.trim(),
    from: current,
    to,
    // 审计脱敏：正文/taint 原文不落事件流，只留「删了几条 + 每条短哈希」。
    taintRemoved: removed.length,
    taintBefore: before.length,
    taintAfter: after.length,
    ...(removed.length > 0 ? { taintRemovedFingerprints: removed.map(taintFingerprint) } : {}),
  };
  const patched = withPatch(rec, {
    trust: to,
    // 只有显式要求删除才改 taint；不传就原样保留（promote 本身不等于自动去污）。
    ...(removed.length > 0 ? { taint: unionTaint(after) } : {}),
  });
  await svc._commit(patched, 'trust_promote', detail);
  return { record: patched, from: current, to, taintRemoved: removed.length };
}
