// I45 派生队列幂等/重试/死信/坏行容忍
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enqueueDerive, claimBatch, completeItem, queueStats } from '../../src/llm/outbox.js';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'i45-')); }

test('I45 生命周期：enqueue→claim→done，重复入队幂等', async () => {
  const memoHome = await tmp();
  const scope = 'repo:i45';
  assert.deepEqual(await enqueueDerive({ memoHome, scope, id: 'a', validFrom: 't1' }), { enqueued: true });
  const claimed = await claimBatch({ memoHome, scope, limit: 10 });
  assert.equal(claimed.items.length, 1);
  await completeItem({ memoHome, scope, id: 'a', validFrom: 't1', ok: true });
  assert.deepEqual(await enqueueDerive({ memoHome, scope, id: 'a', validFrom: 't1' }), { enqueued: false });
  const stats = await queueStats({ memoHome, scope });
  assert.equal(stats.pending, 0);
});

test('I45b 并发 claim 不重复领取同一批', async () => {
  const memoHome = await tmp();
  const scope = 'repo:i45b';
  for (const id of ['a', 'b', 'c']) await enqueueDerive({ memoHome, scope, id, validFrom: 't' });
  const [x, y] = await Promise.all([
    claimBatch({ memoHome, scope, limit: 3 }),
    claimBatch({ memoHome, scope, limit: 3 }),
  ]);
  const ids = [...x.items, ...y.items].map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, '同一条不得被两次领取');
});

test('I45c 失败重试达上限判 dead，坏行不阻塞读取', async () => {
  const memoHome = await tmp();
  const scope = 'repo:i45c';
  await enqueueDerive({ memoHome, scope, id: 'z', validFrom: 't' });
  const file = path.join(memoHome, 'derive-queue', 'repo-i45c.jsonl');
  // 手动塞坏行（半行 JSON），验证读取端容忍
  await fs.appendFile(file, '{"op":"claim","id":"broken"\n');
  for (let i = 0; i < 3; i += 1) {
    const claimed = await claimBatch({ memoHome, scope, limit: 5 });
    assert.equal(claimed.items.length, 1, `第 ${i + 1} 次应能重试领取`);
    await completeItem({ memoHome, scope, id: 'z', validFrom: 't', ok: false });
  }
  const stats = await queueStats({ memoHome, scope });
  assert.equal(stats.dead, 1, '失败 3 次后应判死');
  assert.equal(stats.pending, 0);
});
