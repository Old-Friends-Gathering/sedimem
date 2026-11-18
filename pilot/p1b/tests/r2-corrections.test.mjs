import test from 'node:test';
import assert from 'node:assert/strict';
import { createR2Sim } from '../tools/r2-sim.mjs';

// T-A7..T-A10, T-A17（09 §7 聊天纠正 / §4 撤销）

function base() {
  const sim = createR2Sim({ cost: { configured: true, dailyLimitCny: 5, spentCny: 0, destinations: ['bigmodel.cn'] } });
  const text = '数据库 db-primary 的端口是 8080';
  sim.addEvents({ m001: { role: 'user', text, ts: '2026-11-18T04:00:00Z' } });
  const input = { sourceId: 'dsh-transcript:test', sourceEpoch: 1, rangeId: 'r1', inputHash: 'sha256:aaa' };
  const claim = {
    claim: text,
    type: 'fact',
    scope: 'repo:demo',
    assertion: { speaker: 'user', speechAct: 'state', about: 'db-primary', subject: 'db-primary', predicate: 'port', value: '8080', negated: false, quote: text },
    evidence: [{ eventId: 'm001', quote: text }],
  };
  const { created } = sim.ingest({ runKey: 'run-1', input, claims: [claim] });
  const id = created[0].candidateId;
  sim.decide(id, {});
  const rec = sim.commit(id, { opId: 'op-1' });
  return { sim, text, recordId: rec.recordId, candidateId: id, input };
}

test('T-A7 用户直接更正 → 当前值更新，asOf 旧时间仍返回旧值', () => {
  const { sim, recordId } = base();
  const at = '2026-11-18T04:00:00Z';
  const fixText = '刚才说错了，db-primary 端口应为 8081';
  sim.addEvents({ m002: { role: 'user', text: fixText, ts: '2026-11-18T05:00:00Z' } });
  const applied = sim.correct({
    text: fixText,
    scope: 'repo:demo',
    subject: 'db-primary',
    predicate: 'port',
    value: '8081',
    evidence: { eventId: 'm002', quote: fixText },
    at: '2026-11-18T05:00:00Z',
    opId: 'op-fix',
  });
  assert.equal(applied.kind, 'correction');
  assert.equal(applied.superseded, recordId);
  const now = sim.query({});
  assert.equal(now.find((r) => r.subject === 'db-primary' && r.predicate === 'port').value, '8081');
  const past = sim.query({ asOf: at });
  assert.equal(past.find((r) => r.subject === 'db-primary' && r.predicate === 'port').value, '8080');
});

test('T-A8 「先别改 / 仍用 8080」→ 前一变更 retracted，当前值回到旧值', () => {
  const { sim } = base();
  const fixText = 'db-primary 端口应为 8081';
  sim.addEvents({ m002: { role: 'user', text: fixText, ts: '2026-11-18T05:00:00Z' } });
  const c1 = sim.correct({ text: fixText, scope: 'repo:demo', subject: 'db-primary', predicate: 'port', value: '8081', evidence: { eventId: 'm002', quote: fixText }, at: '2026-11-18T05:00:00Z', opId: 'op-fix' });
  assert.equal(c1.kind, 'correction');
  const holdText = '先别改，仍用 8080';
  sim.addEvents({ m003: { role: 'user', text: holdText, ts: '2026-11-18T06:00:00Z' } });
  const c2 = sim.correct({ text: holdText, scope: 'repo:demo', subject: 'db-primary', predicate: 'port', evidence: { eventId: 'm003', quote: holdText }, at: '2026-11-18T06:00:00Z', opId: 'op-retract' });
  assert.equal(c2.kind, 'retraction');
  const cur = sim.query({}).find((r) => r.subject === 'db-primary' && r.predicate === 'port');
  assert.equal(cur.value, '8080');
  assert.equal(cur.status, 'active');
});

test('T-A9 引用他人/助手自称完成 → 记为 quoted/assistant，不覆盖既有事实', () => {
  const { sim } = base();
  const quoteText = '文档里写着 db-primary 端口是 5432';
  sim.addEvents({ m004: { role: 'user', text: quoteText, ts: '2026-11-18T05:00:00Z' } });
  const q = sim.correct({ text: quoteText, kind: 'quote', scope: 'repo:demo', subject: 'db-primary', predicate: 'port', value: '5432', evidence: { eventId: 'm004', quote: quoteText }, at: '2026-11-18T05:00:00Z', opId: 'op-quote' });
  assert.equal(q.kind, 'quote');
  assert.equal(q.speaker, 'quoted');
  const cur = sim.query({}).find((r) => r.subject === 'db-primary' && r.predicate === 'port');
  assert.equal(cur.value, '8080');

  const doneText = '我已经把 db-primary 端口改成 9000 了';
  sim.addEvents({ m005: { role: 'assistant', text: doneText, ts: '2026-11-18T06:00:00Z' } });
  const a = sim.correct({ text: doneText, kind: 'assistant-claim', scope: 'repo:demo', subject: 'db-primary', predicate: 'port', value: '9000', evidence: { eventId: 'm005', quote: doneText }, at: '2026-11-18T06:00:00Z', opId: 'op-claim' });
  assert.equal(a.kind, 'assistant-claim');
  assert.equal(a.speaker, 'assistant');
  const after = sim.query({}).find((r) => r.subject === 'db-primary' && r.predicate === 'port');
  assert.equal(after.value, '8080');
});

test('T-A10 撤销 epoch → pack 输入过滤、新候选拒绝、无自动重新采集', () => {
  const { sim, candidateId } = base();
  assert.equal(sim.packInputs().length, 1);
  const r = sim.revokeEpoch(1);
  assert.equal(r.revoked, 1);
  assert.deepEqual(sim.packInputs(), []);
  assert.equal(sim.recaptureCalls(), 0);
  // 撤销后该 epoch 的新候选必须被拒绝
  const text2 = '数据库 db-primary 的端口是 8081';
  sim.addEvents({ m006: { role: 'user', text: text2, ts: '2026-11-18T06:00:00Z' } });
  const res = sim.ingest({
    runKey: 'run-2',
    input: { sourceId: 'dsh-transcript:test', sourceEpoch: 1, rangeId: 'r2', inputHash: 'sha256:bbb' },
    claims: [{ claim: text2, type: 'fact', scope: 'repo:demo', assertion: { speaker: 'user', speechAct: 'state', about: 'db-primary', subject: 'db-primary', predicate: 'port', value: '8081', quote: text2 }, evidence: [{ eventId: 'm006', quote: text2 }] }],
  });
  const id2 = res.created[0].candidateId;
  const d2 = sim.decide(id2, {});
  assert.equal(d2.decision, 'reject');
  assert.ok(['evidence-unsupported', 'source-revoked'].includes(d2.reason));
  assert.ok(!sim.packInputs().some((p) => p.candidateId === candidateId));
});

test('T-A17 撤销发生在「决策后、追加前」→ 拦截，候选 cancelled(source-revoked)，真相层无新增', () => {
  const sim = createR2Sim({ cost: { configured: true, dailyLimitCny: 5, spentCny: 0, destinations: ['bigmodel.cn'] } });
  const text = '数据库 db-primary 的端口是 8080';
  sim.addEvents({ m001: { role: 'user', text, ts: '2026-11-18T04:00:00Z' } });
  const { created } = sim.ingest({
    runKey: 'run-1',
    input: { sourceId: 'dsh-transcript:test', sourceEpoch: 1, rangeId: 'r1', inputHash: 'sha256:aaa' },
    claims: [{ claim: text, type: 'fact', scope: 'repo:demo', assertion: { speaker: 'user', speechAct: 'state', about: 'db-primary', subject: 'db-primary', predicate: 'port', value: '8080', quote: text }, evidence: [{ eventId: 'm001', quote: text }] }],
  });
  const id = created[0].candidateId;
  const d = sim.decide(id, {});
  assert.equal(d.decision, 'accept');
  sim.revokeEpoch(1); // 决策之后、提交之前
  const res = sim.commit(id, { opId: 'op-1' });
  assert.equal(res.kind, 'cancelled');
  assert.equal(sim.sim.get(id).workflow.state, 'cancelled');
  assert.equal(sim.truthRecords().length, 0);
});
