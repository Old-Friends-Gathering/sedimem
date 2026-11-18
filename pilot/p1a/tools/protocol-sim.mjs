// protocol-sim.mjs —— 候选状态机 + 幂等协议内存模拟器（P1a 保护测试载体）
// 规格：docs/design/v2.0/01-candidate-schema.md §1/§2/§3/§3.1
// 边界：纯内存、不写真相层文件、不冒充 P1b 写路径实现。
import { createHash } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// 26 位 Crockford base32 ULID 形态派生（确定性，非时间有序——内存模拟不需要有序性）
function toUlidLike(hex) {
  let bits = BigInt('0x' + hex.slice(0, 32));
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(bits % 32n)] + out;
    bits /= 32n;
  }
  return out;
}

// candidateId = hash(内容四元组) 派生；不含 model/configHash（01 §3.1 R2-N1 判定边界）
export function makeCandidateId(input, claim, _provenanceUnused = null) {
  const normalized = String(claim).trim().replace(/\s+/g, ' ');
  return toUlidLike(sha256(`${input.sourceEpoch}|${input.rangeId}|${input.inputHash}|${normalized}`));
}

// 合法迁移闭集（01 §2）
const TRANSITIONS = {
  pending: new Set(['accepted', 'rejected', 'cancelled', 'failed']),
  accepted: new Set(['superseded']),
  rejected: new Set(),
  cancelled: new Set(),
  failed: new Set(),
  superseded: new Set(),
};

const SEVERE_TRUST_CEILING = 'T2'; // accept 不提升 trust：真相层记录保持 T2

export function createSim(opts = {}) {
  const candidates = new Map(); // candidateId → candidate（含 workflow）
  const receipts = new Map(); // acceptOpId → receipt
  const recovery = new Map(); // acceptOpId → { reason, resolved, resolution }
  const crashedOnce = new Set(); // 已模拟过崩溃的 opId（崩溃一次性）
  const truth = new Map(); // truthRecordId → { candidateId, claim, trust: T2, revision }
  const audit = []; // 审计事件（决定先持久化）
  let truthRevision = 0;
  let seq = 0;
  const cursor = { completed: [], missingRanges: [] };
  let prov = { provider: 'glm', model: 'glm-4.6', promptVersion: 'p1a-baseline-1', configHash: 'sha256:sim-default' };

  function assertNoTransition(from, to) {
    if (!TRANSITIONS[from] || !TRANSITIONS[from].has(to)) {
      const e = new Error(`E_ILLEGAL_TRANSITION: ${from} → ${to}`);
      e.code = 'E_ILLEGAL_TRANSITION';
      throw e;
    }
  }

  function persistAudit(entry) {
    audit.push({ seq: ++seq, ...entry });
  }

  function appendTruth(candidate, opId) {
    if (opts.failTruthAppendOnOp === opId && !crashedOnce.has(opId)) {
      crashedOnce.add(opId); // 崩溃只发生一次——重放时提交点可达成
      const e = new Error('E_TRUTH_APPEND_FAILED: simulated crash before commit point');
      e.code = 'E_TRUTH_APPEND_FAILED';
      throw e;
    }
    truthRevision += 1;
    const recordId = `truth-${truthRevision}`;
    truth.set(recordId, { candidateId: candidate.candidateId, claim: candidate.claim, trust: SEVERE_TRUST_CEILING, revision: truthRevision });
    return { recordId, revision: truthRevision };
  }

  function ingest(runKey, input, claims, provenance = null) {
    if (provenance) prov = { ...prov, ...provenance };
    const created = [];
    const noop = [];
    for (const c of claims) {
      const candidateId = makeCandidateId(input, c.claim);
      if (candidates.has(candidateId)) {
        noop.push({ candidateId, reason: 'write-idempotent' }); // 同 ID 重放：noop，provenance 以首写为准
        continue;
      }
      candidates.set(candidateId, {
        candidateId,
        claim: c.claim,
        type: c.type,
        scope: c.scope,
        assertion: c.assertion,
        evidence: c.evidence,
        relations: c.relations || [],
        provenance: { ...prov, extractionRunKey: runKey },
        workflow: { state: 'pending', failure: null, candidateVersion: 1, acceptOpId: null, decidedBy: null, decidedAt: null },
      });
      created.push({ candidateId });
    }
    persistAudit({ op: 'ingest', runKey, created: created.length, noop: noop.length });
    return { runKey, created, noop };
  }

  function checkReceipt(opId) {
    return receipts.get(opId) || null;
  }

  function assertNotBlocked(opId) {
    const rec = recovery.get(opId);
    if (rec && !rec.resolved) {
      const e = new Error(`E_RECOVERY_BLOCKED: opId=${opId} recovery-required，禁止自动重试`);
      e.code = 'E_RECOVERY_BLOCKED';
      throw e;
    }
  }

  function casCheck(candidate, expected) {
    const cur = {
      candidateVersion: candidate.workflow.candidateVersion,
      evidenceHash: candidate.evidence[0]?.hash ?? null,
      truthRevision,
    };
    if (expected.candidateVersion !== cur.candidateVersion || expected.evidenceHash !== cur.evidenceHash || expected.expectedTruthRevision !== cur.truthRevision) {
      const e = new Error(`E_CAS_CONFLICT: ${candidate.candidateId}`);
      e.code = 'E_CAS_CONFLICT';
      e.current = cur;
      throw e;
    }
    return cur;
  }

  function accept(candidateId, req) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_NOT_FOUND: ${candidateId}`);
    assertNotBlocked(req.acceptOpId);
    const prior = checkReceipt(req.acceptOpId);
    if (prior) return { kind: 'noop-receipt', opId: req.acceptOpId, prior }; // Accept 幂等 1
    assertNoTransition(c.workflow.state, 'accepted');
    casCheck(c, req);
    // 审计先持久化（提交点前）
    persistAudit({ op: 'accept', opId: req.acceptOpId, candidateId });
    const appended = appendTruth(c, req.acceptOpId);
    c.workflow.state = 'accepted';
    c.workflow.acceptOpId = req.acceptOpId;
    c.workflow.decidedBy = req.decidedBy || 'human';
    c.workflow.decidedAt = new Date().toISOString();
    receipts.set(req.acceptOpId, { kind: 'accepted', candidateId, truthRecordId: appended.recordId, revision: appended.revision });
    // 修订链：本候选被 accept 且它 supersedes 旧候选 → 旧候选转 superseded
    for (const rel of c.relations || []) {
      if (rel.kind === 'supersedes' && rel.targetId) {
        const old = candidates.get(rel.targetId);
        if (old) {
          assertNoTransition(old.workflow.state, 'superseded');
          old.workflow.state = 'superseded';
          persistAudit({ op: 'supersede', oldId: old.candidateId, byNew: candidateId });
        }
      }
    }
    return { kind: 'accepted', candidateId, truthRecordId: appended.recordId, revision: appended.revision };
  }

  function acceptMerge(candidateId, req) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_NOT_FOUND: ${candidateId}`);
    assertNotBlocked(req.acceptOpId);
    const prior = checkReceipt(req.acceptOpId);
    if (prior) return { kind: 'noop-receipt', opId: req.acceptOpId, prior }; // Accept 幂等 1
    assertNoTransition(c.workflow.state, 'accepted');
    casCheck(c, req);
    if (!req.mergeTarget) throw new Error('E_MERGE_TARGET_REQUIRED');
    persistAudit({ op: 'accept-merge', opId: req.acceptOpId, candidateId, mergeTarget: req.mergeTarget });
    const appended = appendTruth(c, req.acceptOpId);
    c.workflow.state = 'accepted';
    c.workflow.acceptOpId = req.acceptOpId;
    receipts.set(req.acceptOpId, { kind: 'merge-receipt', candidateId, targetId: req.mergeTarget, revision: appended.revision }); // Accept 幂等 3：merge 收据记录目标
    return { kind: 'merge-receipt', candidateId, targetId: req.mergeTarget, revision: appended.revision };
  }

  function reject(candidateId, by) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_NOT_FOUND: ${candidateId}`);
    assertNoTransition(c.workflow.state, 'rejected');
    c.workflow.state = 'rejected';
    c.workflow.decidedBy = by;
    persistAudit({ op: 'reject', candidateId, by }); // rejected 留评测负例，不删除
    return { kind: 'rejected', candidateId };
  }

  function fail(candidateId, { failure, finishReason }) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_NOT_FOUND: ${candidateId}`);
    assertNoTransition(c.workflow.state, 'failed');
    c.workflow.state = 'failed';
    c.workflow.failure = { failure, finishReason: finishReason ?? null };
    persistAudit({ op: 'fail', candidateId, failure });
    return { kind: 'failed', candidateId };
  }

  function cancel(candidateId) {
    const c = candidates.get(candidateId);
    if (!c) throw new Error(`E_NOT_FOUND: ${candidateId}`);
    assertNoTransition(c.workflow.state, 'cancelled');
    c.workflow.state = 'cancelled';
    persistAudit({ op: 'cancel', candidateId });
    return { kind: 'cancelled', candidateId };
  }

  function markRecoveryRequired(opId, reason) {
    recovery.set(opId, { reason, resolved: false, resolution: null });
    persistAudit({ op: 'recovery-required', opId, reason });
  }

  function resolveRecovery(opId, resolution) {
    const rec = recovery.get(opId);
    if (!rec) throw new Error(`E_NO_SUCH_RECOVERY: ${opId}`);
    rec.resolved = true;
    rec.resolution = resolution;
    persistAudit({ op: 'recovery-resolved', opId, resolution });
  }

  function commitCursor(rangeId, result) {
    if (result.ok) {
      cursor.completed.push(rangeId); // 仅在候选与审计持久化后提交
    } else {
      cursor.missingRanges.push({ rangeId, gap: result.gap || [] }); // 缺口不得推进为已完成
    }
    persistAudit({ op: 'cursor', rangeId, ok: result.ok });
  }

  function get(candidateId) {
    return candidates.get(candidateId);
  }

  return {
    ingest,
    accept,
    acceptMerge,
    reject,
    fail,
    cancel,
    markRecoveryRequired,
    resolveRecovery,
    commitCursor,
    get,
    get candidates() { return candidates; },
    get receipts() { return receipts; },
    get recovery() { return recovery; },
    get truth() { return truth; },
    get audit() { return audit; },
    get cursor() { return cursor; },
    get truthRevision() { return truthRevision; },
  };
}
