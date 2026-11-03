import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, utimesSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { withLock } from '../../src/storage/lock.js';
import { JsonlStore } from '../../src/storage/jsonl-store.js';
import { createRecord } from '../../src/core/record.js';
import { createClock } from '../../src/core/clock.js';

const clock = createClock({ now: 1770000000000 });

function rec(id, text, atMs) {
  const c = { nowMs: () => atMs, now: () => new Date(atMs).toISOString() };
  return createRecord(
    { text, kind: 'fact', subject: 's', predicate: 'p', value: text, source: { agent: 'test' }, ...(id ? {} : {}) },
    { clock: c },
  );
}

describe('storage/lock', () => {
  test('withLock 执行 fn 并返回其结果', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    try {
      const out = await withLock(home, async () => 42);
      assert.equal(out, 42);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('互斥：并发第二次获取需等待', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    try {
      const order = [];
      let firstInside = null;
      const firstEntered = new Promise((r) => (firstInside = r));
      const p1 = withLock(home, async () => {
        firstInside(); // 确认 p1 已持锁后才开始 p2，避免抢锁竞速
        await sleep(120);
        order.push('first');
      });
      await firstEntered;
      const p2 = withLock(home, async () => order.push('second'));
      await Promise.all([p1, p2]);
      assert.deepEqual(order, ['first', 'second'], '后进者必须等锁释放');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('陈旧锁（超过 staleMs）可被破除', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    try {
      const lockPath = join(home, '.lock');
      writeFileSync(lockPath, 'stale');
      const old = new Date(Date.now() - 60000);
      utimesSync(lockPath, old, old);
      const out = await withLock(home, async () => 'ok', { staleMs: 30000 });
      assert.equal(out, 'ok', '陈旧锁应被破除并正常执行');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('锁超时：timeoutMs 内拿不到锁 → E_LOCK_TIMEOUT', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    try {
      const slow = withLock(home, () => sleep(500), { timeoutMs: 60000 });
      // 先确保 slow 真的持锁（否则两个 withLock 在 open('wx') 上竞态，测试自身会 flake）
      const lockPath = join(home, '.lock');
      for (let i = 0; i < 400 && !existsSync(lockPath); i += 1) await sleep(5);
      assert.ok(existsSync(lockPath), '前置条件：slow 必须已持有 .lock');
      await assert.rejects(
        withLock(home, async () => 'never', { timeoutMs: 50 }),
        (err) => err instanceof Error && err.code === 'E_LOCK_TIMEOUT',
      );
      await slow;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('storage/jsonl-store', () => {
  test('append + loadScope：按 id fold，最后一行胜出，createdAt 升序', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    const scope = 'repo:t1';
    try {
      const store = new JsonlStore({ memoHome: home });
      const a1 = rec(null, 'v1', 1770000000000);
      const b = rec(null, 'other', 1770000001000);
      const a2 = { ...a1, v: 2, status: 'superseded', validTo: clock.now() };
      await store.append({ ...a1, scope });
      await store.append({ ...b, scope });
      await store.append({ ...a2, scope });

      const loaded = await store.loadScope(scope);
      assert.equal(loaded.length, 2, '同 id 应 fold 为 1 条');
      const aFolded = loaded.find((r) => r.id === a1.id);
      assert.equal(aFolded.v, 2, '最后一行胜出');
      assert.equal(aFolded.status, 'superseded');
      assert.ok(loaded[0].createdAt <= loaded[1].createdAt, '按 createdAt 升序');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('append 只追加：文件行数递增、旧行不变', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    const scope = 'repo:t2';
    try {
      const store = new JsonlStore({ memoHome: home });
      const r1 = { ...rec(null, 'first', 1770000000000), scope };
      await store.append(r1);
      const p = join(home, 'items', `${scope}.jsonl`);
      const before = readFileSync(p, 'utf8');
      await store.append({ ...rec(null, 'second', 1770000002000), scope });
      const after = readFileSync(p, 'utf8');
      assert.ok(after.startsWith(before), 'append 不得改写已有内容');
      assert.equal(after.trim().split('\n').length, 2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('listScopes / appendEvent / readEvents', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    try {
      const store = new JsonlStore({ memoHome: home });
      await store.append({ ...rec(null, 'a', 1770000000000), scope: 'repo:sa' });
      await store.append({ ...rec(null, 'b', 1770000001000), scope: 'dir:sb' });
      const scopes = await store.listScopes();
      assert.ok(scopes.includes('repo:sa') && scopes.includes('dir:sb'));

      for (let i = 0; i < 5; i++) {
        await store.appendEvent({ ts: clock.now(), op: 'write', scope: 'repo:sa', id: `e${i}`, detail: {} });
      }
      const events = await store.readEvents({ limit: 3 });
      assert.equal(events.length, 3, 'readEvents 应尊重 limit');
      const all = await store.readEvents({});
      assert.equal(all.length, 5);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// 裁决 13：JsonlStore 需提供 loadScopeIncremental(scope, fromOffset) 与 fileSize(scope)，
// 供 MemoryService 在写临界区内做尾部增量重读。返回形状未冻结，这里做最小归一后只断言行为。
describe('storage/jsonl-store 增量读与并发（裁决 13）', () => {
  /** 归一 loadScopeIncremental 的返回：支持 {records,nextOffset} / [records,nextOffset] / records+store.fileSize */
  function normalize(res, store, scope) {
    if (Array.isArray(res) && !res.every((x) => x && typeof x === 'object' && 'id' in x)) {
      // [records, nextOffset] 形式
      return { records: res[0], nextOffset: res[1] };
    }
    if (res && Array.isArray(res.records)) return res;
    if (Array.isArray(res)) return { records: res, nextOffset: null };
    throw new Error(`loadScopeIncremental 返回形状无法识别：${JSON.stringify(res)?.slice(0, 120)}`);
  }

  test('loadScopeIncremental：从 0 读全部，从 offset 只读新增', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    const scope = 'repo:inc1';
    try {
      const store = new JsonlStore({ memoHome: home });
      await store.append({ ...rec(null, 'a', 1770000000000), scope });
      await store.append({ ...rec(null, 'b', 1770000001000), scope });

      const first = normalize(await store.loadScopeIncremental(scope, 0), store, scope);
      assert.equal(first.records.length, 2, 'fromOffset=0 应读出全部 2 条');
      const sizeAfter2 = await store.fileSize(scope);
      assert.equal(typeof sizeAfter2, 'number');
      assert.ok(sizeAfter2 > 0, 'fileSize 应为正');
      const next = first.nextOffset ?? sizeAfter2;
      assert.equal(next, sizeAfter2, '读完全量后 offset 应推进到文件大小');

      // 无新增：增量读返回空
      const none = normalize(await store.loadScopeIncremental(scope, next), store, scope);
      assert.equal(none.records.length, 0, '无新增时增量读应返回 0 条');

      // 新增 1 条：只返回那条
      await store.append({ ...rec(null, 'c', 1770000002000), scope });
      const inc = normalize(await store.loadScopeIncremental(scope, next), store, scope);
      assert.equal(inc.records.length, 1, '增量读只应返回新增 1 条');
      assert.equal(inc.records[0].text, 'c');
      if (inc.nextOffset != null) assert.equal(inc.nextOffset, await store.fileSize(scope), '增量 offset 应推进到新文件大小');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('loadScopeIncremental：尾部半行不消费（不返回、不推进 offset）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    const scope = 'repo:inc2';
    try {
      const store = new JsonlStore({ memoHome: home });
      await store.append({ ...rec(null, 'full-line', 1770000000000), scope });
      const p = join(home, 'items', `${scope}.jsonl`);
      const offset0 = await store.fileSize(scope);

      // 模拟另一进程写到一半（无换行、JSON 不完整）
      appendFileSync(p, '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV', 'utf8');
      const partialLen = '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV'.length;

      const res = normalize(await store.loadScopeIncremental(scope, offset0), store, scope);
      assert.equal(res.records.length, 0, '尾部半行不得被当作记录消费');
      const sizeWithPartial = await store.fileSize(scope);
      assert.equal(sizeWithPartial, offset0 + partialLen);
      const next = res.nextOffset ?? null;
      if (next != null) {
        assert.equal(next, offset0, `半行的 offset 不得推进（期望停在 ${offset0}，实际 ${next}）`);
      }

      // 半行补全为完整行后，从原 offset 增量读应恰好拿到这条记录
      appendFileSync(p, 'NDEK","text":"done"}\n', 'utf8');
      const res2 = normalize(await store.loadScopeIncremental(scope, offset0), store, scope);
      assert.equal(res2.records.length, 1, '补全后的行应被增量读消费');
      assert.equal(res2.records[0].id, '01ARZ3NDEKTSV4RRFFQ69G5FAVNDEK');
      if (res2.nextOffset != null) assert.equal(res2.nextOffset, await store.fileSize(scope));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('并发 append 经锁序列化：全部落盘、行数齐全、无坏行', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    const scope = 'repo:inc3';
    try {
      const store = new JsonlStore({ memoHome: home });
      const N = 12;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          store.append({ ...rec(null, `c-${i}`, 1770000000000 + i), scope })),
      );
      const p = join(home, 'items', `${scope}.jsonl`);
      const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
      assert.equal(lines.length, N, `并发 append 后应有 ${N} 行，实际 ${lines.length}`);
      for (let i = 0; i < lines.length; i++) {
        let obj;
        try {
          obj = JSON.parse(lines[i]);
        } catch (e) {
          assert.fail(`第 ${i + 1} 行在并发下损坏: ${e.message}`);
        }
        assert.equal(typeof obj.id, 'string');
      }
      const ids = new Set(lines.map((l) => JSON.parse(l).id));
      assert.equal(ids.size, N, '不得互相覆盖');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('fileSize：不存在的 scope 返回 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    try {
      const store = new JsonlStore({ memoHome: home });
      assert.equal(await store.fileSize('repo:nope'), 0, '不存在的文件 size 应为 0（不是抛错）');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
