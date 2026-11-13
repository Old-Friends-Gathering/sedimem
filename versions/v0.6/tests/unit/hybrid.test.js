import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rrfFuse, fuseSearch } from '../../src/index/hybrid.js';

// RRF 手算值：k=60，score = Σ 1/(k+rank)
const r = (k, rank) => 1 / (k + rank);

describe('rrfFuse — 手算值核对', () => {
  test('单路：score = 1/(k+rank)，保序', () => {
    const out = rrfFuse([['x', 'y', 'z']], { k: 60 });
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((o) => o.id),
      ['x', 'y', 'z'],
    );
    // 浮点直接对比（同表达式计算，应精确相等）
    assert.equal(out[0].score, r(60, 1));
    assert.equal(out[1].score, r(60, 2));
    assert.equal(out[2].score, r(60, 3));
    assert.deepEqual(out[0].ranks, [1]);
  });

  test('两路重叠 id：score 相加', () => {
    // id 'both'：路1 rank1 + 路2 rank3
    const out = rrfFuse([['both', 'a'], ['b', 'c', 'both']], { k: 60 });
    const both = out.find((o) => o.id === 'both');
    assert.equal(both.score, r(60, 1) + r(60, 3));
    assert.deepEqual(both.ranks, [1, 3]);
    // both 分数最高（两路贡献），应排第一
    assert.equal(out[0].id, 'both');
    const a = out.find((o) => o.id === 'a');
    assert.equal(a.score, r(60, 2));
    assert.deepEqual(a.ranks, [2, undefined]);
  });

  test('k 可调：k=1 时 score = 1/(1+rank)', () => {
    const out = rrfFuse([['x']], { k: 1 });
    assert.equal(out[0].score, 1 / 2);
  });

  test('接受 {id} 对象形态；缺 id 抛错；非法 k 抛 E_INVALID_ARG', () => {
    const out = rrfFuse([[{ id: 'o1' }, { id: 'o2' }]]);
    assert.deepEqual(out.map((o) => o.id), ['o1', 'o2']);
    assert.throws(() => rrfFuse([[{}]]));
    assert.throws(() => rrfFuse([['x']], { k: 0 }), (e) => e.code === 'E_INVALID_ARG');
  });
});

describe('fuseSearch — 融合后改写排名上升（I26 核心语义）', () => {
  // 场景：词法道对「换了说法的事实」排到第 5；语义道把它认到第 1。
  // 融合后它应越过纯词法 top1（bm25+vector 两路贡献 > 单路）。
  const lexical = ['l1', 'l2', 'l3', 'l4', 'para'].map((id) => ({ id, score: 0.5 }));
  const semantic = ['para', 's2', 's3'].map((id) => ({ id, score: 0.9 }));

  test('两路命中 basis=bm25+vector，改写条目排名上升到融合 top1', () => {
    const { items, degraded } = fuseSearch({ lexical, semantic, k: 60 });
    assert.equal(degraded, false);
    const byId = new Map(items.map((it) => [it.id, it]));
    const para = byId.get('para');
    assert.equal(para.basis, 'bm25+vector');
    assert.equal(para.lexicalRank, 5);
    assert.equal(para.vectorRank, 1);
    // 手算：para = 1/65 + 1/61；词法 top1 l1 = 1/61（未进语义道）→ para 胜出
    assert.equal(para.score, r(60, 5) + r(60, 1));
    assert.equal(byId.get('l1').score, r(60, 1));
    assert.ok(para.score > byId.get('l1').score);
    assert.equal(items[0].id, 'para', '融合后改写条目应升到第 1');
    // 单路命中
    assert.equal(byId.get('l2').basis, 'bm25');
    assert.equal(byId.get('s2').basis, 'vector');
    assert.equal(byId.get('l2').vectorRank, undefined);
  });

  test('语义道缺席 → degraded=true，纯词法保序，basis=bm25', () => {
    const { items, degraded } = fuseSearch({ lexical, semantic: null, k: 60 });
    assert.equal(degraded, true);
    assert.ok(items.every((it) => it.basis === 'bm25'));
    assert.deepEqual(items.map((it) => it.id).slice(0, 3), ['l1', 'l2', 'l3']);
    assert.ok(items.every((it) => it.vectorRank === undefined));
  });

  test('词法道缺席 → degraded=true，basis=vector', () => {
    const { items, degraded } = fuseSearch({ lexical: null, semantic });
    assert.equal(degraded, true);
    assert.equal(items[0].id, 'para');
    assert.ok(items.every((it) => it.basis === 'vector' || it.basis === 'bm25+vector'));
  });

  test('两路皆空 → 空结果且不算降级', () => {
    const { items, degraded } = fuseSearch({ lexical: [], semantic: [] });
    assert.deepEqual(items, []);
    assert.equal(degraded, false);
  });
});
