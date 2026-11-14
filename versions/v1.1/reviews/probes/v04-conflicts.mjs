// v0.4 架构审核探针：conflicts 视图把全部自由文本记录归入同一个 unstructured 超组。
// 后果 1：互不相关的记忆被展示为同一 slot 的「分歧」；
// 后果 2：resolveConflicts 一次性把该 slot 里其它所有自由文本记录 supersede（可造成静默丢数据）。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { listConflicts, resolveConflicts } from '../../src/views/conflicts.js';

const memoHome = await mkdtemp(path.join(tmpdir(), 'sedimem-v04-conflicts-'));
const scope = 'repo:probe';
const svc = await createMemoryService({ memoHome, scope });

const texts = [
  '今天和产品讨论了搜索页的交互',
  '周末去爬山，天气很好',
  'Node 24 的 fetch 默认走 undici',
];
const ids = [];
for (const text of texts) {
  const r = await svc.write({ text, source: { agent: 'probe' } });
  ids.push(r.record.id);
}

const before = await listConflicts({ service: svc });
const slot = before.slots[0];
const resolved = await resolveConflicts({ service: svc, slot: slot.key, winnerId: ids[0] });

const after = [];
for (const id of ids) {
  const r = await svc.get(id);
  after.push({ text: r.text, status: r.status });
}

console.log(JSON.stringify({
  slot_key_repr: JSON.stringify(slot.key),
  slot_record_count: slot.records.length,
  pair_count: slot.pairs.length,
  disputed_count_in_slot: slot.disputedCount,
  all_unrelated_but_same_slot: true,
  resolve_result: resolved,
  records_after_resolve: after,
}, null, 2));

await svc.close();
