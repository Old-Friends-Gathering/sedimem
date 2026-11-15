// kind-registry.test.js — issue #33（车道 B）：kind 注册表数据化后的契约单测。
// 覆盖：临时 policy 扩 kind、未登记 kind 拒绝、kindMeta/kindColor 取值、kinds 段校验、
// 以及「旧 halfLifeMs/kindWeight」与「新 kinds」的迁移一致性（衰减值与排序逐项相同）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadPolicy, defaultPolicy, kindNames, kindMeta, kindColor, FALLBACK_KIND_COLOR } from '../../src/config/policy.js';
import { createRecord, validateRecord } from '../../src/core/record.js';
import { monotonicDecay } from '../../src/hygiene/conflict.js';
import { createClock } from '../../src/core/clock.js';

function baseInput(over = {}) {
  return {
    text: 'kind 注册表数据化验证',
    kind: 'fact',
    source: { agent: 'test' },
    ...over,
  };
}

describe('kind 注册表（issue #33）', () => {
  test('临时 policy 登记新 kind（字段齐全）→ createRecord 接受、validateRecord 通过', () => {
    const policy = loadPolicy({
      kinds: { pitfall: { halfLifeMs: 86400000, weight: 1.1, color: '#f97316' } },
    });
    const kinds = kindNames(policy);
    assert.ok(kinds.includes('pitfall'), '临时 policy 应登记 pitfall');

    const clock = createClock({ now: 1770000000000 });
    const rec = createRecord(baseInput({ kind: 'pitfall' }), { clock, kinds });
    assert.equal(rec.kind, 'pitfall');
    assert.equal(validateRecord(rec, kinds).ok, true);

    // 不传 kinds（回落 defaultPolicy）时，pitfall 未登记 → 非法
    assert.equal(validateRecord(rec).ok, false);
  });

  test('未登记 kind → E_INVALID_RECORD，文案保持 "kind: must be one of ..." 形状', () => {
    assert.throws(
      () => createRecord(baseInput({ kind: 'pitfall' }), { kinds: kindNames(defaultPolicy) }),
      (err) => {
        assert.equal(err.code, 'E_INVALID_RECORD');
        assert.match(err.message, /kind: must be one of fact\|pref\|decision\|gotcha\|state, got pitfall/);
        return true;
      },
    );
  });

  test('kindMeta/kindColor 取值正确；未知 kind 的 kindColor 返回兜底色', () => {
    const policy = loadPolicy({ kinds: { pitfall: { halfLifeMs: 86400000, weight: 1.1, color: '#f97316' } } });
    const meta = kindMeta(policy, 'pitfall');
    assert.deepEqual(meta, { halfLifeMs: 86400000, weight: 1.1, color: '#f97316' });

    // 内置 kind 的元数据三类信息齐备且形状正确
    for (const k of kindNames(defaultPolicy)) {
      const m = kindMeta(defaultPolicy, k);
      assert.ok(m.halfLifeMs > 0, `${k}.halfLifeMs 应 > 0`);
      assert.ok(m.weight > 0, `${k}.weight 应 > 0`);
      assert.match(m.color, /^#[0-9a-fA-F]{6}$/);
    }
    assert.equal(kindColor(policy, 'pitfall'), '#f97316');
    assert.equal(kindColor(policy, 'no-such-kind'), FALLBACK_KIND_COLOR);
    // 未知 kind 的 kindMeta 无旧段可回落 → null
    assert.equal(kindMeta(defaultPolicy, 'no-such-kind'), null);
  });

  test('kinds 段新增项缺 halfLifeMs（或 weight/颜色形状错）→ loadPolicy 抛 E_POLICY', () => {
    assert.throws(
      () => loadPolicy({ kinds: { broken: { weight: 1.0, color: '#5b9cf5' } } }),
      (err) => err.code === 'E_POLICY',
    );
    assert.throws(
      () => loadPolicy({ kinds: { broken: { halfLifeMs: 1000, weight: 0, color: '#5b9cf5' } } }),
      (err) => err.code === 'E_POLICY',
    );
    assert.throws(
      () => loadPolicy({ kinds: { broken: { halfLifeMs: 1000, weight: 1.0, color: 'red' } } }),
      (err) => err.code === 'E_POLICY',
    );
  });

  test('迁移一致性：旧 halfLifeMs/kindWeight 与新 kinds 下，衰减值与排序逐项相同', () => {
    const p = defaultPolicy;
    const kindList = kindNames(p);
    // 逐 kind：新旧两份清单的数值必须一一相等（否则衰减/排序口径已漂移）
    for (const k of kindList) {
      assert.equal(kindMeta(p, k).halfLifeMs, p.halfLifeMs[k], `${k} halfLifeMs 新旧不一致`);
      assert.equal(kindMeta(p, k).weight, p.kindWeight[k], `${k} weight 新旧不一致`);
    }
    // 同一批记录：按 service.search 口径（bm25 × kindWeight × recencyDecay × confidence）
    // 分别用旧段与新 kinds 计算最终分并排序，顺序必须逐项相同
    const clock = createClock({ now: 1770000000000 });
    const nowMs = clock.nowMs();
    const records = kindList.map((k, i) => createRecord(
      baseInput({ kind: k, text: `一致性样本 ${k}`, confidence: 0.5 + i * 0.1 }),
      { clock, kinds: kindList },
    ));
    const recencyHalflifeMs = p.search.recencyHalflifeMs;
    const scoreOf = (rec, weight) => {
      const bm25 = 1 + ((rec.text.length * 7) % 13) / 13; // 确定性伪 bm25，只比相对顺序
      const ageMs = Math.max(0, nowMs - Date.parse(rec.createdAt) - rec.text.length * 1e6);
      return bm25 * weight * monotonicDecay(ageMs, recencyHalflifeMs) * rec.confidence;
    };
    function scoreOld(rec) { return scoreOf(rec, p.kindWeight[rec.kind]); }
    function scoreNew(rec) { return scoreOf(rec, kindMeta(p, rec.kind).weight); }
    const idsOld = [...records].sort((a, b) => scoreOld(b) - scoreOld(a)).map((r) => r.id);
    const idsNew = [...records].sort((a, b) => scoreNew(b) - scoreNew(a)).map((r) => r.id);
    assert.deepEqual(idsNew, idsOld, '新旧 kind 权重下的排序结果必须逐项相同');
  });
});
