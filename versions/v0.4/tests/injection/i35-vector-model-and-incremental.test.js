// I35 — 向量索引的模型隔离与在线增量（v0.4 对抗审核 B5 / B6 的回归）
// 钉住：①换模型后旧模型的行不得参与检索（且加载时清理文件）；②hybrid 的 add 单参调用也产向量。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVectorIndex } from '../../src/index/vector-index.js';
import { createHybridIndex } from '../../src/index/hybrid-index.js';

const vecFile = (home, scope) => path.join(home, 'index', `${scope.replace(/[^a-z0-9._-]/gi, '-')}.vectors.jsonl`);

test('I35 模型变化：旧模型向量被跳过并从文件清理', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i35-'));
  const scope = 'repo:i35';
  const a = createVectorIndex({ memoHome: home, scope, model: 'model-a' });
  a.add('r1', [1, 0, 0]);
  a.add('r2', [0, 1, 0]);
  assert.equal(a.size, 2);

  const raw = await fsp.readFile(vecFile(home, scope), 'utf8');
  assert.match(raw, /model-a/, '换模型前的文件应带 model-a');

  const b = createVectorIndex({ memoHome: home, scope, model: 'model-b' });
  assert.equal(b.size, 0, '不同模型的向量不得进入新索引');
  const cleaned = await fsp.readFile(vecFile(home, scope), 'utf8');
  assert.equal(cleaned.includes('model-a'), false, '加载时应把不匹配模型的行清理掉');
});

test('I35 hybrid 的 add 支持单参（lifecycle/commit 的既有调用形状）并真的产向量', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i35b-'));
  const base = {
    _rows: new Map(),
    add(rec) { this._rows.set(rec.id, rec); },
    remove(id) { this._rows.delete(id); },
    build(recs) { this._rows = new Map((recs ?? []).map((r) => [r.id, r])); },
    search() { return []; },
    get size() { return this._rows.size; },
  };
  const embedder = { ready: true, model: 'fake', dim: 3, embed: async () => [[1, 0, 0]] };
  const vectorIndex = createVectorIndex({ memoHome: home, scope: 'repo:i35b', model: 'fake', dim: 3 });
  const hybrid = createHybridIndex({ base, embedder, vectorIndex, rrfK: 60, vectorTopK: 10, minScore: 0 });
  hybrid.add({ id: 'single-arg', text: '单参调用的记录' });
  await hybrid.flush();
  assert.equal(vectorIndex.size, 1, 'hybrid.add(record) 必须写向量');
  hybrid.add('two-arg', { id: 'two-arg', text: '双参调用的记录' });
  await hybrid.flush();
  assert.equal(vectorIndex.size, 2, 'hybrid.add(id, record) 也必须写向量');
});
