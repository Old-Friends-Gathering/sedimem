// I33 — 分歧视图不得超组（v0.4 对抗审核 B3 的回归）
// 钉住：无结构记录（subject/predicate 都是 text）不构成 slot 分歧；
//       结构化 slot 仍能列出并 resolve；对无结构记录直接 resolve 必须被拒。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { listConflicts, resolveConflicts } from '../../src/views/conflicts.js';

async function setup() {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i33-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i33', cwd: memoHome });
  return { service, memoHome };
}

test('I33 三条无关自由文本不成分歧 slot，也不会被一条 resolve 连带压制', async () => {
  const { service } = await setup();
  const a = await service.write({ text: 'postgres 的连接池上限是 50', source: { agent: 'cli' } });
  const b = await service.write({ text: 'mysql 的慢查询阈值是 200ms', source: { agent: 'cli' } });
  const c = await service.write({ text: 'redis 的 eviction 用 allkeys-lru', source: { agent: 'cli' } });
  const view = await listConflicts({ service });
  assert.equal(view.slots.length, 0, `自由文本不应构成 slot：${JSON.stringify(view.slots.map((s) => s.key))}`);
  // 即使硬按 slot 值去调，也必须被拒
  await assert.rejects(
    () => resolveConflicts({ service, slot: view.slots[0]?.key ?? '\u0000unstructured', winnerId: a.record.id }),
    (e) => e.code === 'E_INVALID_ARG',
  );
  const after = await service.stats();
  assert.equal(after.active, 3);
  await service.close();
  void b; void c;
});

test('I33 结构化 slot 仍可列出并 resolve（非破坏）', async () => {
  const { service, memoHome } = await setup();
  // 值不可比（不是数字/日期）才会进 disputed；可比数值按裁决 65 走 supersede
  const a = await service.write({ text: '部署目标是蓝环境', subject: 'deploy', predicate: 'target', value: '蓝环境', source: { agent: 'cli' } });
  const b = await service.write({ text: '部署目标是绿环境', subject: 'deploy', predicate: 'target', value: '绿环境', source: { agent: 'cli' } });
  const view = await listConflicts({ service });
  assert.equal(view.slots.length, 1, JSON.stringify(view));
  const slot = view.slots[0];
  assert.equal(slot.records.length, 2);
  const out = await resolveConflicts({ service, slot: slot.key, winnerId: a.record.id });
  assert.equal(out.resolved.length, 1);
  const stats = await service.stats();
  assert.equal(stats.disputed, 0);
  assert.equal(stats.active, 1);
  // 真相层只追加（两条原始写入 + 裁决补丁），没有被物理删除
  const raw = await fsp.readFile(path.join(memoHome, 'items', 'repo:i33.jsonl'), 'utf8');
  assert.ok(raw.trim().split('\n').length >= 4, raw);
  await service.close();
  void b;
});
