// pipeline.mjs —— P1b 真管线：R5/R6 自动决策矩阵（r2）+ R7 提交路径
// 规格：docs/design/v2.0/09-extraction-pipeline.md §6（9 行矩阵、命中即停、穷尽性）、§8（提交/并发/恢复）
// 设计要点（对应 B7 对抗审核 B1/M1–M10 的落地）：
//   - candidateId 仍按 01 §3.1 内容四元组派生，但**写入幂等按语义键去重**（跨 runKey 同 claim → noop）；
//   - 行 2/4 用真实信号（来源绑定 scope、证据 role），不依赖调用方传 ctx 后门；
//   - 行 8（可消解异议）在行 1–7 之后，且**真正重入**矩阵一次；
//   - R3 查 epoch 撤销；R7 锁内再查一次，撤销优先于 CAS；
//   - CAS 三元组含 evidenceHash；刷新=重跑决策并递增 candidateVersion，超限转 hold；
//   - audit-pending 期间禁止任何新提交（fail-closed），reconcile 后解除；
//   - accept 不提权：truth 记录恒 T2，trustWrites() 恒空。
import { createHash } from 'node:crypto';
import { resolveEvidence } from './evidence.mjs';
import { generateObjection } from './objection.mjs';
import { matchCorrection } from './corrections.mjs';
import { checkAssertion } from './assertion-checks.mjs';

export const POLICY_VERSION = 'policy:auto-memory-r2/1';

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

// m4：决策必须来自矩阵常量（改表即改行为，T-C1..T-C9 会变红）
export const rowDecision = (n) => DECISION_ROWS[n - 1].decision;

const INJECTION_PATTERNS = [
  /忽略(以上|之前|上述).{0,6}(规则|指令|提示)/u,
  /导出.{0,6}(全部|所有)?.{0,4}(密钥|凭据|密码)/u,
  /ignore (all )?(previous|above) instructions/iu,
  /system prompt/iu,
  /无视.{0,4}(安全|策略)/u,
];

const KNOWN_ROLES = new Set(['user', 'assistant', 'tool']);

function normalizeClaim(text) {
  return String(text).replace(/\s+/gu, ' ').replace(/[。；;！!?？]+$/u, '').trim();
}

function makeCandidateId({ sourceEpoch, rangeId, inputHash }, claim) {
  const h = createHash('sha256')
    .update(`${sourceEpoch}|${rangeId}|${inputHash}|${normalizeClaim(claim)}`, 'utf8')
    .digest();
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i += 1) out += alphabet[h[i] % 32];
  return out;
}

function hashInput(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// 语义键：跨 runKey 幂等与去重的依据（不含 model/configHash，也不含 rangeId）
export function semanticKey(meta) {
  const a = meta.assertion ?? {};
  return [
    meta.scope ?? '',
    a.subject ?? '',
    a.predicate ?? '',
    String(a.value ?? ''),
    meta.type ?? '',
    meta.status ?? '',
    a.speechAct ?? '',
    normalizeClaim(meta.claimText ?? ''),
  ].join('\u0000');
}

function roleIsKnown(role) {
  if (!role) return false;
  if (role.startsWith('tool:')) return true;
  return KNOWN_ROLES.has(role);
}

export function createPipeline({
  events = new Map(),
  snapshots = null,
  sourceId = null,
  sourceEpoch = null,
  sourceScope = null,
  policy = {},
  clock = () => new Date().toISOString(),
} = {}) {
  const cfg = { maxCasRefresh: 2, quotaExceeded: false, allowCallerObjection: false, allowReplayObjection: false, ...policy };

  const candidates = new Map();
  const truth = [];
  const receipts = new Map(); // opId → {recordId, revision}
  const audit = [];
  const auditPending = new Set();
  const revoked = new Set();
  const quarantined = [];
  const holds = [];

  let truthRevision = 0;
  let seq = 0;

  const auditOf = (entry) => {
    seq += 1;
    audit.push({ seq, at: clock(), ...entry });
  };

  function ingest({ runKey, claims = [] }) {
    const inputHash = hashInput([...events.values()].map((e) => `${e.eventId}:${e.text}`).join('\n'));
    const out = [];
    for (const claim of claims) {
      const meta = {
        claim,
        claimText: claim.claim,
        scope: claim.scope,
        evidence: claim.evidence,
        assertion: claim.assertion,
        type: claim.type,
        status: claim.status,
        relations: claim.relations ?? [],
        sourceEpoch: claim.sourceEpoch ?? sourceEpoch ?? 0,
        inputHash,
        version: 1,
        provenance: { runKey, policyVersion: POLICY_VERSION, at: clock() },
      };
      const key = semanticKey(meta);

      // 已提交的同语义 claim → noop(already-committed)；已有候选 → noop（跨 runKey 幂等，§2）
      const inTruth = truth.find((t) => t.key === key);
      if (inTruth) {
        out.push({ candidateId: inTruth.candidateId, created: 0, noop: true, noopReason: 'already-committed' });
        continue;
      }
      const dup = [...candidates.values()].find((c) => c.key === key);
      if (dup) {
        out.push({ candidateId: dup.candidateId, created: 0, noop: true });
        continue;
      }

      const candidateId = makeCandidateId({ sourceEpoch: meta.sourceEpoch, rangeId: runKey, inputHash }, claim.claim);
      const rec = { candidateId, key, meta, state: 'pending', hold: null };
      candidates.set(candidateId, rec);
      out.push({ candidateId, created: 1, noop: false });
    }
    return out;
  }

  const get = (candidateId) => {
    const c = candidates.get(candidateId);
    return c ? { candidateId, state: c.state, claim: c.meta.claim, meta: c.meta } : null;
  };

  const isInjection = (text) => INJECTION_PATTERNS.some((re) => re.test(text));

  function findConflict(meta) {
    const a = meta.assertion ?? {};
    if (!a.subject || !a.predicate) return null;
    return (
      truth.find(
        (t) =>
          t.scope === meta.scope &&
          t.assertion?.subject === a.subject &&
          t.assertion?.predicate === a.predicate &&
          String(t.assertion?.value ?? '') !== String(a.value ?? ''),
      ) ?? null
    );
  }

  // 单次矩阵求值（不含行 8）；返回 {decision, reason, rulesHit, ...}
  function evaluate(c, { correctionApplied = false } = {}) {
    const rulesHit = [];
    const meta = c.meta;

    // 行 1：证据存在 + R3 查 epoch 撤销
    if (revoked.has(meta.sourceEpoch)) {
      return { row: 1, decision: rowDecision(1), reason: 'evidence-unsupported', rulesHit: ['source-revoked'], failures: [{ reason: 'source-revoked' }] };
    }
    const evRes = resolveEvidence({
      events,
      evidence: meta.evidence ?? [],
      snapshots,
      sourceId,
      sourceEpoch: meta.sourceEpoch,
    });
    if (!evRes.ok) {
      return { row: 1, decision: rowDecision(1), reason: 'evidence-unsupported', rulesHit: ['evidence-failed'], failures: evRes.failures };
    }
    rulesHit.push('evidence-ok');
    meta.evidenceHash = evRes.evidence.map((e) => `${e.eventId}@${e.span.start}-${e.span.end}#${e.hash}`).join(',');

    // 行 2：跨 scope（真实判据：来源绑定的 scope）
    if (sourceScope && meta.scope && meta.scope !== sourceScope) {
      return { row: 2, decision: rowDecision(2), reason: 'cross-scope-leak', rulesHit: ['cross-scope'] };
    }
    const foreign = truth.find((t) => t.key !== c.key && t.scope !== meta.scope && t.assertion?.subject === meta.assertion?.subject && t.assertion?.predicate === meta.assertion?.predicate);
    if (foreign) {
      return { row: 2, decision: rowDecision(2), reason: 'cross-scope-leak', rulesHit: ['cross-scope-foreign-subject'], detail: foreign.recordId };
    }
    rulesHit.push('scope-ok');

    // 行 3：注入
    const cited = evRes.evidence
      .map((e) => `${e.quote} ${events.get(e.eventId)?.text ?? ''}`)
      .join(' ');
    if (isInjection(meta.claimText) || isInjection(cited)) {
      return { row: 3, decision: rowDecision(3), reason: 'injection-suspected', rulesHit: ['injection-detected'] };
    }
    rulesHit.push('no-injection');

    // 行 4：身份/角色不明（真实判据：证据 role）
    const unknown = evRes.evidence.filter((e) => !roleIsKnown(e.role));
    if (unknown.length) {
      return { row: 4, decision: rowDecision(4), reason: 'identity-unknown', rulesHit: ['identity-unknown'], detail: unknown.map((u) => u.eventId) };
    }
    rulesHit.push('identity-ok');

    // 行 5：断言机判（权威实现 assertion-checks.mjs）
    const as = checkAssertion({
      claim: { claim: meta.claimText, type: meta.type, status: meta.status, assertion: meta.assertion },
      assertion: meta.assertion,
      evidence: evRes.evidence,
    });
    if (!as.ok) {
      return { row: 5, decision: rowDecision(5), reason: 'assertion-mismatch', rulesHit: ['assertion-failed'], violations: as.violations };
    }
    rulesHit.push('assertion-ok');

    // 行 6：冲突（若已有纠正关系指向该记录则可消解 → 继续往下走）
    const conflict = findConflict(meta);
    if (conflict) {
      const superseded = (meta.relations ?? []).some(
        (rel) => rel.kind === 'supersedes' && (rel.targetRecordId === conflict.recordId || rel.target === conflict.recordId),
      );
      if (!superseded) {
        return { row: 6, decision: rowDecision(6), reason: 'unresolved', rulesHit: [...rulesHit, 'conflict-unresolvable'], conflict: conflict.recordId };
      }
      rulesHit.push('conflict-superseded');
    } else {
      rulesHit.push('no-conflict');
    }

    // 行 7：配额
    if (cfg.quotaExceeded) {
      return { row: 7, decision: rowDecision(7), reason: 'policy-blocked', rulesHit: [...rulesHit, 'quota-exceeded'] };
    }
    rulesHit.push('quota-ok');

    // 带 supersedes 关系的候选本身即修订路径，reason 应如实体现（09 §6 行 8）
    const correctedByRelation = (meta.relations ?? []).some((rel) => rel.kind === 'supersedes');
    if (correctionApplied || correctedByRelation) rulesHit.push('correction-applied');
    return {
      row: correctionApplied || correctedByRelation ? 8 : 9,
      decision: rowDecision(correctionApplied || correctedByRelation ? 8 : 9),
      reason: correctionApplied || correctedByRelation ? 'correction-applied' : 'policy-accept',
      rulesHit,
    };
  }

  // R4 异议生产入口：默认由生成器独立核对；调用方注入仅测试/回放（09 §5）
  function resolveObjection(c, ctx) {
    if (ctx.replayObjection !== undefined) {
    if (!cfg.allowReplayObjection) throw new Error('E_REPLAY_NOT_ALLOWED');
    return ctx.replayObjection;
  }
    if (ctx.objection !== undefined && cfg.allowCallerObjection) return ctx.objection;
    const meta = c.meta;
    const { objection } = generateObjection({
      claim: {
        claim: meta.claimText,
        scope: meta.scope,
        assertion: meta.assertion,
        evidence: (meta.evidence ?? []).map((e) => ({ eventId: e.eventId, quote: e.quote ?? '', ts: events.get(e.eventId)?.ts ?? null })),
      },
      truth: truth.map((t) => ({ recordId: t.recordId, scope: t.scope, assertion: t.assertion })),
      sourceScope,
    });
    return objection;
  }

  // 聊天纠正入口（09 §7）：matcher → 候选形态 → 走矩阵 → 由调用方决定提交
  function correct({ text, scope, role = 'user', evidence = [], runKey = 'chat-correction', opId = null }) {
    const m = matchCorrection({
      text,
      truth: truth.map((t) => ({ recordId: t.recordId, scope: t.scope, claim: t.claim, assertion: t.assertion })),
      scope,
      role,
    });
    if (!m.kind) return { kind: null, matcher: m.matcher, targetRecordId: m.targetRecordId };
    const target = m.targetRecordId ? truth.find((t) => t.recordId === m.targetRecordId) ?? null : null;
    const assertionBase = target?.assertion ? { ...target.assertion } : {};

    // 不可判定：只落 hold 注解，不进矩阵、不产生候选
    if (m.kind === 'disputed') {
      holds.push({ policyVersion: POLICY_VERSION, reason: 'unresolved', kind: 'disputed', targetRecordId: m.targetRecordId, at: clock() });
      return { kind: 'disputed', decision: 'hold', reason: 'unresolved', targetRecordId: m.targetRecordId };
    }

    let claim;
    if (m.kind === 'correction') {
      claim = {
        claim: text,
        scope,
        type: target?.type ?? 'fact',
        status: 'active',
        assertion: { ...assertionBase, value: m.newValue },
        relations: target ? [{ kind: 'supersedes', targetRecordId: target.recordId }] : [],
        evidence,
      };
    } else if (m.kind === 'retraction') {
      claim = {
        claim: text,
        scope,
        type: target?.type ?? 'fact',
        status: 'retracted',
        assertion: { ...assertionBase },
        relations: target ? [{ kind: 'supersedes', targetRecordId: target.recordId }] : [],
        evidence,
      };
    } else if (m.kind === 'quote') {
      claim = { claim: text, scope, type: 'fact', status: 'active', assertion: { ...assertionBase, speaker: 'quoted' }, relations: [], evidence };
    } else if (m.kind === 'assistant-claim') {
      claim = {
        claim: text,
        scope,
        type: 'task-state',
        status: 'not-done',
        assertion: { ...assertionBase, speaker: 'assistant' },
        relations: [],
        evidence,
      };
    } else if (m.kind === 'tool-failure') {
      claim = { claim: text, scope, type: 'task-state', status: 'not-done', assertion: { ...assertionBase }, relations: [], evidence };
    } else if (m.kind === 'cross-scope') {
      // 跨项目表述：scope 与来源绑定不同，由行 2 拒绝（允许并存，不跨边界覆盖）
      claim = { claim: text, scope: `${scope}#foreign`, type: 'fact', status: 'active', assertion: { ...assertionBase }, relations: [], evidence };
    }

    // m6：跨项目纠正必须有来源绑定 scope 才能判定，否则 fail-closed
    if (m.kind === 'cross-scope' && !sourceScope) {
      return { kind: 'cross-scope', matcher: m.matcher, decision: 'reject', reason: 'cross-scope-leak', detail: 'source-scope-unbound' };
    }

    // M3：修订/撤回必须让新值出现在证据引文中（纠正消息自身应是事件），否则证据悬空
    if (m.kind === 'correction') {
      const bound = (evidence ?? []).some((e) => String(e.quote ?? '').includes(String(m.newValue ?? '')));
      if (!bound) {
        return { kind: 'correction', matcher: m.matcher, decision: 'reject', reason: 'evidence-unsupported', detail: 'new-value-not-in-evidence' };
      }
    }

    const [ingested] = ingest({ runKey, claims: [claim] });
    if (!ingested || ingested.noop) {
      return { kind: m.kind, matcher: m.matcher, candidateId: ingested?.candidateId ?? null, decision: 'noop', noopReason: ingested?.noopReason ?? null };
    }
    const decision = decide(ingested.candidateId, { opId });
    return { kind: m.kind, matcher: m.matcher, candidateId: ingested.candidateId, decision: decision.decision, reason: decision.reason, targetRecordId: m.targetRecordId };
  }

  const TERMINAL = new Set(['rejected', 'failed', 'cancelled', 'superseded']);

  function decide(candidateId, ctx = {}) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_CANDIDATE_NOT_FOUND:${candidateId}`);
    // 01 §2：终态禁止任何迁出；accepted 只允许经 supersede 修订
    if (TERMINAL.has(c.state)) throw new Error(`E_ILLEGAL_TRANSITION:${c.state}`);
    const objection = resolveObjection(c, ctx);
    if (c.state === 'accepted' && !objection?.resolvable) throw new Error('E_ILLEGAL_TRANSITION:accepted');

    const decisionBase = {
      opId: ctx.opId ?? null,
      decider: POLICY_VERSION,
      candidateVersion: c.meta.version,
      evidenceHash: c.meta.evidenceHash ?? null,
      expectedTruthRevision: truthRevision,
      decidedAt: clock(),
    };

    // 行 8：异议可消解 → 生成 relations 后**真正重入**矩阵（行 1–7 全量重评）
    let r = evaluate(c);
    if (objection?.resolvable && r.decision === 'accept') {
      r.rulesHit.push('objection-without-target');
    }
    // M1：不可消解异议必须拦住 accept（规格 §5「不可消解 → hold(unresolved)」）
    if (objection && objection.resolvable === false && r.decision === 'accept') {
      r = {
        row: 6,
        decision: rowDecision(6),
        reason: 'unresolved',
        rulesHit: [...r.rulesHit, 'objection-unresolvable'],
        objectionKind: objection.kind,
      };
    }
    if ((r.decision === 'hold' || r.decision === 'reject') && objection?.resolvable) {
      c.meta.relations = [
        ...c.meta.relations,
        {
          kind: 'supersedes',
          targetRecordId: objection.targetRecordId ?? r.conflict ?? null,
          reason: objection.reason ?? 'correction',
          at: clock(),
        },
      ];
      c.meta.version += 1; // 修订产生新版本（CAS 依据）
      r = evaluate(c, { correctionApplied: true });
    }

    // 穷尽性兜底：evaluate 必须给出九行之一，否则 fail-closed
    if (!r || !r.reason || !['accept', 'reject', 'hold'].includes(r.decision)) {
      auditOf({ kind: 'matrix-unmatched', candidateId });
      throw new Error('E_MATRIX_NOT_EXHAUSTIVE');
    }

    // 状态迁移 + hold 注解 + 隔离
    if (r.decision === 'reject') {
      c.state = r.reason === 'evidence-unsupported' ? 'failed' : 'rejected';
      if (r.reason === 'injection-suspected') {
        quarantined.push({ candidateId, at: clock(), reason: 'injection-suspected' });
      }
    } else if (r.decision === 'hold') {
      c.state = 'pending';
      c.hold = {
        policyVersion: POLICY_VERSION,
        reason: r.reason,
        targetRecordId: r.conflict ?? null,
        at: clock(),
      };
      holds.push(c.hold);
    } else {
      c.state = 'pending'; // accept 不等于落库：提交点仍是 R7
    }

    c.lastDecision = { decision: r.decision, reason: r.reason, at: clock() };
    auditOf({ kind: 'decision', candidateId, decision: r.decision, reason: r.reason });
    return {
      ...decisionBase,
      decision: r.decision,
      reason: r.reason,
      rulesHit: r.rulesHit,
      ...(r.violations ? { violations: r.violations } : {}),
      ...(r.row ? { row: r.row } : {}),
      ...(r.objectionKind ? { objectionKind: r.objectionKind } : {}),
    };
  }

  function commit(candidateId, { opId, expected = null } = {}) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_CANDIDATE_NOT_FOUND:${candidateId}`);
    if (!opId) throw new Error('E_OPID_REQUIRED');

    if (receipts.has(opId)) {
      const r = receipts.get(opId);
      return { kind: 'noop-receipt', recordId: r.recordId, revision: r.revision };
    }

    // audit-pending 期间禁止任何新写入（fail-closed，§8）
    if (auditPending.size > 0 && !auditPending.has(opId)) {
      throw new Error('E_AUDIT_PENDING');
    }

    // 矩阵约束 R7：未被 accept 的候选不得落真相层（09 §6 命中即停）
    if (!c.lastDecision || c.lastDecision.decision !== 'accept') {
      throw new Error(`E_NOT_ACCEPTED:${c.lastDecision?.decision ?? 'none'}`);
    }
    if (c.hold && !(c.meta.relations ?? []).some((rel) => rel.kind === 'supersedes')) {
      throw new Error('E_HOLD_UNRESOLVED');
    }
    if (c.state === 'accepted' && !(c.meta.relations ?? []).some((rel) => rel.kind === 'supersedes')) {
      throw new Error('E_ILLEGAL_TRANSITION:accepted');
    }

    // 锁内重查 epoch（撤销优先于 CAS）
    if (revoked.has(c.meta.sourceEpoch)) {
      c.state = 'cancelled';
      auditOf({ kind: 'commit', candidateId, opId, reason: 'source-revoked' });
      return { kind: 'cancelled', reason: 'source-revoked' };
    }

    // CAS 三元组：candidateVersion + evidenceHash + expectedTruthRevision
    if (expected) {
      let refreshed = 0;
      let ok = casMatch(c, expected);
      while (!ok && refreshed < cfg.maxCasRefresh) {
        refreshed += 1;
        // 真实刷新：重跑决策（可能得出新的 reject/hold，须采用），版本递增，再比对
        const re = decide(candidateId, { opId });
        if (re.decision !== 'accept') {
          auditOf({ kind: 'commit', candidateId, opId, reason: `refresh-${re.decision}`, refreshed });
          return { kind: re.decision === 'hold' ? 'hold' : 'rejected', reason: re.reason, refreshed };
        }
        c.meta.version += 1;
        ok = casMatch(c, expected);
      }
      if (!ok) {
        c.state = 'pending';
        c.hold = { policyVersion: POLICY_VERSION, reason: 'cas-conflict', refreshed, at: clock() };
        holds.push(c.hold);
        auditOf({ kind: 'commit', candidateId, opId, reason: 'cas-conflict', refreshed });
        return { kind: 'hold', reason: 'cas-conflict', refreshed };
      }
    }

    // 审计先行（fail-closed）
    if (auditPending.has(opId)) throw new Error('E_AUDIT_PENDING');
    auditOf({ kind: 'commit', candidateId, opId });

    // 真相层追加 = 提交点
    truthRevision += 1;
    const record = {
      recordId: `tr-${truthRevision}`,
      opId,
      candidateId,
      key: c.key,
      revision: truthRevision,
      candidateVersion: c.meta.version,
      evidenceHash: c.meta.evidenceHash ?? null,
      claim: c.meta.claimText,
      scope: c.meta.scope,
      type: c.meta.type,
      status: c.meta.status,
      assertion: c.meta.assertion,
      relations: c.meta.relations ?? [],
      trust: 'T2',
      committedAt: clock(),
    };
    truth.push(record);
    // B2：relations.supersedes 必须真正生效（01 §2 accepted──supersede──▶superseded）
    for (const rel of record.relations.filter((x) => x.kind === 'supersedes' && x.targetRecordId)) {
      const target = truth.find((t) => t.recordId === rel.targetRecordId);
      if (target) {
        target.superseded = true;
        target.supersededBy = record.recordId;
        target.supersededAt = clock();
        const tc = candidates.get(target.candidateId);
        if (tc) tc.state = 'superseded';
      }
    }
    receipts.set(opId, { recordId: record.recordId, revision: record.revision, evidenceHash: record.evidenceHash });
    c.state = 'accepted';
    return { kind: 'committed', recordId: record.recordId, revision: record.revision };
  }

  function casMatch(c, expected) {
    const versionOk = expected.candidateVersion === c.meta.version;
    const revOk = expected.expectedTruthRevision === truthRevision;
    // 三元组的 hash 维必须显式给出（null 视为冲突，不允许降维成二元 CAS）
    const hashOk = expected.evidenceHash != null && expected.evidenceHash === (c.meta.evidenceHash ?? null);
    return versionOk && revOk && hashOk;
  }

  return {
    ingest,
    get,
    decide,
    commit,
    semanticKey,
    truthRecords: () => truth.slice(),
    trustWrites: () => [],
    packInputs: () =>
      truth
        .filter((t) => !quarantined.some((q) => q.candidateId === t.candidateId))
        .filter((t) => ![...candidates.values()].some((c) => c.candidateId === t.candidateId && revoked.has(c.meta.sourceEpoch)))
        .map((t) => ({ ...t, sourceMark: t.trust })),
    quarantine: () => quarantined.slice(),
    correct,
    holdAnnotations: () => holds.slice(),
    auditPendingOps: () => [...auditPending],
    failAuditOnOp: (opId) => {
      auditPending.add(opId);
    },
    clearAuditPending: (opId) => {
      auditPending.delete(opId);
    },
    addTruthRecord: ({ claim, scope, assertion = null }) => {
      truthRevision += 1;
      const record = {
        recordId: `tr-${truthRevision}`,
        opId: `seed-${truthRevision}`,
        candidateId: null,
        key: `${scope}\u0000${assertion?.subject ?? ''}\u0000${assertion?.predicate ?? ''}\u0000${assertion?.value ?? ''}\u0000${normalizeClaim(claim)}`,
        revision: truthRevision,
        claim,
        scope,
        assertion,
        relations: [],
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
    revokedEpochs: () => [...revoked],
    isPolicyBlocked: () => Boolean(cfg.quotaExceeded),
    truthRevision: () => truthRevision,
    forceReceiptDrift: (opId) => {
      receipts.delete(opId);
    },
    reconcile: (opId) => {
      if (receipts.has(opId)) return { kind: 'noop-receipt', recordId: receipts.get(opId).recordId };
      const found = truth.find((t) => t.opId === opId);
      if (!found) {
        // 审计先行失败（真相层未追加）：解除 pending，允许原位重放（09 §8 补偿重放）
        if (auditPending.has(opId)) {
          auditPending.delete(opId);
          auditOf({ kind: 'reconcile', opId, reason: 'audit-recovered-replay-allowed' });
          return { kind: 'replay-allowed' };
        }
        return { kind: 'recovery-required', reason: 'no-record-for-op' };
      }
      const dup = truth.filter((t) => t.opId === opId);
      if (dup.length > 1) return { kind: 'recovery-required', reason: 'duplicate-records' };
      receipts.set(opId, {
        recordId: found.recordId,
        revision: found.revision,
        evidenceHash: found.evidenceHash ?? null,
      });
      auditPending.delete(opId);
      return { kind: 'receipt-repaired', recordId: found.recordId };
    },
    auditLog: () => audit.slice(),
  };
}
