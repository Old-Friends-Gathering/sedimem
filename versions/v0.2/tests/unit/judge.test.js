import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJudge, ruleJudge } from '../../src/hygiene/judge.js';

// 车道 C 单测（issue #34；契约：docs/02 §3.13 裁决 50）。
// ruleJudge 必须确定性、无 IO：同输入永远同输出，note 写明依据。

function rec({ hits = 0, createdAt = '2026-11-01T00:00:00.000Z', subject = 'monitor.server', predicate = 'port' } = {}) {
  return { hits, createdAt, subject, predicate };
}

const STRONG = { strength: 'strong' };
const WEAK = { strength: 'weak' };

test('judge: strong + 同 slot + hits 不等 → hits 高者胜，note 带依据', () => {
  const j = createJudge();
  assert.equal(j.name, 'rule');
  const a = rec({ hits: 9 });
  const b = rec({ hits: 3 });
  assert.deepEqual(ruleJudge({ pair: STRONG, a, b }), { decision: 'a_wins', note: 'rule:strong+hits(a=9,b=3)' });
  assert.deepEqual(ruleJudge({ pair: STRONG, a: b, b: a }), { decision: 'b_wins', note: 'rule:strong+hits(a=3,b=9)' });
  // 经 createJudge().decide 的同一路径也必须一致
  assert.equal(j.decide({ pair: STRONG, a, b }).decision, 'a_wins');
});

test('judge: strong + 同 slot + hits 相等 → createdAt 更早者胜', () => {
  const early = rec({ createdAt: '2026-10-01T00:00:00.000Z' });
  const late = rec({ createdAt: '2026-11-01T00:00:00.000Z' });
  const out = ruleJudge({ pair: STRONG, a: late, b: early });
  assert.equal(out.decision, 'b_wins');
  assert.match(out.note, /^rule:strong\+createdAt\(a=2026-11-01T00:00:00\.000Z,b=2026-10-01T00:00:00\.000Z\)$/);
  assert.equal(ruleJudge({ pair: STRONG, a: early, b: late }).decision, 'a_wins');
});

test('judge: strong + 同 slot + hits 与 createdAt 完全相等 → keep_both', () => {
  const a = rec();
  const b = rec();
  assert.deepEqual(ruleJudge({ pair: STRONG, a, b }), { decision: 'keep_both', note: 'rule:strong+equal' });
});

test('judge: strong 但 slot 不同 → keep_both', () => {
  const a = rec({ subject: 'deploy', predicate: 'node' });
  const b = rec({ subject: 'build', predicate: 'node' });
  assert.deepEqual(ruleJudge({ pair: STRONG, a, b }), { decision: 'keep_both', note: 'rule:strong-diff-slot' });
});

test('judge: weak → keep_both（含 strength 缺失）', () => {
  const a = rec({ hits: 9 });
  const b = rec({ hits: 0 });
  assert.deepEqual(ruleJudge({ pair: WEAK, a, b }), { decision: 'keep_both', note: 'rule:weak' });
  assert.deepEqual(ruleJudge({ pair: { }, a, b }), { decision: 'keep_both', note: 'rule:weak' });
});

test('judge: policy.curate.judge 名称不认识 → E_POLICY（fail-loud，不静默换默认）', () => {
  assert.throws(
    () => createJudge({ policy: { curate: { judge: 'llm' } } }),
    (e) => e.code === 'E_POLICY' && /unknown judge/.test(e.message),
  );
  // 未配置与显式 'rule' 都必须给出内置裁决器
  assert.equal(createJudge().name, 'rule');
  assert.equal(createJudge({ policy: { curate: { judge: 'rule' } } }).name, 'rule');
});
