// v0.4 架构审核探针：conflicts 视图对 unstructured 超组做 O(n²) 两两相似度并把所有 pair 放进响应。
// 复现：预置 N 条互不相关的自由文本记忆（subject/predicate 都是默认 text），调 listConflicts。
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRecord } from '../../src/core/record.js';
import { createMemoryService } from '../../src/api/service.js';
import { listConflicts } from '../../src/views/conflicts.js';

const N = Number(process.argv[2] ?? 400);
const memoHome = await mkdtemp(path.join(tmpdir(), 'sedimem-v04-cscale-'));
const scope = 'repo:probe';
await mkdir(path.join(memoHome, 'items'), { recursive: true });

const lines = [];
for (let i = 0; i < N; i++) {
  const r = createRecord({
    text: `unrelated free text memory number ${i} about topic ${i % 97}`,
    source: { agent: 'probe' },
    scope,
  });
  lines.push(JSON.stringify(r));
}
await writeFile(path.join(memoHome, 'items', `${scope}.jsonl`), `${lines.join('\n')}\n`);

const svc = await createMemoryService({ memoHome, scope });
const t0 = Date.now();
const out = await listConflicts({ service: svc });
const ms = Date.now() - t0;
const jsonBytes = Buffer.byteLength(JSON.stringify(out));

console.log(JSON.stringify({
  records: N,
  slots: out.slots.length,
  slot_records: out.slots[0]?.records.length ?? 0,
  pairs_in_slot: out.slots[0]?.pairs.length ?? 0,
  expected_pairs: (N * (N - 1)) / 2,
  disputed_in_slot: out.slots[0]?.disputedCount ?? 0,
  elapsed_ms: ms,
  response_bytes: jsonBytes,
  response_mb: Number((jsonBytes / 1024 / 1024).toFixed(2)),
}, null, 2));
await svc.close();
