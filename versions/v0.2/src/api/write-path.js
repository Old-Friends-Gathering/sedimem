// api/write-path.js — 写路径承接模块（车道 A，issue #32）
// write/supersede/forget/enforceQuota 的原方法体搬到此，this → svc，语义零改动。

import { createRecord, validateRecord, withPatch } from '../core/record.js';
import { withLock } from '../storage/lock.js';
import { decideWrite } from '../hygiene/write-gate.js';
import { detectSuspicious } from '../hygiene/suspicious.js';
import { defaultPolicy as POLICY } from '../config/policy.js';
// 错误工厂从 service.js 反向引用（错误文本被测试断言，必须单一来源）。
import { invalid, notFound } from './service.js';

/**
 * 写入。严格按契约动作优先级：hash 命中 → 同 slot 同值 → 同 slot 异值 → created。
 * @returns {{action: string, record: MemoryRecord, supersededId?: string}}
 */
export async function writeRecord(svc, input) {
  svc._ensureOpen();
  if (!input || typeof input.text !== 'string' || input.text.length === 0) {
    throw invalid('write: input.text (non-empty string) is required');
  }
  // 投毒防线：可疑输入打标（I5）——写入成功但不进 brief。
  // 检测来自 hygiene/suspicious.js（归一化 + 启发式），pattern 单一来源 POLICY.suspiciousPatterns；
  // 启发式开关 POLICY.suspiciousHeuristics（缺省全 true）。
  const tags = Array.isArray(input.tags) ? [...input.tags] : [];
  const verdict = detectSuspicious(
    input.text, POLICY.suspiciousPatterns, { heuristics: POLICY.suspiciousHeuristics },
  );
  if (verdict.suspicious && !tags.includes('suspicious')) tags.push('suspicious');

  const candidate = createRecord({
    ...input,
    tags,
    scope: svc.scope,
    value: input.value ?? input.text,
    subject: input.subject ?? 'text',
    predicate: input.predicate ?? 'text',
  }, { clock: svc.clock });

  // 裁决 13（阻断项）：「增量重读 → 判定 → 追加」必须在同一把 scope 锁的临界区内完成，
  // 判定不得基于进程内陈旧快照。锁内追加/事件走 store 的 Immediate（无锁）变体。
  return withLock(svc.memoHome, async () => {
    svc._inScopeLock = true;
    try {
      await svc._refreshIncremental();

      // candidates: 同 scope 且允许参与判定的记录（active + disputed）
      const candidates = [...svc._records.values()].filter(
        (r) => r.status === 'active' || r.status === 'disputed',
      );

      const gate = decideWrite(candidate, candidates, { clock: svc.clock });
      if (!gate || !gate.action) throw invalid('write: decideWrite returned no action');
      const record = gate.record ?? candidate;
      const vv = validateRecord(record);
      if (!vv.ok) throw invalid(`write: gate produced invalid record: ${vv.errors.join('; ')}`);

      switch (gate.action) {
        case 'created': {
          await svc._commit(record, 'write', { action: gate.action, reason: gate.reason });
          await svc.enforceQuota();
          return { action: gate.action, record };
        }
        case 'noop_duplicate':
        case 'noop_same_value': {
          // 不写真相层；只写审计事件（每次写操作必返回 action —— hook 静默失败防线）
          await svc._event('write', record.id, { action: gate.action, reason: gate.reason });
          return { action: gate.action, record };
        }
        case 'supersede': {
          if (!gate.superseded) throw invalid('write: supersede without superseded record');
          // 同时：新记录 + 旧记录以 status:'superseded' + validTo 追加一次新版本
          // （write-gate 返回的 superseded 是未打补丁的 peer，这里负责落补丁）
          await svc._commit(record, 'write', { action: gate.action, reason: gate.reason });
          const handoff = record.validFrom ?? svc._nowIso();
          const closedOld = gate.superseded.status === 'superseded' && gate.superseded.validTo
            ? gate.superseded
            : withPatch(gate.superseded, {
                status: 'superseded',
                validTo: gate.superseded.validTo ?? handoff,
              });
          await svc._commit(closedOld, 'supersede', { reason: gate.reason, by: record.id });
          return { action: gate.action, record, supersededId: closedOld.id };
        }
        case 'disputed': {
          await svc._commit(record, 'write', { action: gate.action, reason: gate.reason });
          return { action: gate.action, record };
        }
        default:
          throw invalid(`write: unknown decideWrite action ${JSON.stringify(gate.action)}`);
      }
    } finally {
      svc._inScopeLock = false;
    }
  });
}

/** 人工 supersede：新记录 + 旧记录追加 superseded 版本 */
export async function supersedeRecord(svc, { oldId, value, text, source, reason }) {
  svc._ensureOpen();
  const old = svc._records.get(oldId);
  if (!old) throw notFound(`supersede: record ${oldId} not found`);
  const body = text ?? value;
  const record = createRecord({
    text: body,
    value: value ?? old.value,
    subject: old.subject,
    predicate: old.predicate,
    kind: old.kind,
    scope: svc.scope,
    source: source ?? old.source,
    confidence: old.confidence,
    tags: old.tags,
    privacy: old.privacy,
    supersedes: oldId,
  }, { clock: svc.clock });
  await svc._commit(record, 'write', { action: 'supersede', reason: reason ?? 'manual' });
  const closed = withPatch(old, { status: 'superseded', validTo: svc._nowIso() });
  await svc._commit(closed, 'supersede', { reason: reason ?? 'manual', by: record.id });
  return { record };
}

/** 删除：只写墓碑；mode='purge' 额外打 tags:['purge']，物理删由 service.compact 负责（裁决 51） */
export async function forgetRecord(svc, { id, mode = 'tombstone', reason }) {
  svc._ensureOpen();
  const rec = svc._records.get(id);
  if (!rec) throw notFound(`forget: record ${id} not found`);
  // purge 只是「允许将来被压实掉」的标记，不是立即删除：误记 purge 也还能 as-of 回查，直到 compact 越过 grace。
  const tags = mode === 'purge' && !rec.tags.includes('purge') ? [...rec.tags, 'purge'] : rec.tags;
  const tomb = withPatch(rec, {
    status: 'tombstoned',
    validTo: rec.validTo ?? svc._nowIso(),
    tags,
  });
  await svc._commit(tomb, 'forget', { mode, reason: reason ?? null });
  return { id, status: 'tombstoned' };
}

/**
 * 配额淘汰（裁决 20：公开整合入口，供 nightly 调用）：淘汰低价值 active →
 * 写墓碑并打 tags:['quota']，不物理删；dryRun 只返回将被淘汰的 id，不落盘。
 * 价值与上限全部来自 policy（经 QuotaPolicy），service 不留魔法数字。
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<string[]>} 被淘汰（或 dryRun 下将被淘汰）的记录 id
 */
export async function enforceQuota(svc, { dryRun = false } = {}) {
  svc._ensureOpen();
  const max = svc.quota.maxActive ?? POLICY.quota.maxActive;
  const records = [...svc._records.values()].filter((r) => r.status === 'active');
  if (records.length <= max) return [];
  const evictIds = svc.quota.selectEvictions(records, { max });
  const victims = evictIds
    .map((id) => svc._records.get(id))
    .filter(Boolean);
  if (dryRun) return victims.map((r) => r.id);
  for (const r of victims) {
    const tags = Array.isArray(r.tags) ? [...r.tags] : [];
    if (!tags.includes('quota')) tags.push('quota');
    const tomb = withPatch(r, {
      status: 'tombstoned',
      validTo: r.validTo ?? svc._nowIso(),
      tags,
    });
    await svc._commit(tomb, 'evict', { reason: 'quota_exceeded' });
  }
  return victims.map((r) => r.id);
}

/** 写路径内部的配额淘汰（保留旧私有入口，语义同 enforceQuota） */
export async function enforceQuotaPrivate(svc) {
  return enforceQuota(svc);
}
