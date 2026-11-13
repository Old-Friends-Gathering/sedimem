// api/write-path.js — 写路径承接模块（车道 A，issue #32）
// write/supersede/forget/enforceQuota 的原方法体搬到此，this → svc，语义零改动。

import { createRecord, validateRecord, withPatch, recordWarnings } from '../core/record.js';
import { withLock } from '../storage/lock.js';
import { decideWrite } from '../hygiene/write-gate.js';
import { detectSuspicious } from '../hygiene/suspicious.js';
import { redactText } from '../hygiene/redact.js';
import { defaultPolicy as POLICY } from '../config/policy.js';
// 错误工厂从 service.js 反向引用（错误文本被测试断言，必须单一来源）。
import { invalid, notFound } from './service.js';
// session 库写入门禁（v0.6 修复：之前 assertWritableKind 写了但没人调用，fact 仍能落临时库）。
// lifecycle.js 只静态依赖 core/config/mcp-常量，不依赖 api/*，此处静态 import 无循环。
import { assertWritableKind, assertSessionOpen } from '../session/lifecycle.js';


/**
 * 统一脱敏入口（对抗审核 B1）：text / value / title / source.quote **四个面**都要过一遍，
 * 且**不依赖 text 是否变化**——上一版把 value 脱敏嵌在 `if (red.changed)` 里，
 * text 干净而 value 含密钥时 value 原样落盘。
 * @returns {{input: object, kinds: string[]}}
 */
function redactInput(svc, input) {
  const policy = svc.policy ?? POLICY;
  if ((policy.redact ?? POLICY.redact)?.enabled === false) return { input, kinds: [] };
  const kinds = new Set();
  const collect = (red) => { for (const { kind } of red.redactions) kinds.add(kind); };
  const out = { ...input };
  if (typeof out.text === 'string') {
    const red = redactText(out.text, { policy });
    collect(red);
    if (red.changed) out.text = red.text;
  }
  if (typeof out.value === 'string') {
    const red = redactText(out.value, { policy });
    collect(red);
    if (red.changed) out.value = red.text;
  }
  if (typeof out.title === 'string') {
    const red = redactText(out.title, { policy });
    collect(red);
    if (red.changed) out.title = red.text;
  }
  if (out.source && typeof out.source === 'object' && typeof out.source.quote === 'string') {
    const red = redactText(out.source.quote, { policy });
    collect(red);
    if (red.changed) out.source = { ...out.source, quote: red.text };
  }
  return { input: out, kinds: [...kinds] };
}

/**
 * 写入。严格按契约动作优先级：hash 命中 → 同 slot 同值 → 同 slot 异值 → created。
 * @returns {{action: string, record: MemoryRecord, supersededId?: string}}
 */
export async function writeRecord(svc, input) {
  svc._ensureOpen();
  if (!input || typeof input.text !== 'string' || input.text.length === 0) {
    throw invalid('write: input.text (non-empty string) is required');
  }
  // 内部旁路标记（session lifecycle 写 meta 用，对抗 B-02）：剥离后不再进入记录本体；
  // 普通调用方传了也只当普通写（meta 门禁不放行）
  const internal = input._sessionInternal === true;
  if (internal) {
    input = { ...input };
    delete input._sessionInternal;
  }
  // 写入门禁：session 临时库禁 fact（kind 缺省与 createRecord/recordWarnings 一致按 'fact'）；
  // 且禁止普通写入 session meta（E_SESSION_META_PROTECTED）
  assertWritableKind(svc.scope, input.kind ?? 'fact', { internal, input });
  // B-03：session 状态为 closed 时拒绝写入（状态以 sessions/<id>.json 为准，缺失按 open；
  // 非 session scope 该检查为 no-op）
  assertSessionOpen(svc.memoHome, svc.scope);
  // 投毒防线：可疑输入打标（I5）——写入成功但不进 brief。
  // 检测来自 hygiene/suspicious.js（归一化 + 启发式），pattern 单一来源 POLICY.suspiciousPatterns；
  // 启发式开关 POLICY.suspiciousHeuristics（缺省全 true）。
  const tags = Array.isArray(input.tags) ? [...input.tags] : [];
  const verdict = detectSuspicious(
    input.text, POLICY.suspiciousPatterns, { heuristics: POLICY.suspiciousHeuristics },
  );
  if (verdict.suspicious && !tags.includes('suspicious')) tags.push('suspicious');

  // 脱敏（v0.4 D7）：先脱敏再进 createRecord —— 这样 contentHash、真相层、索引、
  // 事件流看到的都是脱敏后的文本，原文不落盘（只留 redacted:<kind> 痕迹供审计）。
  // 关掉时（policy.redact.enabled=false）行为与 0.3.x 完全一致。
  const redacted = redactInput(svc, input);
  const writeInput = redacted.input;
  for (const kind of redacted.kinds) {
    const tag = `redacted:${kind}`;
    if (!tags.includes(tag)) tags.push(tag);
  }

  // W1 写侧粒度契约：告警不打断写入，只打 long-form 标记并在返回值里透出，
  // 供调用方决定是否拆条重写。放在 redactInput/detectSuspicious 之后，不改变原顺序。
  const warnings = recordWarnings(
    { text: writeInput.text, value: writeInput.value, kind: writeInput.kind ?? 'fact', title: writeInput.title },
    svc.policy ?? POLICY,
  );
  if (warnings.length > 0 && !tags.includes('long-form')) tags.push('long-form');

  const candidate = createRecord({
    ...writeInput,
    tags,
    scope: svc.scope,
    value: writeInput.value ?? writeInput.text,
    subject: input.subject ?? 'text',
    predicate: input.predicate ?? 'text',
  }, { clock: svc.clock, policy: svc.policy ?? POLICY });

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
      const vv = validateRecord(record, undefined, svc.policy ?? POLICY);
      if (!vv.ok) throw invalid(`write: gate produced invalid record: ${vv.errors.join('; ')}`);

      switch (gate.action) {
        case 'created': {
          await svc._commit(record, 'write', { action: gate.action, reason: gate.reason });
          await svc.enforceQuota();
          return { action: gate.action, record, warnings };
        }
        case 'noop_duplicate':
        case 'noop_same_value': {
          // 不写真相层；只写审计事件（每次写操作必返回 action —— hook 静默失败防线）
          await svc._event('write', record.id, { action: gate.action, reason: gate.reason });
          return { action: gate.action, record, warnings };
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
          return { action: gate.action, record, supersededId: closedOld.id, warnings };
        }
        case 'disputed': {
          await svc._commit(record, 'write', { action: gate.action, reason: gate.reason });
          return { action: gate.action, record, warnings };
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
export async function supersedeRecord(svc, { oldId, value, text, title, source, reason }) {
  svc._ensureOpen();
  const old = svc._records.get(oldId);
  if (!old) throw notFound(`supersede: record ${oldId} not found`);
  // 墓碑是「已删除」的终态：允许 supersede 会把它改回 superseded 并新建 active，
  // 等于用一次普通写操作把 purge 语义打断（对抗审核实测过）。要恢复就重新 write 一条新记录。
  if (old.status === 'tombstoned') {
    throw invalid(`supersede: record ${oldId} is tombstoned（已删除的记录不可取代，请直接写新记录）`);
  }
  // 对抗审核 B1：supersede 是第二条写路径，之前完全绕过脱敏与投毒检测。
  const bodyInput = { text: text ?? value ?? '', value: value ?? old.value, source: source ?? old.source };
  const redacted = redactInput(svc, bodyInput);
  const body = redacted.input.text;
  const supTags = Array.isArray(old.tags) ? [...old.tags] : [];
  for (const kind of redacted.kinds) {
    const tag = `redacted:${kind}`;
    if (!supTags.includes(tag)) supTags.push(tag);
  }
  const supVerdict = detectSuspicious(body, POLICY.suspiciousPatterns, { heuristics: POLICY.suspiciousHeuristics });
  if (supVerdict.suspicious && !supTags.includes('suspicious')) supTags.push('suspicious');
  // B2/S-01（arch + adv）：supersede 是独立写路径，必须与 writeRecord 同契约——
  // 跑 W1 粒度告警并按结果打 long-form 标记，不能静默落超长记录。
  const supWarnings = recordWarnings(
    { text: body, value: redacted.input.value, kind: old.kind, title: title ?? old.title },
    svc.policy ?? POLICY,
  );
  if (supWarnings.length > 0 && !supTags.includes('long-form')) supTags.push('long-form');
  const record = createRecord({
    text: body,
    value: redacted.input.value,
    // S-01：新记录没传 title 时继承旧记录 title——supersede 是「改值」不是「换主题」，
    // 丢 title 会让图谱/brief 上这条线索断头。
    title: title ?? old.title,
    subject: old.subject,
    predicate: old.predicate,
    kind: old.kind,
    scope: svc.scope,
    source: redacted.input.source,
    confidence: old.confidence,
    tags: supTags,
    privacy: old.privacy,
    supersedes: oldId,
    // B2：把 svc 的 clock 与 policy 传进 createRecord，否则自定义 policy
    // （textHardMaxChars / titleEnforce 等）在 supersede 路径整体失效。
  }, { clock: svc.clock, policy: svc.policy ?? POLICY });
  await svc._commit(record, 'write', { action: 'supersede', reason: reason ?? 'manual' });
  const closed = withPatch(old, { status: 'superseded', validTo: svc._nowIso() });
  await svc._commit(closed, 'supersede', { reason: reason ?? 'manual', by: record.id });
  return { record, warnings: supWarnings };
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
