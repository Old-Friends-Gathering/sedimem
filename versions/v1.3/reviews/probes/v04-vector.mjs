// v0.4 架构审核探针：向量模型混用、每次 service init 重复嵌入导致向量文件膨胀、degraded 粘滞。
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createVectorIndex, encodeVector } from '../../src/index/vector-index.js';
import { createHybridIndex } from '../../src/index/hybrid-index.js';
import { InvertedIndex } from '../../src/index/inverted-index.js';

const memoHome = await mkdtemp(path.join(tmpdir(), 'sedimem-v04-vec-'));

// A) 模型混用：契约 61 要求「换模型必须拒绝混用」。
const scopeA = 'repo:mix';
const va = createVectorIndex({ memoHome, scope: scopeA, dim: 3, model: 'model-a' });
va.add('r1', [1, 0, 0]);
const vb = createVectorIndex({ memoHome, scope: scopeA, dim: 3, model: 'model-b' });
const mixedHits = vb.search([1, 0, 0], { topK: 5, minScore: -1 });
vb.add('r2', [0, 1, 0]);
const rawVec = await readFile(path.join(memoHome, 'index', 'repo-mix.vectors.jsonl'), 'utf8');
const models = rawVec.trim().split('\n').map((l) => JSON.parse(l).model);

// B) 每次 build 都重新嵌入全部记录，且不清理旧向量（service init 每次都 build）。
const recs = [
  { id: 'a', subject: 's', predicate: 'p', text: 'alpha' },
  { id: 'b', subject: 's', predicate: 'p', text: 'beta' },
  { id: 'c', subject: 's', predicate: 'p', text: 'gamma' },
];
let embedCalls = 0;
const fake = {
  name: 'fake', dim: 2, ready: true,
  async embed(texts) { embedCalls += texts.length; return texts.map((t) => [1, t.length]); },
};
const vg = createVectorIndex({ memoHome, scope: 'repo:growth', dim: 2, model: 'fake' });
const hy = createHybridIndex({ base: new InvertedIndex(), embedder: fake, vectorIndex: vg, batchSize: 2 });
hy.build(recs);
await hy.flush();
hy.build(recs); // 模拟第二次 createMemoryService（lifecycle.reload 每次都 index.build）
await hy.flush();
const growthRaw = await readFile(path.join(memoHome, 'index', 'repo-growth.vectors.jsonl'), 'utf8');
const growthLines = growthRaw.trim().split('\n').filter(Boolean).length;

// C) 一次失败后 degraded 永久粘住：后续成功也仍报降级。
let failOnce = true;
const flaky = {
  name: 'flaky', dim: 2, ready: true,
  async embed(texts) {
    if (failOnce) { failOnce = false; const e = new Error('boom'); e.code = 'E_EMBED_UNAVAILABLE'; throw e; }
    return texts.map(() => [1, 0]);
  },
};
const vf = createVectorIndex({ memoHome, scope: 'repo:flaky', dim: 2, model: 'flaky' });
const hf = createHybridIndex({ base: new InvertedIndex(), embedder: flaky, vectorIndex: vf, minScore: 0.99 });
hf.build([{ id: 'x', subject: 's', predicate: 'p', text: 'x' }]);
await hf.flush();
await hf.search('anything');
const afterFail = { degraded: hf.degraded, reason: hf.degradedReason };
await hf.search('anything'); // 这次 embed 成功
const afterSuccess = { degraded: hf.degraded, reason: hf.degradedReason };

console.log(JSON.stringify({
  model_mixing: {
    search_hits_from_model_a: mixedHits,
    models_in_file: models,
    refused: false,
  },
  vector_growth: {
    records: recs.length,
    builds: 2,
    embed_calls: embedCalls,
    vector_file_lines: growthLines,
    leak_per_init: growthLines - recs.length,
  },
  degraded_sticky: { after_failed_search: afterFail, after_successful_search: afterSuccess },
  sample_encoded_len: encodeVector([1, 0, 0]).length,
}, null, 2));
