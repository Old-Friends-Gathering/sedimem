import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVectorIndex, encodeVector, decodeVector } from '../../src/index/vector-index.js';

function fresh() {
  return mkdtempSync(join(tmpdir(), 'memo-vec-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const V = {
  a: [1, 0, 0],
  b: [0.9, 0.1, 0],
  c: [0, 1, 0],
  d: [0, 0, 1],
};

describe('vector-index — base64 float32 编解码', () => {
  test('round-trip 无损', () => {
    const vec = Float32Array.from([0.5, -1.25, 3.75, 0]);
    assert.deepEqual([...decodeVector(encodeVector(vec))], [...vec]);
  });
});

describe('vector-index — build/search/持久化', () => {
  test('build → search 余弦排序 + minScore 过滤 + topK 截断', () => {
    const dir = fresh();
    try {
      const vi = createVectorIndex({ memoHome: dir, scope: 'repo:test', dim: 3 });
      vi.build([
        { id: 'a', vec: V.a },
        { id: 'b', vec: V.b },
        { id: 'c', vec: V.c },
      ]);
      assert.equal(vi.size, 3);
      const hits = vi.search([1, 0, 0], { topK: 2, minScore: 0.5 });
      assert.deepEqual(hits.map((h) => h.id), ['a', 'b'], '余弦降序');
      const strict = vi.search([1, 0, 0], { minScore: 0.995 }); // b 的余弦≈0.9939，被过滤
      assert.equal(strict.length, 1);
      assert.equal(strict[0].id, 'a');
    } finally {
      cleanup(dir);
    }
  });

  test('持久化 $MEMO_HOME/index/<scopeKey>.vectors.jsonl，重开热加载', () => {
    const dir = fresh();
    try {
      const vi = createVectorIndex({ memoHome: dir, scope: 'repo:hot-load', dim: 3 });
      vi.build([{ id: 'a', vec: V.a }]);
      vi.add('d', V.d);
      const file = join(dir, 'index', 'repo-hot-load.vectors.jsonl');
      assert.ok(existsSync(file), 'scopeKeyOf：repo:hot-load → repo-hot-load');
      const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(rows.length, 2);
      assert.deepEqual(Object.keys(rows[0]).sort(), ['dim', 'id', 'model', 'v']);

      // 重开：热加载恢复全部向量与检索语义
      const vi2 = createVectorIndex({ memoHome: dir, scope: 'repo:hot-load' });
      assert.equal(vi2.size, 2);
      const hits = vi2.search(V.d, { minScore: 0.99 });
      assert.equal(hits[0]?.id, 'd');
    } finally {
      cleanup(dir);
    }
  });

  test('add 追加写不重写全文件；remove rewrite 且留 .bak 备份', () => {
    const dir = fresh();
    try {
      const vi = createVectorIndex({ memoHome: dir, scope: 's', dim: 3 });
      vi.build([{ id: 'a', vec: V.a }]);
      const file = join(dir, 'index', 's.vectors.jsonl');
      const before = readFileSync(file, 'utf8');
      vi.add('b', V.b);
      const after = readFileSync(file, 'utf8');
      assert.ok(after.startsWith(before), 'add 是追加写（旧字节原样保留）');

      assert.equal(vi.remove('a'), true);
      assert.equal(vi.remove('nope'), false);
      const bak = `${file}.bak`;
      assert.ok(existsSync(bak), 'rewrite 前备份 .bak');
      assert.ok(readFileSync(bak, 'utf8').includes('"a"'), '.bak 保留删除前的内容');
      assert.ok(!readFileSync(file, 'utf8').includes('"a"'), '主文件已无 a');
      assert.equal(vi.size, 1);
    } finally {
      cleanup(dir);
    }
  });

  test('维度不符 → E_EMBED_DIM_MISMATCH（add 与 search）', () => {
    const dir = fresh();
    try {
      const vi = createVectorIndex({ memoHome: dir, scope: 's', dim: 3 });
      vi.add('a', V.a);
      assert.throws(() => vi.add('bad', [1, 0]), (e) => e.code === 'E_EMBED_DIM_MISMATCH');
      assert.throws(() => vi.search([1, 0]), (e) => e.code === 'E_EMBED_DIM_MISMATCH');
      // 空向量是参数错误
      assert.throws(() => vi.add('empty', []), (e) => e.code === 'E_INVALID_ARG');
      assert.equal(vi.size, 1, '失败写入不得污染索引');
    } finally {
      cleanup(dir);
    }
  });
});
