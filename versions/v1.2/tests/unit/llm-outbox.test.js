// tests/unit/llm-outbox.test.js — 派生 outbox 队列（生命周期/再入队/并发/attempts/坏行）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enqueueDerive, claimBatch, completeItem, queueStats, MAX_ATTEMPTS,
} from '../../src/llm/outbox.js';

const clock = { now: () => '2026-11-13T10:00:00.000Z' };

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'memo-llm-outbox-'));
}

async function enqueue(home, id, validFrom = 'v1', extra = {}) {
  return enqueueDerive({
    memoHome: home, scope: 'repo:demo', id, validFrom, clock,
    record: { id, validFrom, kind: 'fact' }, ...extra,
  });
}

describe('llm/outbox', () => {
  test('完整生命周期：enqueue → claim → done，统计正确', async () => {
    const home = freshHome();
    try {
      assert.deepEqual(await enqueue(home, 'a'), { enqueued: true });
      assert.deepEqual(await queueStats({ memoHome: home, scope: 'repo:demo' }),
        { pending: 1, claimed: 0, done: 0, dead: 0, total: 1 });
      const { items } = await claimBatch({ memoHome: home, scope: 'repo:demo', clock });
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'a');
      assert.equal(items[0].attempts, 1);
      assert.deepEqual(await completeItem({ memoHome: home, scope: 'repo:demo', id: 'a', validFrom: 'v1', ok: true, clock }), { op: 'done' });
      assert.deepEqual(await queueStats({ memoHome: home, scope: 'repo:demo' }),
        { pending: 0, claimed: 0, done: 1, dead: 0, total: 1 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('已 done 再 enqueue 返回 enqueued:false（幂等）', async () => {
    const home = freshHome();
    try {
      await enqueue(home, 'a');
      await claimBatch({ memoHome: home, scope: 'repo:demo', clock });
      await completeItem({ memoHome: home, scope: 'repo:demo', id: 'a', validFrom: 'v1', ok: true, clock });
      const r = await enqueue(home, 'a');
      assert.deepEqual(r, { enqueued: false });
      assert.equal((await queueStats({ memoHome: home, scope: 'repo:demo' })).total, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('并发 claim 不重复：两次 claimBatch 只有一次领到', async () => {
    const home = freshHome();
    try {
      await enqueue(home, 'a');
      // withLock 串行化两次 claimBatch，第二次应空手而归
      const [r1, r2] = await Promise.all([
        claimBatch({ memoHome: home, scope: 'repo:demo', clock }),
        claimBatch({ memoHome: home, scope: 'repo:demo', clock }),
      ]);
      const claimed = [...r1.items, ...r2.items].filter((i) => i.id === 'a');
      assert.equal(claimed.length, 1, '同一 (id,validFrom) 只能被领取一次');
      // 领取后进入 claimed，重新 claim 也不再返回
      const r3 = await claimBatch({ memoHome: home, scope: 'repo:demo', clock });
      assert.equal(r3.items.length, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('attempts 到 3 判 dead：失败重试两次后第三次 claim 前 dead', async () => {
    const home = freshHome();
    try {
      await enqueue(home, 'a');
      // 第一次 claim 后失败 → 重新回到 pending（attempts=1）
      await claimBatch({ memoHome: home, scope: 'repo:demo', clock });
      assert.deepEqual(
        await completeItem({ memoHome: home, scope: 'repo:demo', id: 'a', validFrom: 'v1', ok: false, clock }),
        { op: 'enqueue' },
      );
      // 第二次 claim 后失败 → attempts=2，仍未达上限
      let { items } = await claimBatch({ memoHome: home, scope: 'repo:demo', clock });
      assert.equal(items.length, 1);
      assert.equal(items[0].attempts, 2);
      await completeItem({ memoHome: home, scope: 'repo:demo', id: 'a', validFrom: 'v1', ok: false, clock });
      // 第三次 claim：attempts 将达 MAX_ATTEMPTS(3)，正常领取；再次失败 → completeItem 直接判 dead
      ({ items } = await claimBatch({ memoHome: home, scope: 'repo:demo', clock }));
      assert.equal(items.length, 1);
      assert.equal(items[0].attempts, 3);
      assert.deepEqual(
        await completeItem({ memoHome: home, scope: 'repo:demo', id: 'a', validFrom: 'v1', ok: false, reason: 'boom', clock }),
        { op: 'dead' },
      );
      const stats = await queueStats({ memoHome: home, scope: 'repo:demo' });
      assert.equal(stats.dead, 1);
      assert.equal(stats.pending, 0);
      assert.equal(MAX_ATTEMPTS, 3);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('已 claim 满 3 次未完成的条目，claimBatch 兜底判死并跳过', async () => {
    const home = freshHome();
    try {
      await enqueue(home, 'a');
      // 手工凑 3 次 claim（无 done），再 claim 应写 dead 且不返回条目
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        // 每次 claim 后重新置回 pending 模拟「卡死后人工重排」
        await claimBatch({ memoHome: home, scope: 'repo:demo', clock });
        await enqueueDerive({ memoHome: home, scope: 'repo:demo', id: 'a', validFrom: 'v1', clock });
      }
      const { items } = await claimBatch({ memoHome: home, scope: 'repo:demo', clock });
      assert.equal(items.length, 0);
      const stats = await queueStats({ memoHome: home, scope: 'repo:demo' });
      assert.equal(stats.dead, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('坏行不阻塞读取：半行 JSON 被跳过，队列照常工作', async () => {
    const home = freshHome();
    try {
      await enqueue(home, 'a');
      const { appendFileSync } = await import('node:fs');
      appendFileSync(join(home, 'derive-queue', 'repo-demo.jsonl'), '{"op":"claim","id":"b","va', 'utf8');
      const { items } = await claimBatch({ memoHome: home, scope: 'repo:demo', clock });
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'a');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('claimBatch 尊重 limit，且带出 record 负载', async () => {
    const home = freshHome();
    try {
      for (const id of ['a', 'b', 'c']) await enqueue(home, id);
      const { items } = await claimBatch({ memoHome: home, scope: 'repo:demo', limit: 2, clock });
      assert.equal(items.length, 2);
      assert.ok(items.every((i) => i.record && i.record.kind === 'fact'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
