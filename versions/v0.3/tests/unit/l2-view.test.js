// tests/unit/l2-view.test.js — L2 场景块单测（issue #50 / 施工图 §3）
// 核心不变量：blockId 稳定（同一输入两次构建相等）、一条记录只进一个块、
// 块内 recordIds 按 createdAt 升序、空库不抛、超 maxBlockSize 切片、
// readL2 缺失返回 null、traceRecord 能定位块并发现 stale。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  viewDir, buildL2, writeL2, readL2, traceRecord,
} from '../../src/views/l2.js';
import { scopeKeyOf } from '../../src/config/paths.js';

const POLICY = {
  views: { maxBlockSize: 64 },
  dedupe: { scanThreshold: 0.45, scanDiceThreshold: 0.15 },
};

// 造记录：id 用单调字符串（ULID 语义：字典序 = 时间序），createdAt 显式给出
function rec(id, createdAt, text, extra = {}) {
  return {
    id, v: 1, scope: 'repo:test', kind: 'fact',
    subject: 'text', predicate: 'text', value: text, text,
    status: 'active', validFrom: createdAt, validTo: null,
    createdAt, expiredAt: null, hits: 0, tags: [], source: { agent: 'test' },
    ...extra,
  };
}

test('viewDir 用 scopeKeyOf 拼出 <memoHome>/views/<scopeKey>/', () => {
  assert.equal(viewDir('/mh', 'repo:sedimem'), join('/mh', 'views', scopeKeyOf('repo:sedimem')));
  assert.equal(viewDir('/mh', 'repo:sedimem'), join('/mh', 'views', 'repo-sedimem'));
});

test('稳定 blockId：两次 build 结果完全相等', () => {
  const records = [
    rec('01A', '2026-01-01T00:00:00.000Z', 'sedimem 用 node 内置模块'),
    rec('01B', '2026-01-02T00:00:00.000Z', '零依赖原则', { subject: 'sedimem', predicate: 'dependency' }),
  ];
  const a = buildL2(records, { scope: 'repo:test', policy: POLICY });
  const b = buildL2(records, { scope: 'repo:test', policy: POLICY });
  assert.deepEqual(a, b);
});

test('blockId = sha256(key).slice(0,12)，key 含 slot 前缀', () => {
  const records = [rec('01B', '2026-01-02T00:00:00.000Z', 'v1', { subject: 'sedimem', predicate: 'version' })];
  const { blocks } = buildL2(records, { scope: 'repo:test', policy: POLICY });
  assert.equal(blocks.length, 1);
  const key = blocks[0].key;
  assert.ok(key.startsWith('slot:'), `key 应以 slot: 开头，实际 ${key}`);
  assert.equal(blocks[0].blockId, createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12));
});

test('单 record 单块：一条记录自成一块，stats 完整', () => {
  const records = [rec('01X', '2026-03-01T00:00:00.000Z', '单条', { subject: 's', predicate: 'p', kind: 'decision' })];
  const { blocks, sourceCount, builtAt } = buildL2(records, { scope: 'repo:test', policy: POLICY });
  assert.equal(sourceCount, 1);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].recordIds, ['01X']);
  assert.deepEqual(blocks[0].stats, {
    count: 1,
    activeCount: 1,
    firstAt: '2026-03-01T00:00:00.000Z',
    lastAt: '2026-03-01T00:00:00.000Z',
    kinds: { decision: 1 },
  });
  assert.equal(builtAt, '2026-03-01T00:00:00.000Z');
});

test('块内 recordIds 按 createdAt 升序（乱序输入）', () => {
  const records = [
    rec('03C', '2026-03-03T00:00:00.000Z', 'c', { subject: 's', predicate: 'p' }),
    rec('01A', '2026-01-01T00:00:00.000Z', 'a', { subject: 's', predicate: 'p' }),
    rec('02B', '2026-02-01T00:00:00.000Z', 'b', { subject: 's', predicate: 'p' }),
  ];
  const { blocks } = buildL2(records, { scope: 'repo:test', policy: POLICY });
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].recordIds, ['01A', '02B', '03C']);
});

test('空库：blocks 空数组、sourceCount 0、builtAt null，不抛', () => {
  const built = buildL2([], { scope: 'repo:test', policy: POLICY });
  assert.deepEqual(built.blocks, []);
  assert.equal(built.sourceCount, 0);
  assert.equal(built.builtAt, null);
  assert.ok(typeof built.policyHash === 'string' && built.policyHash.length === 64);
});

test('maxBlockSize 切片：5 条同 slot 上限 2 → key#1..#3，各片 blockId 不同且总量守恒', () => {
  const records = [1, 2, 3, 4, 5].map((i) =>
    rec(`0${i}X`, `2026-01-0${i}T00:00:00.000Z`, `v${i}`, { subject: 's', predicate: 'p' }));
  const { blocks, sourceCount } = buildL2(records, {
    scope: 'repo:test',
    policy: { ...POLICY, views: { maxBlockSize: 2 } },
  });
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.key.endsWith('#1') || b.key.endsWith('#2') || b.key.endsWith('#3') ? b.key.split('#')[1] : null),
    ['1', '2', '3']);
  assert.equal(blocks.filter((b) => !b.key.includes('#')).length, 0, '超限后不允许残留无编号 key');
  const ids = new Set(blocks.flatMap((b) => b.recordIds));
  assert.equal(ids.size, 5);
  assert.equal(blocks.reduce((n, b) => n + b.recordIds.length, 0), sourceCount);
  // 片内保持 createdAt 升序
  assert.deepEqual(blocks[0].recordIds, ['01X', '02X']);
  assert.deepEqual(blocks[2].recordIds, ['05X']);
  // 各片 blockId 互不相同（sha256 的 key 含切片编号）
  assert.equal(new Set(blocks.map((b) => b.blockId)).size, 3);
});

test('unstructured 中文近义改写聚进同一 cluster 块，key 为块内最小 recordId', () => {
  const paraphraseA = rec('10A', '2026-01-01T00:00:00.000Z', '项目必须坚持零运行时依赖，只用 node 内置模块');
  const paraphraseB = rec('10B', '2026-01-02T00:00:00.000Z', '本项目必须坚持零运行时依赖的实现方式');
  const unrelated = rec('10C', '2026-01-03T00:00:00.000Z', '周会上确认了发布节奏由 PM 统一排期');
  const { blocks, sourceCount } = buildL2([paraphraseA, paraphraseB, unrelated], {
    scope: 'repo:test', policy: POLICY,
  });
  const cluster = blocks.filter((b) => b.key.startsWith('cluster:'));
  assert.ok(cluster.length >= 1);
  const pair = cluster.find((b) => b.recordIds.includes('10A') && b.recordIds.includes('10B'));
  assert.ok(pair, '两条中文改写应聚在同一 cluster 块');
  assert.equal(pair.key, 'cluster:10A');
  assert.equal(pair.recordIds[0], '10A');
  // 一条记录只进一个块：全部块 recordIds 展开去重后等于 sourceCount
  assert.equal(new Set(blocks.flatMap((b) => b.recordIds)).size, sourceCount);
});

test('readL2：缺失返回 null；writeL2 后可读回同形状对象', () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'l2-'));
  try {
    assert.equal(readL2(memoHome, 'repo:test'), null);
    const records = [
      rec('01A', '2026-01-01T00:00:00.000Z', 'a', { subject: 's', predicate: 'p' }),
      rec('02B', '2026-01-02T00:00:00.000Z', 'b', { subject: 's', predicate: 'p' }),
    ];
    const built = buildL2(records, { scope: 'repo:test', policy: POLICY });
    writeL2(memoHome, 'repo:test', built);
    const back = readL2(memoHome, 'repo:test');
    assert.deepEqual(back, built);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('traceRecord：返回 blockId 与 sourceRefs；删记录后 stale 命中', () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'l2-'));
  try {
    const records = [
      rec('01A', '2026-01-01T00:00:00.000Z', 'a', { subject: 's', predicate: 'p' }),
      rec('02B', '2026-01-02T00:00:00.000Z', 'b', { subject: 's', predicate: 'p' }),
    ];
    writeL2(memoHome, 'repo:test', buildL2(records, { scope: 'repo:test', policy: POLICY }));
    const hit = traceRecord(memoHome, 'repo:test', '02B', records);
    const expectedBlockId = createHash('sha256').update('slot:s\u0001p', 'utf8').digest('hex').slice(0, 12);
    assert.equal(hit.blockId, expectedBlockId);
    assert.deepEqual(hit.sourceRefs, ['01A', '02B']);
    assert.deepEqual(hit.missing, []);
    assert.deepEqual(hit.stale, []);

    // 真相层少了一条（删除/失效未 rebuild）→ 该 id 进 stale
    const drift = traceRecord(memoHome, 'repo:test', '01A', [records[0]]);
    assert.deepEqual(drift.stale, ['02B']);
    assert.deepEqual(drift.missing, []);
    // 新增未 rebuild 的记录 → missing
    const fresh = rec('09Z', '2026-09-01T00:00:00.000Z', 'z', { subject: 's', predicate: 'p' });
    const added = traceRecord(memoHome, 'repo:test', '01A', [...records, fresh]);
    assert.deepEqual(added.missing, ['09Z']);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('traceRecord：视图不存在 → blockId null、missing 列出全部当前记录', () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'l2-'));
  try {
    const records = [rec('01A', '2026-01-01T00:00:00.000Z', 'a')];
    const r = traceRecord(memoHome, 'repo:test', '01A', records);
    assert.equal(r.blockId, null);
    assert.deepEqual(r.sourceRefs, []);
    assert.deepEqual(r.missing, ['01A']);
    assert.deepEqual(r.stale, []);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('buildL2 不修改入参 records（只读契约）', () => {
  const records = [
    rec('01A', '2026-01-01T00:00:00.000Z', 'a', { subject: 's', predicate: 'p' }),
    rec('02B', '2026-01-02T00:00:00.000Z', 'b'),
  ];
  const snapshot = JSON.parse(JSON.stringify(records));
  buildL2(records, { scope: 'repo:test', policy: POLICY });
  assert.deepEqual(records, snapshot);
});

test('policyHash 只随 views/dedupe 段变化', () => {
  const records = [rec('01A', '2026-01-01T00:00:00.000Z', 'a')];
  const base = buildL2(records, { scope: 'repo:test', policy: POLICY }).policyHash;
  const sameSemantic = buildL2(records, {
    scope: 'repo:test',
    policy: { ...POLICY, brief: { lines: 10 } },
  }).policyHash;
  const changedDedupe = buildL2(records, {
    scope: 'repo:test',
    policy: { ...POLICY, dedupe: { scanThreshold: 0.5, scanDiceThreshold: 0.15 } },
  }).policyHash;
  const changedViews = buildL2(records, {
    scope: 'repo:test',
    policy: { ...POLICY, views: { maxBlockSize: 8 } },
  }).policyHash;
  assert.equal(sameSemantic, base);
  assert.notEqual(changedDedupe, base);
  assert.notEqual(changedViews, base);
});
