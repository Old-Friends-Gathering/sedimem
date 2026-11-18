// protocol-sim 单元测试（TDD——先于实现编写）
// 规格：docs/design/v2.0/01-candidate-schema.md §2/§3/§3.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, makeCandidateId } from '../tools/protocol-sim.mjs';

const baseInput = { sourceEpoch: 1, rangeId: 'r1', inputHash: 'sha256:aaa' };

function mkClaim(claim, extra = {}) {
  return {
    claim,
    type: 'fact',
    scope: 'repo:demo-alpha',
    assertion: {
      speaker: 'user',
      speechAct: 'state',
      about: 'demo-alpha',
      negated: false,
      condition: null,
      quote: claim,
    },
    evidence: [{ eventId: 'm001', span: { start: 0, end: 10 }, hash: 'sha256:e1' }],
    relations: [],
    ...extra,
  };
}

test('candidateId 确定性：同四元组同 ID，不含 model/config', () => {
  const a = makeCandidateId(baseInput, '用 Postgres 存事件');
  const b = makeCandidateId(baseInput, '用 Postgres 存事件');
  const c = makeCandidateId(baseInput, '用 MySQL 存事件');
  assert.equal(a, b);
  assert.notEqual(a, c);
  // model/configHash 不参与派生：传入无影响
  const d = makeCandidateId(baseInput, '用 Postgres 存事件', { model: 'glm-4.6', configHash: 'sha256:x' });
  assert.equal(a, d);
  // 26 位 Crockford base32（ULID 形态）
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('写入幂等：同 extractionRunKey 重放 → 全 noop', () => {
  const sim = createSim();
  const r1 = sim.ingest('run-A', baseInput, [mkClaim('用户决定周五发布')]);
  assert.equal(r1.created.length, 1);
  const r2 = sim.ingest('run-A', baseInput, [mkClaim('用户决定周五发布')]);
  assert.equal(r2.created.length, 0);
  assert.equal(r2.noop.length, 1);
  // 与首次相同的 candidateId
  assert.equal(r2.noop[0].candidateId, r1.created[0].candidateId);
});

test('非法迁移拒绝：accept 已 rejected 候选抛 E_ILLEGAL_TRANSITION', () => {
  const sim = createSim();
  const r = sim.ingest('run-B', baseInput, [mkClaim('构建脚本在 CI 失败')]);
  const id = r.created[0].candidateId;
  sim.reject(id, 'human-1');
  assert.throws(() => sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-1' }), /E_ILLEGAL_TRANSITION/);
});

test('CAS 冲突：candidateVersion 不匹配 → E_CAS_CONFLICT，不盲写', () => {
  const sim = createSim();
  const r = sim.ingest('run-C', baseInput, [mkClaim('网关超时设为 30 秒')]);
  const id = r.created[0].candidateId;
  assert.throws(
    () => sim.accept(id, { candidateVersion: 99, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-2' }),
    (e) => e.code === 'E_CAS_CONFLICT' && e.current && e.current.candidateVersion === 1,
  );
  // 候选仍 pending
  assert.equal(sim.get(id).workflow.state, 'pending');
});

test('evidenceHash 不匹配 → E_CAS_CONFLICT（CAS 三元组逐项校验）', () => {
  const sim = createSim();
  const r = sim.ingest('run-D', baseInput, [mkClaim('报表任务每天 02:00 运行')]);
  const id = r.created[0].candidateId;
  assert.throws(
    () => sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:stale', expectedTruthRevision: 0, acceptOpId: 'op-3' }),
    (e) => e.code === 'E_CAS_CONFLICT' && e.current.evidenceHash === 'sha256:e1',
  );
});

test('accept 幂等：同 acceptOpId 重放 → noop receipt，真相层不重复追加', () => {
  const sim = createSim();
  const r = sim.ingest('run-E', baseInput, [mkClaim('用户偏好深色主题')]);
  const id = r.created[0].candidateId;
  const a1 = sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-4' });
  const a2 = sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 1, acceptOpId: 'op-4' });
  assert.equal(a2.kind, 'noop-receipt');
  assert.equal(sim.truth.size, 1);
});

test('accept 不提升 trust：真相层记录 trust 保持 T2', () => {
  const sim = createSim();
  const r = sim.ingest('run-F', baseInput, [mkClaim('发布窗口定在周二')]);
  const id = r.created[0].candidateId;
  sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-5' });
  const rec = [...sim.truth.values()][0];
  assert.equal(rec.trust, 'T2');
});

test('noop/merge 决策持久收据：opId→目标记录，可重放恢复', () => {
  const sim = createSim();
  const r = sim.ingest('run-G', baseInput, [mkClaim('配额上限为 500 req/min'), mkClaim('配额限制为每分钟 500 个请求')]);
  // 第二条与第一条不同 scope → 不同 ID，但语义重复 → merge 决策
  const [first, second] = r.created.map((c) => c.candidateId);
  const m = sim.acceptMerge(second, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-6', mergeTarget: first });
  assert.equal(m.kind, 'merge-receipt');
  assert.equal(m.targetId, first);
  // 重放同 opId → 返回已有收据
  const replay = sim.acceptMerge(second, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-6', mergeTarget: first });
  assert.equal(replay.kind, 'noop-receipt');
});

test('recovery-required：标记后禁止自动重试（E_RECOVERY_BLOCKED）', () => {
  const sim = createSim();
  const r = sim.ingest('run-H', baseInput, [mkClaim('缓存 TTL 为 300 秒')]);
  const id = r.created[0].candidateId;
  sim.markRecoveryRequired('op-7', 'receipt-missing-but-truth-suspected');
  assert.throws(
    () => sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-7' }),
    (e) => e.code === 'E_RECOVERY_BLOCKED',
  );
  // 人工显式恢复后可继续
  sim.resolveRecovery('op-7', { verifiedTarget: null, decision: 'redo' });
  const a = sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-7' });
  assert.equal(a.kind, 'accepted');
});

test('修订链：修订候选 accept → 旧候选转 superseded', () => {
  const sim = createSim();
  const r1 = sim.ingest('run-I', baseInput, [mkClaim('部署区域为 us-east-1')]);
  const oldId = r1.created[0].candidateId;
  sim.accept(oldId, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-8' });
  // 修订（不同 claim、带 supersedes 关系）
  const rev = mkClaim('部署区域为 eu-west-1', { relations: [{ kind: 'supersedes', targetId: oldId, unresolvedReason: undefined }] });
  const r2 = sim.ingest('run-J', baseInput, [rev]);
  const newId = r2.created[0].candidateId;
  assert.notEqual(newId, oldId);
  sim.accept(newId, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 1, acceptOpId: 'op-9' });
  assert.equal(sim.get(oldId).workflow.state, 'superseded');
  assert.equal(sim.get(newId).workflow.state, 'accepted');
});

test('failed 重试：同输入同配置 → 同 candidateId noop，不产生新候选', () => {
  const sim = createSim();
  const r1 = sim.ingest('run-K', baseInput, [mkClaim('分片键为 user_id')]);
  const id = r1.created[0].candidateId;
  sim.fail(id, { failure: 'timeout', finishReason: 'timeout' });
  const r2 = sim.ingest('run-K', baseInput, [mkClaim('分片键为 user_id')]);
  assert.equal(r2.created.length, 0);
  assert.equal(r2.noop.length, 1);
  assert.equal(r2.noop[0].candidateId, id);
});

test('跨模型同 claim → noop，provenance 以首写为准', () => {
  const sim = createSim();
  const r1 = sim.ingest('run-L', baseInput, [mkClaim('限流阈值为 100 QPS')], { provider: 'glm', model: 'glm-4.6' });
  const id = r1.created[0].candidateId;
  const r2 = sim.ingest('run-M', baseInput, [mkClaim('限流阈值为 100 QPS')], { provider: 'glm', model: 'glm-5.3' });
  assert.equal(r2.created.length, 0);
  assert.equal(r2.noop.length, 1);
  // 首写 provenance 未被覆盖
  assert.equal(sim.get(id).provenance.model, 'glm-4.6');
});

test('模型/配置变化且 claim 不同 → 修订路径新 ID（非 noop）', () => {
  const sim = createSim();
  const r1 = sim.ingest('run-N', baseInput, [mkClaim('备份保留 7 天')], { model: 'glm-4.6' });
  const r2 = sim.ingest('run-O', baseInput, [mkClaim('备份保留 14 天')], { model: 'glm-5.3' });
  assert.equal(r2.created.length, 1);
  assert.notEqual(r2.created[0].candidateId, r1.created[0].candidateId);
});

test('游标：缺口进 missingRanges，不得推进为已完成', () => {
  const sim = createSim();
  sim.commitCursor('range-r1', { ok: true });
  assert.deepEqual(sim.cursor.missingRanges, []);
  sim.commitCursor('range-r2', { ok: false, gap: ['m010-m012'] });
  assert.deepEqual(sim.cursor.missingRanges, [{ rangeId: 'range-r2', gap: ['m010-m012'] }]);
  // 完成集合不含 r2
  assert.ok(!sim.cursor.completed.includes('range-r2'));
});

test('崩溃恢复：真相层追加失败 → 按收据重放不重复', () => {
  const sim = createSim({ failTruthAppendOnOp: 'op-10' });
  const r = sim.ingest('run-P', baseInput, [mkClaim('指标上报间隔 60 秒')]);
  const id = r.created[0].candidateId;
  assert.throws(
    () => sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-10' }),
    (e) => e.code === 'E_TRUTH_APPEND_FAILED',
  );
  // 崩溃后恢复：候选与审计已在，重放 accept → 提交一次
  const a = sim.accept(id, { candidateVersion: 1, evidenceHash: 'sha256:e1', expectedTruthRevision: 0, acceptOpId: 'op-10' });
  assert.equal(a.kind, 'accepted');
  assert.equal(sim.truth.size, 1);
});
