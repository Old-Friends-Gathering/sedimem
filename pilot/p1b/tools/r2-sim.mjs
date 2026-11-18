// pilot/p1b/tools/r2-sim.mjs
// P1b 保护测试的内存模拟器（09 §10.0 桩接口契约的实现）。
// 红线：不写真相层文件、不联网、不读 corpus/gold；候选恒 pending，直到 decide 给出自动决策。
import { createHash } from 'node:crypto';
import { createSim } from '../../p1a/tools/protocol-sim.mjs';

export const POLICY_VERSION = 'policy:auto-memory-r2/1';
export const DEFAULT_POLICY = Object.freeze({ maxCasRefresh: 2 });

const INJECTION_RE = /(忽略(此前|之前|以上)|ignore\s+(all\s+)?previous|you\s+are\s+now|system\s*prompt|请把(这条|以下)?(写|存)成)/iu;
const NEG_RE = /(不支持|不是|没有|未|不能|别|never|\bnot\b|\bno\s+longer\b)/iu;
const SUGGEST_RE = /(建议|可以试试|不妨|推荐|\bshould\b|\bcould\b|\bmight\b|\bconsider\b)/iu;
const RETRACT_RE = /(撤回|收回|作废|不算数|说错了|\bretract\b|\bwithdraw\b)/iu;
const RETRACTION_INSTRUCTION_RE = /(先别改|不要改|仍用|还是用|保持原样|回退|回滚到|恢复原值)/u;
const QUOTE_RE = /(文档里(写|说)|据说|引用|原文|笔记(里|中))/u;
const ASSISTANT_CLAIM_RE = /(我已经|我已经把|已修复|已完成|这边已)/u;

function sha256(text) {
  return `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

function codePointSpan(haystack, needle) {
  const at = String(haystack).indexOf(needle);
  if (at < 0) return null;
  return { start: [...String(haystack).slice(0, at)].length, end: [...String(haystack).slice(0, at + needle.length)].length };
}

function resolveEvidence(evidence, events) {
  return (evidence ?? []).map((e) => {
    const ev = events?.[e.eventId];
    if (!ev) return { ...e, resolvable: false, reason: 'event-missing' };
    const span = codePointSpan(ev.text, e.quote);
    if (!span) return { ...e, resolvable: false, reason: 'quote-not-found' };
    return { ...e, span, hash: sha256(ev.text), resolvable: true, role: ev.role, ts: ev.ts };
  });
}

// R4.5 断言框架机判五项：证据角色 / 否定 / 建议 / 完成 / 撤回
function assertionMismatch(claim, evidence) {
  const a = claim.assertion ?? {};
  const ev = evidence.find((e) => e.resolvable);
  if (!ev) return 'evidence-not-resolvable';
  const text = claim.assertion?.quote ?? '';
  const speaker = a.speaker ?? 'user';

  if (speaker === 'quoted') {
    if (!QUOTE_RE.test(text)) return 'speaker-quoted-without-quote';
  } else if (speaker === 'assistant') {
    if (ev.role !== 'assistant') return 'speaker-vs-role';
  } else if (speaker !== 'tool') {
    if (ev.role === 'assistant' && !QUOTE_RE.test(text)) return 'speaker-vs-role';
  }
  if (speaker === 'tool' && ev.role !== 'tool') return 'speaker-vs-role';

  const negated = a.negated === true;
  const negativeText = NEG_RE.test(text);
  if (!negated && negativeText && ['state', 'complete', 'agree'].includes(a.speechAct)) return 'negation-flip';
  if (negated && !negativeText) return 'negation-flip';

  if (SUGGEST_RE.test(text) && ['decide', 'agree', 'complete'].includes(a.speechAct)) return 'suggestion-promoted';

  if (a.speechAct === 'complete' && ev.role !== 'tool') return 'complete-without-tool-evidence';
  if (a.speechAct === 'retract' && !RETRACT_RE.test(text)) return 'retract-without-marker';
  return null;
}

function recordKey(r) {
  return `${r.scope}\u0000${r.subject ?? ''}\u0000${r.predicate ?? ''}`;
}

export function createR2Sim(opts = {}) {
  const sim = createSim(opts);
  const policy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const cost = {
    configured: true,
    dailyLimitCny: 5,
    spentCny: 0,
    destinations: ['bigmodel.cn'],
    destination: 'bigmodel.cn',
    ...(opts.cost ?? {}),
  };
  const events = { ...(opts.events ?? {}) };
  const inputs = new Map(); // candidateId -> { input, events }
  const revoked = new Set();
  const records = []; // 真相层视图（含 corrected/superseded 语义）
  const holds = [];
  const decisions = new Map();
  const candidateVersions = new Map(); // candidateId → 已提交后的版本（CAS 比较面）
  const casRefreshes = [];
  const permissions = new Map();
  const counters = { extraction: 0, usage: 0, decision: 0 };
  const runs = new Map();
  let refreshCount = 0;
  let recapture = 0;

  const api = {
    policy,
    policyVersion: POLICY_VERSION,
    sim,

    addEvents(map) {
      Object.assign(events, map);
      return api;
    },

    ingest({ runKey, input, claims, provenance } = {}) {
      const prepared = (claims ?? []).map((c) => ({
        ...c,
        evidence: resolveEvidence(c.evidence, events),
      }));
      const res = sim.ingest(runKey, input, prepared, provenance);
      (res.created ?? []).forEach((cand, i) => {
        inputs.set(cand.candidateId, { input, events: { ...events }, claim: prepared[i] });
      });
      counters.extraction += 1;
      return res;
    },

    decide(candidateId, ctx = {}) {
      const cand = sim.get(candidateId);
      const meta = inputs.get(candidateId) ?? {};
      const input = meta.input ?? { sourceEpoch: 1 };
      const claim = meta.claim ?? {};
      const evidence = cand?.evidence ?? [];
      const a = claim.assertion ?? {};

      const reject = (reason) => {
        if (reason === 'evidence-unsupported' || reason === 'source-revoked') {
          sim.fail(candidateId, { failure: reason });
        } else {
          sim.reject(candidateId, { reason });
        }
        return { decision: 'reject', reason, rulesHit: [reason] };
      };
      const hold = (reason) => {
        holds.push({ candidateId, reason, unresolved: true, decidedAt: opts.clock ?? null, policyVersion: POLICY_VERSION });
        return { decision: 'hold', reason: 'unresolved', rulesHit: [reason], hold: true };
      };

      // 1. 证据存在（quote 可定位 / 事件存在 / epoch 未撤销）
      if (revoked.has(input.sourceEpoch)) return reject('source-revoked');
      if (!evidence.length || evidence.some((e) => !e.resolvable)) return reject('evidence-unsupported');

      // 2. 跨 scope 泄漏
      const key = recordKey({ scope: claim.scope, subject: a.subject, predicate: a.predicate });
      const sameSubject = records.filter((r) => r.subject === a.subject && r.predicate === a.predicate && r.status !== 'retracted');
      if (sameSubject.some((r) => r.scope !== claim.scope)) return reject('cross-scope-leak');

      // 3. 注入：正文面 = claim 全文 + 所引事件全文 + quote（只查 quote 会被干净句绕过）
      const quote = a.quote ?? '';
      const citedTexts = evidence.filter((e) => e.resolvable).map((e) => meta.events?.[e.eventId]?.text ?? '');
      const injectionSurface = [claim.claim ?? '', quote, ...citedTexts].join('\n');
      if (INJECTION_RE.test(injectionSurface)) return reject('injection-suspected');

      // 4. 身份未定
      if (!a.speaker || ctx.identityUnknown === true) return reject('identity-unknown');

      // 5. 断言框架机判
      const mismatch = assertionMismatch(claim, evidence);
      if (mismatch) return reject('assertion-mismatch');

      // 6. 未决冲突（同 scope 同主体同谓词异值）→ hold；可消解时先纠正再重新入阵
      const sameKey = records.filter((r) => recordKey(r) === key && r.status !== 'retracted' && r.value !== a.value);
      if (sameKey.length) {
        if (ctx.resolveObjection === true) {
          api.correct({
            text: quote,
            scope: claim.scope,
            subject: a.subject,
            predicate: a.predicate,
            value: a.value,
            at: opts.clock ?? evidence[0].ts,
            opId: `op-resolve-${candidateId}`,
          });
        } else {
          return hold('conflict');
        }
      }

      // 7. 配额 / 目的地 / 脱敏
      if (!cost.configured) {
        const err = new Error('E_COST_CONFIG_MISSING: 未配置成本与配额上限，拒绝发起真实模型调用');
        err.code = 'E_COST_CONFIG_MISSING';
        throw err;
      }
      if (Number(cost.spentCny) > Number(cost.dailyLimitCny)) return reject('policy-blocked');
      if (!cost.destinations.includes(cost.destination)) return reject('egress-destination-denied');
      if (ctx.redactionOk === false) return reject('redaction-failed');

      // 9. 决策=accept（只是决策，不落真相层；R7 提交在 commit）
      decisions.set(candidateId, { decision: 'accept', reason: 'policy-accept', policyVersion: POLICY_VERSION });
      return decisions.get(candidateId);
    },

    commit(candidateId, { opId, expected } = {}) {
      // recovery-required 优先于收据幂等：禁止用「看起来已完成」掩盖未决状态（09 §8）
      const pendingRecovery = sim.recovery.get(opId);
      if (pendingRecovery && !pendingRecovery.resolved) {
        const e = new Error(`E_RECOVERY_BLOCKED: opId=${opId} recovery-required，禁止自动重试`);
        e.code = 'E_RECOVERY_BLOCKED';
        throw e;
      }
      const receipt = sim.receipts.get(opId);
      if (receipt) return { kind: 'noop-receipt', recordId: receipt.truthRecordId };

      const cand = sim.get(candidateId);
      const meta = inputs.get(candidateId) ?? {};
      const input = meta.input ?? { sourceEpoch: 1 };

      if (revoked.has(input.sourceEpoch)) {
        if (cand?.workflow?.state === 'pending') sim.cancel(candidateId);
        else if (cand) cand.workflow.state = 'cancelled';
        return { kind: 'cancelled' };
      }
      if (cand?.workflow?.state === 'accepted') {
        // 并发 accept：对方已把 candidateVersion 推进 → 本提交必撞 CAS
        const prior = [...sim.receipts.values()].find((r) => r.candidateId === candidateId);
        refreshCount += 1; // 刷新重评：读回最新版本后发现目标记录已存在 → 冲突消解
        casRefreshes.push({ candidateId, opId, resolved: 'record-exists', truthRecordId: prior?.truthRecordId ?? null });
        return { kind: 'noop-receipt', recordId: prior?.truthRecordId ?? null, refreshed: true };
      }

      const evidence = cand?.evidence ?? [];
      // CAS 循环：expected 与当前不符 → 有限次刷新重评，仍不符 → hold
      let attempt = 0;
      for (;;) {
        const current = {
          candidateVersion: candidateVersions.get(candidateId) ?? 1,
          evidenceHash: evidence[0]?.hash,
          expectedTruthRevision: sim.truthRevision,
        };
        const conflict =
          expected &&
          ((expected.candidateVersion != null && expected.candidateVersion !== current.candidateVersion) ||
            (expected.evidenceHash != null && expected.evidenceHash !== current.evidenceHash) ||
            (expected.expectedTruthRevision != null && expected.expectedTruthRevision !== current.expectedTruthRevision));
        if (!conflict) break;
        attempt += 1;
        if (attempt > policy.maxCasRefresh) {
          holds.push({ candidateId, reason: 'cas-revision-mismatch', unresolved: true, policyVersion: POLICY_VERSION });
          return { kind: 'hold' };
        }
        refreshCount = attempt;
      }

      const rec = sim.accept(candidateId, {
        acceptOpId: opId,
        candidateVersion: 1,
        evidenceHash: evidence[0]?.hash,
        expectedTruthRevision: sim.truthRevision, // 与上面的 CAS 循环同源（同一同步段内读取）
        decidedBy: POLICY_VERSION,
      });

      const a = meta.claim?.assertion ?? {};
      records.push({
        recordId: rec.truthRecordId,
        opId,
        candidateId,
        claim: meta.claim?.claim ?? cand.claim,
        scope: meta.claim?.scope ?? cand.scope,
        subject: a.subject,
        predicate: a.predicate,
        value: a.value,
        speaker: a.speaker,
        status: 'active',
        validFrom: a.observedAt ?? evidence[0]?.ts ?? null,
        validTo: null,
        sourceEpoch: input.sourceEpoch,
        trust: sim.truth.get(rec.truthRecordId)?.trust ?? 'T2',
      });
      permissions.set(rec.truthRecordId, { allowed: false, reason: 't2-not-capable' });
      candidateVersions.set(candidateId, (candidateVersions.get(candidateId) ?? 1) + 1);
      return { kind: 'accepted', recordId: rec.truthRecordId, revision: rec.revision, candidateVersion: candidateVersions.get(candidateId) };
    },

    truthRecords() {
      return [...sim.truth.values()];
    },

    trustWrites() {
      return [];
    },

    packInputs() {
      return records
        .filter((r) => r.status === 'active' && !revoked.has(r.sourceEpoch))
        .map((r) => ({ candidateId: r.candidateId, recordId: r.recordId, claim: r.claim, sourceMark: `dsh-transcript:test#epoch${r.sourceEpoch}` }));
    },

    permissionCheck(recordId) {
      return permissions.get(recordId) ?? { allowed: false, reason: 't2-not-capable' };
    },

    holdAnnotations() {
      return [...holds];
    },

    queueAssets() {
      return [];
    },

    addRecord({ scope, subject, predicate, value, status = 'active' }) {
      const rec = { recordId: `rec-${records.length + 1}`, scope, subject, predicate, value, status, validFrom: null, validTo: null, claim: `${subject} ${predicate} ${value}` };
      records.push(rec);
      permissions.set(rec.recordId, { allowed: false, reason: 't2-not-capable' });
      return rec;
    },

    query({ asOf } = {}) {
      const visible = records.filter((r) => r.status !== 'retracted' && r.status !== 'quoted');
      const current = new Map();
      for (const r of visible) {
        if (asOf) {
          const startOk = !r.validFrom || r.validFrom <= asOf;
          const endOk = !r.validTo || asOf < r.validTo;
          if (startOk && endOk) current.set(recordKey(r), r);
        } else if (!r.validTo) {
          current.set(recordKey(r), r);
        }
      }
      return [...current.values()];
    },

    correct({ text = '', kind, scope, subject, predicate, value, at, opId }) {
      const resolvedKind = kind ?? (RETRACTION_INSTRUCTION_RE.test(text) ? 'retraction' : QUOTE_RE.test(text) ? 'quote' : ASSISTANT_CLAIM_RE.test(text) ? 'assistant-claim' : 'correction');
      const current = records.filter((r) => r.scope === scope && r.subject === subject && r.predicate === predicate && !r.validTo && r.status === 'active');

      if (resolvedKind === 'quote') {
        return { kind: 'quote', speaker: 'quoted', recordId: null };
      }
      if (resolvedKind === 'assistant-claim') {
        return { kind: 'assistant-claim', speaker: 'assistant', recordId: null };
      }
      if (resolvedKind === 'retraction') {
        // 撤销最近一次纠正：纠正记录转 retracted，被它顶掉的原记录重新可见
        const corrected = records.filter((r) => r.scope === scope && r.subject === subject && r.predicate === predicate && r.supersedes && r.status === 'active' && !r.retracted).at(-1);
        if (!corrected) return { kind: 'retraction', recordId: null };
        corrected.status = 'retracted';
        corrected.retracted = true;
        corrected.validTo = at;
        const restored = records.find((r) => r.recordId === corrected.supersedes);
        if (restored) restored.validTo = null;
        return { kind: 'retraction', recordId: corrected.recordId, restoredValue: restored?.value ?? null };
      }

      const old = current.at(-1);
      if (old) old.validTo = at;
      const rec = {
        recordId: `rec-corr-${opId ?? records.length + 1}`,
        opId,
        scope,
        subject,
        predicate,
        value,
        status: 'active',
        validFrom: at,
        validTo: null,
        claim: value,
        sourceEpoch: 1,
        supersedes: old?.recordId ?? null,
      };
      records.push(rec);
      permissions.set(rec.recordId, { allowed: false, reason: 't2-not-capable' });
      return { kind: 'correction', superseded: old?.recordId ?? null, recordId: rec.recordId };
    },

    revokeEpoch(epoch) {
      revoked.add(epoch);
      for (const r of records) if (r.sourceEpoch === epoch) r.revoked = true;
      return { revoked: 1 };
    },

    recaptureCalls() {
      return recapture;
    },

    refreshCount() {
      return refreshCount;
    },

    casRefreshes() {
      return [...casRefreshes];
    },

    eventCounts() {
      return { ...counters, extraction: counters.extraction };
    },

    // 09 §9：extraction/usage/decision 三类事件缺一即 run 不可用于效果结论
    runStatus(runId) {
      const run = runs.get(runId) ?? {};
      const missing = [];
      if (!((run.extractions ?? counters.extraction) > 0)) missing.push('extraction');
      if (!run.usage) missing.push('usage');
      if (!((run.decisions ?? 0) > 0)) missing.push('decision');
      const ok = missing.length === 0;
      return {
        runId,
        status: ok ? 'success' : 'incomplete',
        verdictAllowed: ok,
        missing,
        // 与 07 的枚举映射（09 §9）：incomplete → missing
        observabilityStatus: ok ? 'success' : 'missing',
      };
    },

    recordUsage(runId, usage) {
      const run = runs.get(runId) ?? {};
      runs.set(runId, { ...run, usage });
      counters.usage += 1;
    },

    recordDecisionEvent(runId, event) {
      const run = runs.get(runId) ?? {};
      runs.set(runId, { ...run, decisions: (run.decisions ?? 0) + 1, lastDecision: event });
      counters.decision += 1;
    },

    reconcile(opId) {
      const receipt = sim.receipts.get(opId);
      const truth = [...sim.truth.values()].find((t) => t.opId === opId);
      if (receipt && truth) {
        if (receipt.revision != null && truth.revision != null && receipt.revision !== truth.revision) {
          sim.markRecoveryRequired(opId, { reason: 'receipt-revision-mismatch' });
          return { kind: 'recovery-required', reason: 'receipt-revision-mismatch' };
        }
        return { kind: 'noop-receipt', recordId: receipt.truthRecordId };
      }
      if (!receipt && !truth) return { kind: 'replay-allowed' };
      if (!receipt && truth) {
        sim.receipts.set(opId, { truthRecordId: truth.candidateId, revision: truth.revision });
        return { kind: 'receipt-backfilled', recordId: truth.candidateId };
      }
      sim.markRecoveryRequired(opId, { reason: 'receipt-without-truth' });
      return { kind: 'recovery-required', reason: 'receipt-without-truth' };
    },

    forceReceiptDrift(opId) {
      const receipt = sim.receipts.get(opId);
      if (receipt) receipt.revision = (receipt.revision ?? 0) + 99;
      return receipt ?? null;
    },
  };

  return api;
}
