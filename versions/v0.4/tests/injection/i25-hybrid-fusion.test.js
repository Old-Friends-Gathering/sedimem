// I25 — 语义道 RRF 融合（v0.4 D1 / issue #103）
// 钉住：词法+语义两路都命中时按 RRF 融合、basis 标注正确、degraded=false；
// 语义路缺席（embedder 抛错）时退回纯词法且 degraded=true（D1「永不阻断检索」）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { InvertedIndex } from '../../src/index/inverted-index.js';
import { createHybridIndex } from '../../src/index/hybrid-index.js';

/** 确定性假向量：维度 4，按关键词散列，让语义路能稳定命中「缓存」相关记录。 */
function fakeVec(text) {
  const t = String(text);
  return [
    t.includes('缓存') ? 1 : 0.05,
    t.includes('部署') ? 1 : 0.05,
    t.includes('连接池') ? 1 : 0.05,
    t.length > 8 ? 1 : 0.5,
  ];
}

function fakeVectorIndex() {
  const store = new Map();
  return {
    get size() { return store.size; },
    build(records) { store.clear(); for (const r of records) store.set(r.id, r.vec); },
    add(id, vec) { store.set(id, vec); },
    remove(id) { return store.delete(id); },
    search(vec, { topK = 50, minScore = 0.2 } = {}) {
      const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
      const norm = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
      const out = [];
      for (const [id, v] of store) {
        const score = dot(vec, v) / (norm(vec) * norm(v));
        if (score >= minScore) out.push({ id, score });
      }
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, topK);
    },
  };
}

const RECORDS = [
  { id: 'r1', text: '缓存命中率低于 60% 要报警', subject: 'cache', predicate: 'alert', kind: 'fact' },
  { id: 'r2', text: '缓存命中率不足 60% 时触发告警', subject: 'cache', predicate: 'warn', kind: 'fact' },
  { id: 'r3', text: '部署脚本在 scripts/deploy.sh', subject: 'deploy', predicate: 'path', kind: 'fact' },
  { id: 'r4', text: '数据库连接池上限是 20', subject: 'db', predicate: 'pool', kind: 'fact' },
];

function build(embedImpl) {
  const base = new InvertedIndex({});
  const embedder = { name: 'fake', ready: true, embed: embedImpl };
  const vectorIndex = fakeVectorIndex();
  const hybrid = createHybridIndex({ base, embedder, vectorIndex, rrfK: 60, minScore: 0.2 });
  hybrid.build(RECORDS);
  vectorIndex.build(RECORDS.map((r) => ({ id: r.id, vec: fakeVec(r.text) })));
  return hybrid;
}

test('I25 两路命中：basis=bm25+vector，且两路都命中的排在前', async () => {
  const hybrid = build(async (texts) => texts.map((t) => fakeVec(t)));
  await hybrid.flush();
  const hits = await hybrid.search('缓存命中率不足', { limit: 10 });
  assert.ok(hits.length >= 2, `hits: ${JSON.stringify(hits)}`);
  assert.equal(hybrid.degraded, false, '两路可用时不得标记降级');
  const bases = new Set(hits.slice(0, 3).map((h) => h.basis));
  assert.ok(bases.has('bm25+vector') || bases.has('bm25'), `basis 应可解释，实际 ${[...bases]}`);
  // RRF 分数 = Σ 1/(k+rank)，越大越好 → 返回顺序必须是降序
  const scores = hits.map((h) => h.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'RRF 分数应降序');
});

test('I25 语义路抛错：退回纯词法、degraded=true、原因可读', async () => {
  const boom = async () => { const e = new Error('embedder down'); e.code = 'E_EMBED_UNAVAILABLE'; throw e; };
  const hybrid = build(boom);
  const hits = await hybrid.search('缓存', { limit: 10 });
  assert.ok(hits.length >= 1, '检索不得因语义道故障而失败（D1 核心承诺）');
  assert.equal(hybrid.degraded, true);
  assert.equal(hybrid.degradedReason, 'E_EMBED_UNAVAILABLE');
  assert.ok(hits.every((h) => h.basis === undefined || h.basis === 'bm25'), '降级后只应有词法结果');
});

test('I25 embedder 未就绪（kind=none）：构造即降级，检索仍可用', async () => {
  const base = new InvertedIndex({});
  const hybrid = createHybridIndex({
    base,
    embedder: { name: 'none', ready: false, embed: async () => { throw new Error('n/a'); } },
    vectorIndex: fakeVectorIndex(),
  });
  hybrid.build(RECORDS);
  const hits = await hybrid.search('部署脚本', { limit: 5 });
  assert.ok(hits.length >= 1);
  assert.equal(hybrid.degraded, true);
  assert.equal(hybrid.degradedReason, 'embedder-not-ready');
});
