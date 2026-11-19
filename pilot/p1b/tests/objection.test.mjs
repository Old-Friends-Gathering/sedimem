// R4 异议生成器（B7.4）：独立于决策矩阵的第二遍核对，禁止调用方布尔开关
// 规格：docs/design/v2.0/09-extraction-pipeline.md §5「R4 异议生成器」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateObjection } from '../tools/objection.mjs';

const truth = [
  { recordId: 'tr-1', scope: 'repo:demo', assertion: { subject: 'deploy-service', predicate: 'port', value: '8080' } },
];

function claimOf({ claim = '端口应为 8081', subject = 'deploy-service', predicate = 'port', value = '8081', scope = 'repo:demo', quote = '端口应为 8081', ts = '2026-11-19T00:00:00Z', from = '2026-11-19T00:00:00Z' } = {}) {
  return {
    claim,
    scope,
    assertion: { subject, predicate, value, assertedValidFrom: from },
    evidence: [{ eventId: 'e-1', quote, ts }],
  };
}

test('R4-1 无冲突 → 不产异议（null）', () => {
  const r = generateObjection({ claim: claimOf({ claim: '端口是 8080', value: '8080', quote: '端口是 8080' }), truth });
  assert.equal(r.objection, null);
});

test('R4-2 同主体同谓词不同值 + 正文含更正式 → value-conflict 可消解', () => {
  const r = generateObjection({ claim: claimOf(), truth });
  assert.equal(r.objection.kind, 'value-conflict');
  assert.equal(r.objection.resolvable, true);
  assert.equal(r.objection.targetRecordId, 'tr-1');
});

test('R4-3 冲突但正文无更正式 → 异议不可消解（转 hold）', () => {
  const r = generateObjection({ claim: claimOf({ claim: '端口是 8081', quote: '端口是 8081' }), truth });
  assert.equal(r.objection.kind, 'value-conflict');
  assert.equal(r.objection.resolvable, false);
});

test('R4-4 引文字面值与 assertion.value 不一致 → quote-value-mismatch', () => {
  const emptyTruth = [];
  const r = generateObjection({
    claim: claimOf({ claim: '端口应为 8081', value: '8081', quote: '端口是 9090', from: null }),
    truth: emptyTruth,
  });
  assert.equal(r.objection.kind, 'quote-value-mismatch');
  assert.equal(r.objection.resolvable, true, '正文含更正式且值一致 → 可消解');
});

test('R4-5 候选 scope 与来源绑定 scope 不同 → scope-alias 不可消解', () => {
  const r = generateObjection({ claim: claimOf({ scope: 'repo:other' }), truth, sourceScope: 'repo:demo' });
  assert.equal(r.objection.kind, 'scope-alias');
  assert.equal(r.objection.resolvable, false);
});

test('R4-6 证据时间早于 assertedValidFrom → temporal-drift 不可消解', () => {
  const r = generateObjection({
    claim: claimOf({ from: '2026-11-20T00:00:00Z', ts: '2026-11-19T00:00:00Z' }),
    truth: [],
  });
  assert.equal(r.objection.kind, 'temporal-drift');
  assert.equal(r.objection.resolvable, false);
});

test('R4-7 生成器不接受调用方布尔开关（生产入口不得注入）', () => {
  const r = generateObjection({ claim: claimOf({ claim: '端口是 8080', value: '8080', quote: '端口是 8080' }), truth, objection: { resolvable: true } });
  assert.equal(r.ignoredCallerObjection, true, '调用方 objection 必须被忽略并声明');
});

// —— R2 delta 回归（N1 中文数字、N7 可消解方向）——

test('R4-8 N1 引文用中文数字（八千零八十）不得误判值缺失', () => {
  const claim = {
    claim: '端口是 8080',
    scope: 'repo:demo',
    assertion: { subject: 'deploy-service', predicate: 'port', value: '8080' },
    evidence: [{ eventId: 'S1-m1', quote: '2026-11-19 部署完成，端口是八千零八十', ts: '2026-11-19T01:00:00Z' }],
  };
  const r = generateObjection({ claim, truth: [], sourceScope: 'repo:demo' });
  assert.equal(r.objection, null);
});

test('R4-9 N7 可消解方向与 value-conflict 统一：部分数字在正文出现也可消解', () => {
  const claim = {
    claim: '端口应为 8080、超时 30',
    scope: 'repo:demo',
    assertion: { subject: 'deploy-service', predicate: 'port', value: '8080' },
    evidence: [{ eventId: 'S1-m1', quote: '端口是 8081', ts: '2026-11-19T01:00:00Z' }],
  };
  const truth = [
    { recordId: 'tr-1', scope: 'repo:demo', claim: '端口是 8080', assertion: { subject: 'deploy-service', predicate: 'port', value: '8080' } },
  ];
  const r = generateObjection({ claim, truth, sourceScope: 'repo:demo' });
  // 引文缺 8080 → quote-value-mismatch；正文含更正标记且声明值在文本出现 → 可消解
  assert.equal(r.objection?.kind, 'quote-value-mismatch');
  assert.equal(r.objection?.resolvable, true);
});
