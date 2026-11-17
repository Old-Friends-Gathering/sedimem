import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { InvertedIndex } from '../../src/index/inverted-index.js';
import { createRecord } from '../../src/core/record.js';
import { createClock } from '../../src/core/clock.js';

const clock = createClock({ now: 1770000000000 });

function rec(text, extra = {}) {
  return createRecord(
    { text, kind: 'fact', subject: 's', predicate: 'p', value: text, source: { agent: 'test' }, ...extra },
    { clock },
  );
}

describe('index/inverted-index', () => {
  test('build + search：命中返回 score>0，未命中返回空', () => {
    const idx = new InvertedIndex({ clock });
    const r1 = rec('deploy branch release one');
    const r2 = rec('报名截止日期 deadline');
    idx.build([r1, r2]);
    const hits = idx.search('deploy release');
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.id && h.score > 0), 'score>0 才返回');
    assert.ok(hits.some((h) => h.id === r1.id));
    assert.equal(idx.search('zzznotin corpus').length, 0, '无命中应返回空数组');
  });

  test('limit 生效', () => {
    const idx = new InvertedIndex({ clock });
    const rs = Array.from({ length: 30 }, (_, i) => rec(`deploy branch item number ${i}`));
    idx.build(rs);
    assert.equal(idx.search('deploy', { limit: 5 }).length, 5);
    assert.equal(idx.search('deploy').length, 10, '默认 limit=10');
  });

  test('add / remove 增量维护', () => {
    const idx = new InvertedIndex({ clock });
    const r1 = rec('redis port six three seven nine');
    const r2 = rec('redis port update');
    idx.build([r1]);
    idx.add(r2);
    let hits = idx.search('update');
    assert.ok(hits.some((h) => h.id === r2.id), 'add 后应可检索');
    idx.remove(r2.id);
    hits = idx.search('update');
    assert.ok(!hits.some((h) => h.id === r2.id), 'remove 后不得再命中');
    assert.ok(idx.search('redis').some((h) => h.id === r1.id), 'r1 不受影响');
  });

  test('filter 由调用方传入：排除项不出现在结果', () => {
    const idx = new InvertedIndex({ clock });
    const r1 = rec('deploy branch alpha', { kind: 'state' });
    const r2 = rec('deploy branch beta', { kind: 'fact' });
    idx.build([r1, r2]);
    const hits = idx.search('deploy branch', { filter: (r) => r.kind === 'fact' });
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.id !== r1.id), 'state 记录应被 filter 排除');
  });

  test('中文 2-gram 检索', () => {
    const idx = new InvertedIndex({ clock });
    const r = rec('部署分支是 release-1');
    idx.build([r]);
    assert.ok(idx.search('部署').some((h) => h.id === r.id));
  });
});
