// P1a 冻结决策 3/6/7 的可执行保护测试（TDD——先于实现编写，先跑红再跑绿）
// 决策 #3 规格：docs/design/v2.0/01-candidate-schema.md §5（双时间轴）
// 决策 #6 规格：docs/design/v2.0/adr-101-tokenizer.md（估算口径 + 声明）
// 决策 #7 规格：docs/design/v2.0/adr-102-cost-quota.md（无配置拒绝出站 / 超限显式停机）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDoubleTime, estimateTokens, TOKENIZER_DECLARATION, checkCostGate } from '../tools/contract-guards.mjs';

// ---------- 决策 #3：双时间守卫 ----------

test('双时间：业务时间写进系统区间字段 → asserted-used-as-system（互斥）', () => {
  const c = {
    validFrom: '2025-01-01T00:00:00Z',
    validTo: '2025-12-31T00:00:00Z',
    assertedValidFrom: '2025-01-01T00:00:00Z',
    assertedValidTo: '2025-12-31T00:00:00Z',
  };
  const r = checkDoubleTime(c);
  assert.equal(r.ok, false);
  assert.ok(r.issues.length >= 1);
  assert.ok(r.issues.some((i) => i.code === 'asserted-used-as-system' && (i.field === 'validFrom' || i.field === 'validTo')));
});

test('双时间：字段名兼容 assertion.validFrom / time.assertedValidFrom', () => {
  const a = { validFrom: '2025-01-01T00:00:00Z', assertion: { validFrom: '2025-01-01T00:00:00Z' } };
  assert.ok(checkDoubleTime(a).issues.some((i) => i.code === 'asserted-used-as-system'));
  const b = { validFrom: '2025-01-01T00:00:00Z', time: { assertedValidFrom: '2025-01-01T00:00:00Z' } };
  assert.ok(checkDoubleTime(b).issues.some((i) => i.code === 'asserted-used-as-system'));
});

test('双时间：asOf 早于业务时间起点 → time-travel-leak（"去年开始"不得在更早 asOf 出现）', () => {
  const c = { assertedValidFrom: '2025-01-01T00:00:00Z', assertedValidTo: '2025-12-31T00:00:00Z' };
  const r = checkDoubleTime(c, { asOf: '2024-06-01T00:00:00Z' });
  assert.equal(r.ok, false);
  const leak = r.issues.find((i) => i.code === 'time-travel-leak');
  assert.ok(leak);
  assert.ok(typeof leak.detail === 'string' && leak.detail.length > 0);
});

test('双时间：合法候选（两轴分离且 asOf >= assertedValidFrom）→ ok 且无 issue', () => {
  const c = {
    validFrom: '2024-01-01T00:00:00Z',
    validTo: null,
    assertedValidFrom: '2025-01-01T00:00:00Z',
    assertedValidTo: '2025-12-31T00:00:00Z',
  };
  const r = checkDoubleTime(c, { asOf: '2025-06-01T00:00:00Z' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('双时间：纯函数——不改输入、无 IO', () => {
  const c = { validFrom: '2025-01-01T00:00:00Z', assertedValidFrom: '2025-01-01T00:00:00Z' };
  const snapshot = JSON.stringify(c);
  checkDoubleTime(c, { asOf: '2024-01-01T00:00:00Z' });
  assert.equal(JSON.stringify(c), snapshot);
});

// ---------- 决策 #6：tokenizer 计数快照 ----------

test('估算：同输入连续 3 次结果相同（确定性）', () => {
  const a = estimateTokens('连接池已提升到 200 connections');
  assert.equal(a, estimateTokens('连接池已提升到 200 connections'));
  assert.equal(a, estimateTokens('连接池已提升到 200 connections'));
});

test('估算：中文 10 字 = 10 token', () => {
  assert.equal(estimateTokens('连接池已经提升到两百'), 10);
});

test('估算：空串与非字符串 = 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(42), 0);
});

test('估算：纯英文 8 字符 = 2 token（ceil(len/4)）', () => {
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('声明：含 adr-101 且 counting 非空', () => {
  assert.equal(TOKENIZER_DECLARATION.adr, 'adr-101');
  assert.ok(typeof TOKENIZER_DECLARATION.counting === 'string' && TOKENIZER_DECLARATION.counting.length > 0);
  assert.equal(TOKENIZER_DECLARATION.generationModel, 'glm-5.3 (zai-coding-cn)');
  assert.equal(TOKENIZER_DECLARATION.exactModelTokenizer, 'unavailable (hosted API)');
});

// ---------- 决策 #7：成本闸门 ----------

const OK_POLICY = { llm: { apiKey: 'sk-test', provider: 'zai', dailyLimitCny: 100 } };

test('成本：policy 缺失 / llm 为空 / 无 apiKey 且无 provider → E_COST_CONFIG_MISSING + stop', () => {
  for (const policy of [undefined, {}, { llm: null }, { llm: {} }, { llm: { dailyLimitCny: 10 } }]) {
    const r = checkCostGate({ policy, usage: { dailyCny: 0 } });
    assert.equal(r.allowed, false, JSON.stringify(policy));
    assert.equal(r.reason, 'E_COST_CONFIG_MISSING');
    assert.equal(r.stop, true);
  }
});

test('成本：超每日金额上限 → E_COST_LIMIT_EXCEEDED + stop', () => {
  const r = checkCostGate({ policy: OK_POLICY, usage: { dailyCny: 100.01 } });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'E_COST_LIMIT_EXCEEDED');
  assert.equal(r.stop, true);
});

test('成本：超每日 token 上限（dailyTokenLimit 存在时）→ E_COST_LIMIT_EXCEEDED + stop', () => {
  const policy = { llm: { apiKey: 'sk-test', provider: 'zai', dailyLimitCny: 100, dailyTokenLimit: 1000 } };
  const r = checkCostGate({ policy, usage: { dailyCny: 1, dailyTokens: 1001 } });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'E_COST_LIMIT_EXCEEDED');
  assert.equal(r.stop, true);
});

test('成本：等于上限仍放行（adr-102 只拦"超"上限，未定义等于——取严格大于，见实现注释）', () => {
  const r = checkCostGate({ policy: OK_POLICY, usage: { dailyCny: 100 } });
  assert.equal(r.allowed, true);
  assert.equal(r.stop, undefined);
});

test('成本：未达上限且有配置 → allowed:true', () => {
  const r = checkCostGate({ policy: OK_POLICY, usage: { dailyCny: 12.5, dailyTokens: 3000 } });
  assert.equal(r.allowed, true);
});
