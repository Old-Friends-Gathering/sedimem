// tests/unit/create-index.test.js — createIndex 后端路由单测（契约：docs/09-sqlite-index.md §5）
// memory 默认 / sqlite 可用 / 非法 backend / sqlite 不可用（注入假模块）。

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createIndex } from '../../src/index/create-index.js';
import { InvertedIndex } from '../../src/index/inverted-index.js';
import { SqliteIndex } from '../../src/index/sqlite-index.js';

let memoHome;
beforeEach(() => { memoHome = mkdtempSync(join(tmpdir(), 'sedimem-createidx-')); });
afterEach(() => { rmSync(memoHome, { recursive: true, force: true }); });

const clock = { now: () => '2026-01-01T00:00:00Z', nowMs: () => 0 };

describe('index/create-index', () => {
  test('backend=memory（默认，policy 无 index 段）返回 InvertedIndex', () => {
    const idx = createIndex({ policy: {}, memoHome, scope: 'test', clock });
    assert.ok(idx instanceof InvertedIndex);
  });

  test('backend=memory 显式配置返回 InvertedIndex', () => {
    const idx = createIndex({ policy: { index: { backend: 'memory' } }, memoHome, scope: 'test', clock });
    assert.ok(idx instanceof InvertedIndex);
  });

  test('backend=sqlite 且 node:sqlite 可用返回 SqliteIndex', () => {
    const idx = createIndex({ policy: { index: { backend: 'sqlite' } }, memoHome, scope: 'test', clock });
    assert.ok(idx instanceof SqliteIndex);
    idx.close();
  });

  test('非法 backend 抛 E_INVALID_ARG', () => {
    assert.throws(
      () => createIndex({ policy: { index: { backend: 'rocksdb' } }, memoHome, scope: 'test', clock }),
      (e) => e.code === 'E_INVALID_ARG',
    );
  });

  test('sqlite 不可用（注入假 sqlite 模块）抛 E_INDEX_UNAVAILABLE', () => {
    const throwing = {
      DatabaseSync: class { constructor() { throw new Error('node built without sqlite'); } },
    };
    assert.throws(
      () => createIndex({ policy: { index: { backend: 'sqlite' } }, memoHome, scope: 'test', clock, sqliteModule: throwing }),
      (e) => e.code === 'E_INDEX_UNAVAILABLE',
    );
  });

  test('sqlite 模块缺失（注入 null）抛 E_INDEX_UNAVAILABLE', () => {
    assert.throws(
      () => createIndex({ policy: { index: { backend: 'sqlite' } }, memoHome, scope: 'test', clock, sqliteModule: null }),
      (e) => e.code === 'E_INDEX_UNAVAILABLE',
    );
  });

  test('有 sqlite 但无 FTS5（建虚表失败）抛 E_INDEX_UNAVAILABLE', () => {
    // 假模块：DatabaseSync 能打开，但 exec 建 FTS5 虚表时失败
    const noFts5 = {
      DatabaseSync: class {
        constructor() {}
        exec(sql) {
          if (/fts5/i.test(sql)) throw new Error('no such module: fts5');
        }
        close() {}
      },
    };
    assert.throws(
      () => createIndex({ policy: { index: { backend: 'sqlite' } }, memoHome, scope: 'test', clock, sqliteModule: noFts5 }),
      (e) => e.code === 'E_INDEX_UNAVAILABLE',
    );
  });
});
