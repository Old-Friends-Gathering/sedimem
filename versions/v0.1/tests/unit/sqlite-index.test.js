// tests/unit/sqlite-index.test.js — SqliteIndex 单测（契约：docs/09-sqlite-index.md §7）
// 覆盖 7 条：size/add 幂等、中英检索、注入字符、filter/limit、E_INVALID_RECORD、
// buildMatchExpr 纯函数、删库重建。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteIndex, buildMatchExpr, MAX_QUERY_TOKENS } from '../../src/index/sqlite-index.js';
import { createRecord } from '../../src/core/record.js';
import { createClock } from '../../src/core/clock.js';

const clock = createClock({ now: 1770000000000 });

function rec(text, extra = {}) {
  return createRecord(
    { text, kind: 'fact', subject: 's', predicate: 'p', value: text, source: { agent: 'test' }, ...extra },
    { clock },
  );
}

let memoHome;
beforeEach(() => { memoHome = mkdtempSync(join(tmpdir(), 'strata-sqlidx-')); });
afterEach(() => { rmSync(memoHome, { recursive: true, force: true }); });

function newIndex() {
  return new SqliteIndex({ memoHome, scope: 'test', clock });
}

describe('index/sqlite-index', () => {
  test('1. build 后 size 正确；add 幂等（同 id 覆盖不增行）', () => {
    const idx = newIndex();
    const rs = [rec('alpha beta'), rec('gamma delta'), rec('真相层 存储在 jsonl')];
    idx.build(rs);
    assert.equal(idx.size, 3);
    const again = rec('alpha beta overwritten');
    again.id = rs[0].id;
    idx.add(again);
    assert.equal(idx.size, 3, '同 id 覆盖不得增行');
    assert.ok(idx.search('overwritten').some((h) => h.id === rs[0].id), '覆盖后新正文可检索');
  });

  test('2. search：中文命中、英文命中、无命中返回空', () => {
    const idx = newIndex();
    idx.build([
      rec('真相层 items 目录 只追加'),
      rec('去重阈值 默认 0.45'),
      rec('deploy branch release notes'),
    ]);
    const zh = idx.search('真相层');
    assert.ok(zh.length >= 1 && zh.every((h) => h.score > 0), '「真相层」应命中且 score>0');
    const en = idx.search('deploy release');
    assert.ok(en.length >= 1);
    assert.equal(idx.search('zzznotin').length, 0, '无命中返回空数组');
  });

  test('3. 注入字符（" * OR ( -）不抛错且不外溢', () => {
    const idx = newIndex();
    idx.build([rec('plain text record'), rec('另一条中文记录')]);
    for (const q of ['" OR 1=1 --', 'a*b', 'OR (', ' - ', '""', 'NOT (a)']) {
      let hits;
      assert.doesNotThrow(() => { hits = idx.search(q); }, `query=${JSON.stringify(q)} 不得抛错`);
      assert.ok(Array.isArray(hits));
    }
  });

  test('4. filter 在打分后生效；默认 limit=10 与内存实现一致', () => {
    const idx = newIndex();
    const rs = [
      rec('deploy branch alpha', { kind: 'state' }),
      rec('deploy branch beta', { kind: 'fact' }),
      rec('deploy branch gamma', { kind: 'fact' }),
    ];
    idx.build(rs);
    const hits = idx.search('deploy branch', { filter: (r) => r.kind === 'fact' });
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.id !== rs[0].id), 'state 记录应被 filter 排除');
    assert.ok(hits.every((h) => rs.some((r) => r.id === h.id && r.kind === 'fact')), 'filter 收到完整记录字段');

    const many = Array.from({ length: 25 }, (_, i) => rec(`deploy item number ${i}`));
    idx.build(many);
    const unbounded = idx.search('deploy', { limit: undefined });
    // 审核 S1：默认 limit 必须与 InvertedIndex 一致（10），否则同一端口两种默认行为
    assert.equal(idx.search('deploy').length, 10, '默认 limit=10');
    assert.equal(idx.search('deploy', { limit: 25 }).length, 25, '显式 limit 生效');
    assert.equal(idx.search('deploy', { limit: 5 }).length, 5, 'limit 生效');
  });

  test('5. 无 id 记录 add 抛 E_INVALID_RECORD', () => {
    const idx = newIndex();
    assert.throws(() => idx.add({ text: 'no id' }), (e) => e.code === 'E_INVALID_RECORD');
    assert.throws(() => idx.add(null), (e) => e.code === 'E_INVALID_RECORD');
  });

  test('6. buildMatchExpr 纯函数：中文/英文/混合/空串/特殊字符', () => {
    assert.equal(buildMatchExpr(''), null);
    assert.equal(buildMatchExpr('   '), null);
    assert.equal(buildMatchExpr('！！！。'), null, '纯标点归一化后无 token');
    assert.equal(buildMatchExpr('deploy'), '"deploy"');
    assert.equal(buildMatchExpr('deploy release'), '"deploy" OR "release"', 'OR 连接且保留输入顺序');
    assert.equal(buildMatchExpr('the deploy'), '"deploy"', '停用词与内存 tokenize 同源去除');
    assert.equal(buildMatchExpr('真相层'), '"真相" OR "相层"', '中文 2-gram 与 tokenize 一致');
    assert.equal(buildMatchExpr('真相 reindex'), '"真相" OR "reindex"', '单词组不越界造 2-gram');
    // 特殊字符：归一化剥标点后按普通 token 出字面量，无 FTS5 语法含义
    assert.equal(buildMatchExpr('x"q'), '"x" OR "q"', '引号被归一化剥掉');
    assert.equal(buildMatchExpr('x*q'), '"x" OR "q"', '* 被归一化剥掉，无 FTS5 通配语义');
    assert.equal(buildMatchExpr('OR'), null, 'or 是停用词，与内存 tokenize 同源');
    assert.equal(buildMatchExpr('(deploy)'), '"deploy"', '括号被归一化剥掉');
  });

  test('7. 删库重建：删掉 .sqlite 后 build 能重建', () => {
    const idx = newIndex();
    idx.build([rec('first record'), rec('second record')]);
    const path = idx.dbPath;
    idx.close();
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    assert.equal(existsSync(path), false);
    const idx2 = newIndex();
    assert.equal(idx2.size, 0, '库删掉后从空开始');
    idx2.build([rec('first record'), rec('second record'), rec('third 真相层')]);
    assert.equal(idx2.size, 3);
    assert.ok(idx2.search('真相层').length >= 1, '重建后中文可检索');
    idx2.close();
  });

  test('8. 绕过 build 的陈旧索引 fail-loud（E_INDEX_STALE），不静默返回空', () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-sql-stale-'));
    try {
      const first = new SqliteIndex({ memoHome: home, scope: 'repo:stale', clock });
      first.build([rec('deploy branch alpha')]);
      first.close();
      // 直接重开但**不 build**：docs 表里有行、内存副本为空
      const second = new SqliteIndex({ memoHome: home, scope: 'repo:stale', clock });
      try {
        assert.throws(() => second.search('deploy'), (e) => e.code === 'E_INDEX_STALE');
      } finally {
        second.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('9. 超长查询被截断到 MAX_QUERY_TOKENS（不做无界 OR 放大）', () => {
    const idx = newIndex();
    idx.build([rec('deploy branch alpha')]);
    const huge = Array.from({ length: 2000 }, (_, i) => `t${i}`).join(' ');
    const started = Date.now();
    const hits = idx.search(huge);
    assert.ok(Array.isArray(hits));
    assert.ok(Date.now() - started < 500, '超长查询不应线性放大到秒级');
    const expr = buildMatchExpr(huge);
    assert.equal(expr.split(' OR ').length, MAX_QUERY_TOKENS, '应截断到上限');
  });
});
