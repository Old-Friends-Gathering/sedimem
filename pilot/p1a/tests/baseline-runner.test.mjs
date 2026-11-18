// B2 基线 runner TDD（先失败后实现）：确定性规则抽取、无 LLM、绝不读 gold。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runBaseline, deriveInputHash } from '../tools/baseline-runner.mjs';

const mkScenario = (over = {}) => ({
  scenarioId: 'S900',
  family: 'fam-test',
  language: 'zh',
  source: { kind: 'dsh-transcript', sourceEpoch: 1 },
  events: [
    { eventId: 'S900-m001', role: 'user', ts: '2026-11-20T09:00:00Z', text: '数据库连接池已提升到 200。' },
  ],
  gold: [],
  shouldReject: null,
  adversarial: null,
  ...over,
});

test('runBaseline: 无可记内容靠规则自然零输出（ACK/短句过滤，不读 shouldReject）', () => {
  const s = mkScenario({ events: [{ eventId: 'S900-m001', role: 'user', ts: '2026-11-20T09:00:00Z', text: '好的，收到。谢谢！' }] });
  const r = runBaseline([s], { runId: 'r1' });
  assert.equal(r.candidates.length, 0);
  assert.deepEqual(r.meta.zeroOutputScenarios, ['S900'], '零候选清单只陈述抽取侧事实');
  assert.equal(r.meta.processed, 1);
});

test('runBaseline: 不偷看 gold——shouldReject 标注不影响抽取结果', () => {
  const flagged = mkScenario({ shouldReject: { reason: 'chitchat', note: 'x' } });
  const clean = mkScenario();
  const a = runBaseline([flagged], { runId: 'r1' }).candidates;
  const b = runBaseline([clean], { runId: 'r1' }).candidates;
  assert.equal(a.length, b.length);
  assert.deepEqual(a.map((c) => c.candidateId), b.map((c) => c.candidateId), '同一内容加不加 shouldReject 产出一致');
});

test('runBaseline: 陈述句产出 pending 候选（schema 关键字段齐）', () => {
  const r = runBaseline([mkScenario()], { runId: 'r1' });
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.status, 'pending');
  assert.equal(c.type, 'fact');
  assert.equal(c.role, 'user');
  assert.equal(c.schemaVersion, 1, 'schemaVersion 为整数（01 §1）');
  assert.equal(c.assertion.speechAct, 'state');
  assert.equal(c.assertion.negated, false);
  assert.equal(c.scope, 'pilot:synthetic');
  assert.equal(c.scopeUnresolved, true);
  assert.equal(c.provenance.provider, 'rule', 'provider 用 01 §1 闭集 rule|glm|human');
  assert.equal(c.provenance.model, 'none');
  assert.equal(c.provenance.tool, 'baseline-rules@pilot-1');
  assert.equal(c.provenance.runId, 'r1');
  assert.equal(c.evidence[0].eventId, 'S900-m001');
  assert.ok(c.evidence[0].quote.includes('连接池'));
  assert.equal(typeof c.evidence[0].start, 'number');
  assert.ok(c.evidence[0].hash.startsWith('sha256:'));
  assert.match(c.candidateId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('runBaseline: 否定识别（zh 不/没有 与 en not/never 词边界）', () => {
  const zh = mkScenario({ events: [{ eventId: 'S900-m001', role: 'user', ts: 't', text: '公共接口不支持批量删除。' }] });
  const en = mkScenario({ scenarioId: 'S901', events: [{ eventId: 'S901-m001', role: 'user', ts: 't', text: 'The API does not support bulk delete.' }] });
  const r = runBaseline([zh, en], { runId: 'r1' });
  assert.equal(r.candidates[0].assertion.negated, true);
  assert.equal(r.candidates[1].assertion.negated, true);
});

test('runBaseline: 建议识别为 speechAct suggest（不是 decide）', () => {
  const s = mkScenario({ events: [{ eventId: 'S900-m001', role: 'assistant', ts: 't', text: '我建议把超时调到 30 秒。' }] });
  const r = runBaseline([s], { runId: 'r1' });
  assert.equal(r.candidates[0].assertion.speechAct, 'suggest');
  assert.equal(r.candidates[0].role, 'assistant');
});

test('runBaseline: 条件句识别为 hypothesis + conditional', () => {
  const s = mkScenario({ events: [{ eventId: 'S900-m001', role: 'user', ts: 't', text: '如果我们采用新 SDK，包体积会小 3MB。' }] });
  const r = runBaseline([s], { runId: 'r1' });
  assert.equal(r.candidates[0].type, 'hypothesis');
  assert.equal(r.candidates[0].status, 'pending', 'workflow 状态恒 pending');
  assert.ok(r.candidates[0].assertion.condition);
});

test('runBaseline: 同场景同 claim 幂等去重（同 candidateId）', () => {
  const s = mkScenario({
    events: [
      { eventId: 'S900-m001', role: 'user', ts: 't', text: '连接池提升到 200。' },
      { eventId: 'S900-m002', role: 'assistant', ts: 't', text: '连接池提升到 200。' },
    ],
  });
  const r = runBaseline([s], { runId: 'r1' });
  assert.equal(r.candidates.length, 1, '同 claim 跨角色去重');
});

test('runBaseline: 纯确认语（ok/noted/好的）不产候选', () => {
  const s = mkScenario({
    events: [{ eventId: 'S900-m001', role: 'assistant', ts: 't', text: 'Noted, thanks.' }],
  });
  const r = runBaseline([s], { runId: 'r1' });
  assert.equal(r.candidates.length, 0);
});

test('runBaseline: inputHash 只含事件文本，不含 gold（防泄漏）', () => {
  const s = mkScenario({ gold: [{ goldId: 'g', claim: 'LEAK-SEED', role: 'user', type: 'fact', scope: 'x', status: 'active', evidence: [] }] });
  const h1 = deriveInputHash(s);
  s.gold = [];
  const h2 = deriveInputHash(s);
  assert.equal(h1, h2, 'gold 变化不得改变 inputHash');
});

test('runBaseline: 记录型场景零候选 → 零输出违规列表', () => {
  const s = mkScenario({ events: [{ eventId: 'S900-m001', role: 'user', ts: 't', text: '好的。' }] });
  const r = runBaseline([s], { runId: 'r1' });
  assert.deepEqual(r.meta.zeroOutputScenarios, ['S900']);
});


// 04 §3：固定配置 3 次运行需可复现——抽取内容摘要必须与 runId 无关。
test('contentDigest：同输入两次运行内容摘要相同（runId 不参与），不同输入不同', async () => {
  const { runBaseline } = await import('../tools/baseline-runner.mjs');
  const mk = (id) => ({
    scenarioId: id, family: 'fam-a', language: 'zh',
    events: [{ eventId: `${id}-m001`, role: 'user', ts: 't', text: '把超时时间调到 30 秒' }],
    gold: [], shouldReject: null, adversarial: null,
  });
  const r1 = runBaseline([mk('S1')], { runId: 'run-a' });
  const r2 = runBaseline([mk('S1')], { runId: 'run-b' });
  assert.equal(r1.meta.contentDigest, r2.meta.contentDigest);
  assert.notEqual(r1.meta.runId, r2.meta.runId);
  const r3 = runBaseline([mk('S1'), mk('S2')], { runId: 'run-a' });
  assert.notEqual(r1.meta.contentDigest, r3.meta.contentDigest);
});
