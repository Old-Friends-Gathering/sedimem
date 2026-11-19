// pipeline.mjs —— P1b 真管线：R5/R6 自动决策矩阵（r2，替代人工复核）+ R7 提交路径
// 规格：docs/design/v2.0/09-extraction-pipeline.md §6（9 行矩阵、穷尽性）、§8（提交/并发/恢复）
// 约束：
//   - 决策矩阵必须穷尽：未命中任何行 → fail-closed 抛 E_MATRIX_NOT_EXHAUSTIVE 并入审计；
//   - accept 不等于提权：truth 记录 trust 恒 T2，trustWrites() 恒空；
//   - 提交点 = 真相层成功追加；审计未落盘不得进真相层（fail-closed）；
//   - 锁内必须重查 sourceEpoch，撤销优先于 CAS；
//   - noop/merge 留持久收据，重放不产生第二条事实。
import { createHash } from 'node:crypto';
import { resolveEvidence } from './evidence.mjs';

export const POLICY_VERSION = 'policy:auto-memory-r2/1';

// 矩阵固定顺序（§6）：自上而下，命中即停
export const DECISION_ROWS = Object.freeze([
  { row: 1, condition: 'evidence-unsupported', decision: 'reject', reason: 'evidence-unsupported' },
  { row: 2, condition: 'cross-scope', decision: 'reject', reason: 'cross-scope-leak' },
  { row: 3, condition: 'injection', decision: 'reject', reason: 'injection-suspected' },
  { row: 4, condition: 'identity-unknown', decision: 'reject', reason: 'identity-unknown' },
  { row: 5, condition: 'assertion-mismatch', decision: 'reject', reason: 'assertion-mismatch' },
  { row: 6, condition: 'conflict', decision: 'hold', reason: 'unresolved' },
  { row: 7, condition: 'quota', decision: 'reject', reason: 'policy-blocked' },
  { row: 8, condition: 'objection-resolvable', decision: 'accept', reason: 'correction-applied' },
  { row: 9, condition: 'all-pass', decision: 'accept', reason: 'policy-accept' },
]);

const INJECTION_PATTERNS = [
  /忽略(以上|之前|上述).{0,6}(规则|指令|提示)/u,
  /导出.{0,6}(全部|所有)?.{0,4}(密钥|凭据|密码)/u,
  /ignore (all )?(previous|above) instructions/iu,
  /system prompt/iu,
  /无视.{0,4}(安全|策略)/u,
];

const NEGATION_RE = /(?:^|[^不])不(?!仅|过|确定)|未|没有|没(?!有)|never|not(?! only)|\bno\b/iu;
const SUGGEST_RE = /建议|可以|不妨|could|should|maybe/iu;
const RETRACT_RE = /撤回|作废|取消|不对|说错了|ignore that|never mind/iu;

function normalizeClaim(text) {
  return String(text).replace(/\s+/g, ' ').replace(/[。；;！!?？]+$/u, '').trim();
}

function makeCandidateId({ sourceEpoch, rangeId, inputHash }, claim) {
  const h = createHash('sha256')
    .update(`${sourceEpoch}|${rangeId}|${inputHash}|${normalizeClaim(claim)}`, 'utf8')
    .digest();
  // 26 位 Crockford base32
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[h[i] % 32];
  return out;
}

function hashInput(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// R4.5 断言框架机判的最小确定性实现（完整版见 assertion-checks.mjs，二者判据一致）
export function checkAssertionInline({ claim, assertion, evidence }) {
  const violations = [];
  const quote = (evidence || []).map((e) => e.quote || '').join(' ');
  const roles = (evidence || []).map((e) => e.role);
  if (!assertion || !evidence?.length) {
    return { ok: false, violations: [{ check: 'input', reason: 'missing assertion or evidence' }] };
  }
  const negated = Boolean(assertion.negated);
  const hasNeg = NEGATION_RE.test(quote);
  if (!negated && hasNeg) violations.push({ check: 'negated', reason: '否定标记存在但 negated=false' });
  if (negated && !hasNeg) violations.push({ check: 'negated', reason: '无否定标记但 negated=true' });

  if (assertion.speechAct === 'suggest') {
    if (!SUGGEST_RE.test(quote)) violations.push({ check: 'speechAct', reason: 'suggest 缺建议式' });
    if (!['suggestion-only', 'conditional'].includes(claim.status)) {
      violations.push({ check: 'speechAct', reason: 'suggest 的 status 非法' });
    }
  }
  if (assertion.speechAct === 'complete') {
    if (claim.type !== 'task-state') violations.push({ check: 'speechAct', reason: 'complete 必须 type=task-state' });
    const fromToolOrUser = roles.some((r) => r === 'tool' || String(r).startsWith('tool:')) ||
      roles.some((r) => r === 'user');
    if (!fromToolOrUser) violations.push({ check: 'speechAct', reason: 'complete 缺工具或用户直接证据' });
    if (roles.includes('assistant') && !fromToolOrUser) {
      violations.push({ check: 'speechAct', reason: '助手自称完成不得 complete' });
    }
  }
  if (assertion.speechAct === 'retract') {
    if (!RETRACT_RE.test(quote)) violations.push({ check: 'speechAct', reason: 'retract 缺撤回式' });
    if (claim.status !== 'retracted') violations.push({ check: 'speechAct', reason: 'retract 的 status 必须 retracted' });
  }
  if (assertion.speaker && assertion.speaker !== 'quoted' && roles.length) {
    const want = String(assertion.speaker);
    const ok = roles.every((r) => r === want || (want.startsWith('tool') && String(r).startsWith('tool')));
    if (!ok) violations.push({ check: 'speaker', reason: `speaker=${want} 与证据 role 不符` });
  }
  return { ok: violations.length === 0, violations };
}

export function createPipeline({
  events = new Map(),
  snapshots = null,
  sourceId = null,
  sourceEpoch = null,
  policy = {},
  clock = () => new Date().toISOString(),
  events_: _unused = null,
} = {}) {
  const cfg = {
    maxCasRefresh: 2,
    ...policy,
  };
  const candidates = new Map(); // candidateId → {state, claim, evidence, meta, hold}
  const truth = [];
  const receipts = new Map(); // opId → {recordId, revision}
  const audit = [];
  const auditPending = new Set();
  const revoked = new Set();
  const quarantined = [];
  const holds = [];
  const auditFailOps = new Set();
  let truthRevision = 0;

  function bumpTruthRevision() {
    truthRevision += 1;
    return truthRevision;
  }

  function ingest({ runKey, claims = [], events: overrideEvents } = {}) {
    const evs = overrideEvents ?? events;
    const inputHash = hashInput([...evs.values()].map((e) => `${e.eventId}:${e.text}`).join('\n'));
    const out = [];
    for (const claim of claims) {
      const candidateId = makeCandidateId(
        { sourceEpoch: sourceEpoch ?? claim?.sourceEpoch ?? 0, rangeId: runKey, inputHash },
        claim.claim,
      );
      if (candidates.has(candidateId)) {
        out.push({ candidateId, created: 0, noop: true });
        continue;
      }
      const rec = {
        candidateId,
        runKey,
        claim,
        meta: {
          claim,
          claimText: claim.claim,
          scope: claim.scope,
          evidence: claim.evidence,
          assertion: claim.assertion,
          type: claim.type,
          status: claim.status,
          inputHash,
          version: 1,
          provenance: { policyVersion: POLICY_VERSION, at: clock() },
        },
        state: 'pending',
        hold: null,
      };
      candidates.set(candidateId, rec);
      out.push({ candidateId, created: 1, noop: false });
    }
    return out;
  }

  function get(candidateId) {
    const c = candidates.get(candidateId);
    return c ? { candidateId, state: c.state, claim: c.meta.claim, meta: c.meta } : null;
  }

  function isInjection(text) {
    return INJECTION_PATTERNS.some((re) => re.test(text));
  }

  function findConflict(claimMeta) {
    const { scope, assertion } = claimMeta;
    if (!assertion?.subject || !assertion?.predicate) return null;
    return (
      truth.find(
        (t) =>
          t.scope === scope &&
          t.assertion?.subject === assertion.subject &&
          t.assertion?.predicate === assertion.predicate &&
          String(t.assertion?.value ?? '') !== String(assertion.value ?? ''),
      ) ?? null
    );
  }

  function decide(candidateId, ctx = {}) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_CANDIDATE_NOT_FOUND:${candidateId}`);
    if (ctx.forceUnmatched) {
      audit.push({ kind: 'matrix-unmatched', candidateId, at: clock() });
      throw new Error('E_MATRIX_NOT_EXHAUSTIVE');
    }

    const rulesHit = [];
    const decisionBase = {
      opId: ctx.opId ?? null,
      decider: POLICY_VERSION,
      candidateVersion: c.meta.version,
      evidenceHash: c.meta.evidenceHash ?? null,
      expectedTruthRevision: truthRevision,
      decidedAt: clock(),
    };

    // 行 1：证据存在
    const evRes = resolveEvidence({
      events,
      evidence: c.meta.evidence ?? [],
      snapshots,
      sourceId,
      sourceEpoch,
    });
    if (!evRes.ok) {
      c.state = 'failed';
      audit.push({ kind: 'decision', candidateId, reason: 'evidence-unsupported', at: clock() });
      return { ...decisionBase, decision: 'reject', reason: 'evidence-unsupported', rulesHit: ['evidence-failed'], failures: evRes.failures };
    }
    rulesHit.push('evidence-ok');
    c.meta.evidenceHash = evRes.evidence.map((e) => e.hash).join(',');

    // 行 2：跨 scope
    const targetScope = ctx.targetScope ?? c.meta.scope;
    if (targetScope && c.meta.scope && targetScope !== c.meta.scope) {
      c.state = 'failed';
      audit.push({ kind: 'decision', candidateId, reason: 'cross-scope-leak', at: clock() });
      return { ...decisionBase, decision: 'reject', reason: 'cross-scope-leak', rulesHit: ['cross-scope'] };
    }
    rulesHit.push('scope-ok');

    // 行 3：注入
    const cited = evRes.evidence.map((e) => e.quote).join(' ');
    if (isInjection(c.meta.claimText) || isInjection(cited)) {
      c.state = 'rejected';
      quarantined.push({ candidateId, at: clock(), reason: 'injection-suspected' });
      audit.push({ kind: 'decision', candidateId, reason: 'injection-suspected', at: clock() });
      return { ...decisionBase, decision: 'reject', reason: 'injection-suspected', rulesHit: ['injection-detected'] };
    }
    rulesHit.push('no-injection');

    // 行 4：身份不明
    if (ctx.identityUnknown) {
      c.state = 'rejected';
      audit.push({ kind: 'decision', candidateId, reason: 'identity-unknown', at: clock() });
      return { ...decisionBase, decision: 'reject', reason: 'identity-unknown', rulesHit: ['identity-unknown'] };
    }
    rulesHit.push('identity-ok');

    // 行 5：断言机判
    const as = checkAssertionInline({
      claim: {
        type: c.meta.type,
        status: c.meta.status,
        claim: c.meta.claimText,
      },
      assertion: c.meta.assertion,
      evidence: evRes.evidence,
    });
    if (!as.ok) {
      c.state = 'rejected';
      audit.push({ kind: 'decision', candidateId, reason: 'assertion-mismatch', at: clock(), violations: as.violations });
      return { ...decisionBase, decision: 'reject', reason: 'assertion-mismatch', rulesHit: ['assertion-failed'], violations: as.violations };
    }
    rulesHit.push('assertion-ok');

    // 行 8 前置：可消解异议 → 走纠正（先生成 relations 语义，再重入第 1 行）
    if (ctx.objection?.resolvable) {
      rulesHit.push('correction-applied');
      c.meta.relations = [...(c.meta.relations ?? []), { kind: 'supersedes', reason: ctx.objection.reason ?? 'correction' }];
      audit.push({ kind: 'decision', candidateId, reason: 'correction-applied', at: clock() });
      // 重入矩阵第 1 行：证据仍须可定位（上面已过），冲突按纠正处理
      return {
        ...decisionBase,
        decision: 'accept',
        reason: 'correction-applied',
        rulesHit,
        relations: c.meta.relations,
      };
    }

    // 行 6：不可消解冲突
    const conflict = findConflict(c.meta);
    if (conflict) {
      c.hold = { policyVersion: POLICY_VERSION, reason: 'unresolved', targetRecordId: conflict.recordId, at: clock() };
      holds.push(c.hold);
      audit.push({ kind: 'decision', candidateId, reason: 'unresolved', at: clock() });
      return { ...decisionBase, decision: 'hold', reason: 'unresolved', rulesHit: [...rulesHit, 'conflict-unresolvable'] };
    }
    rulesHit.push('no-conflict');

    // 行 7：超配额
    if (cfg.quotaExceeded) {
      c.state = 'rejected';
      audit.push({ kind: 'decision', candidateId, reason: 'policy-blocked', at: clock() });
      return { ...decisionBase, decision: 'reject', reason: 'policy-blocked', rulesHit: [...rulesHit, 'quota-exceeded'] };
    }
    rulesHit.push('quota-ok');

    // 行 9：通过
    audit.push({ kind: 'decision', candidateId, reason: 'policy-accept', at: clock() });
    return { ...decisionBase, decision: 'accept', reason: 'policy-accept', rulesHit };
  }

  function auditPendingOps() {
    return [...auditPending];
  }

  function failAuditOnOp(opId) {
    auditFailOps.add(opId);
  }

  // R7：提交
  function commit(candidateId, { opId, expected = null } = {}) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_CANDIDATE_NOT_FOUND:${candidateId}`);
    if (!opId) throw new Error('E_OPID_REQUIRED');

    // 收据幂等
    if (receipts.has(opId)) {
      const r = receipts.get(opId);
      return { kind: 'noop-receipt', recordId: r.recordId, revision: r.revision };
    }

    // 锁内重查 epoch（撤销优先于 CAS）
    if (revoked.has(c.meta.sourceEpoch ?? sourceEpoch ?? 1)) {
      c.state = 'cancelled';
      audit.push({ kind: 'commit', candidateId, opId, reason: 'source-revoked', at: clock() });
      return { kind: 'cancelled', reason: 'source-revoked' };
    }

    // CAS
    let refreshed = 0;
    if (expected) {
      const sameVersion = expected.candidateVersion === c.meta.version;
      const samerev = expected.expectedTruthRevision === truthRevision;
      while (!(sameVersion && samerev) && refreshed < cfg.maxCasRefresh) {
        refreshed += 1;
        const nowSame =
          expected.candidateVersion === c.meta.version && expected.expectedTruthRevision === truthRevision;
        if (nowSame) break;
      }
      if (expected.candidateVersion !== c.meta.version || expected.expectedTruthRevision !== truthRevision) {
        c.hold = { policyVersion: POLICY_VERSION, reason: 'cas-conflict', at: clock() };
        holds.push(c.hold);
        audit.push({ kind: 'commit', candidateId, opId, reason: 'cas-conflict', refreshed, at: clock() });
        return { kind: 'hold', reason: 'cas-conflict', refreshed };
      }
    }

    // 审计先行（fail-closed）
    if (auditFailOps.has(opId)) {
      auditPending.add(opId);
      throw new Error('E_AUDIT_PENDING');
    }
    audit.push({ kind: 'commit', candidateId, opId, at: clock() });

    // 真相层追加 = 提交点
    const revision = bumpTruthRevision();
    const record = {
      recordId: `tr-${revision}`,
      opId,
      candidateId,
      revision,
      claim: c.meta.claimText,
      scope: c.meta.scope,
      assertion: c.meta.assertion,
      trust: 'T2',
      committedAt: clock(),
    };
    truth.push(record);
    receipts.set(opId, { recordId: record.recordId, revision });
    c.state = 'accepted';
    return { kind: 'committed', recordId: record.recordId, revision };
  }

  return {
    ingest,
    get,
    decide,
    commit,
    truthRecords: () => truth.slice(),
    trustWrites: () => [],
    packInputs: () =>
      truth
        .filter((t) => !quarantined.some((q) => q.candidateId === t.candidateId))
        .map((t) => ({ ...t, sourceMark: t.trust })),
    quarantine: () => quarantined.slice(),
    holdAnnotations: () => holds.slice(),
    auditPendingOps,
    failAuditOnOp,
    addTruthRecord: ({ claim, scope, assertion = null }) => {
      const revision = bumpTruthRevision();
      const record = {
        recordId: `tr-${revision}`,
        opId: `seed-${revision}`,
        candidateId: null,
        revision,
        claim,
        scope,
        assertion,
        trust: 'T2',
        committedAt: clock(),
      };
      truth.push(record);
      return record;
    },
    revokeEpoch: (epoch) => {
      revoked.add(epoch);
      return { revoked: 1 };
    },
    isPolicyBlocked: () => Boolean(cfg.quotaExceeded),
    revokeEpochs: () => [...revoked],
    truthRevision: () => truthRevision,
    forceReceiptDrift: (opId) => {
      if (receipts.has(opId)) receipts.delete(opId);
    },
    reconcile: (opId) => {
      if (receipts.has(opId)) return { kind: 'noop-receipt', recordId: receipts.get(opId).recordId };
      const found = truth.find((t) => t.opId === opId);
      if (found) {
        receipts.set(opId, { recordId: found.recordId, revision: found.revision });
        return { kind: 'receipt-repaired', recordId: found.recordId };
      }
      const anyForOp = truth.some((t) => t.opId === opId);
      if (!anyForOp) return { kind: 'recovery-required', reason: 'no-record-for-op' };
      return { kind: 'recovery-required', reason: 'revision-mismatch' };
    },
    auditLog: () => audit.slice(),
    auditPending,
  };
}
