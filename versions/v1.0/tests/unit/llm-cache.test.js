// tests/unit/llm-cache.test.js — LLM 缓存单测（键 / 命中 / 最后一条胜出 / compact）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cacheKey, readCache, writeCache } from '../../src/llm/cache.js';

function tmpHome(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'memo-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cacheKey：sha256 且对四个字段敏感、顺序敏感', () => {
  const a = cacheKey('m1', 'v1', 'derive', 'input');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, cacheKey('m1', 'v1', 'derive', 'input')); // 稳定
  assert.notEqual(a, cacheKey('m2', 'v1', 'derive', 'input'));
  assert.notEqual(a, cacheKey('m1', 'v2', 'derive', 'input'));
  assert.notEqual(a, cacheKey('m1', 'v1', 'brief', 'input'));
  assert.notEqual(a, cacheKey('m1', 'v1', 'derive', 'input2'));
  assert.notEqual(a, cacheKey('m1v1', 'derive', 'input', '')); // 拼接歧义也不同
});

test('读缓存：文件不存在返回 null', async (t) => {
  const home = tmpHome(t);
  assert.equal(await readCache(home, cacheKey('m', 'v', 'derive', 'x')), null);
});

test('缓存命中：写入后同 key 可读回', async (t) => {
  const home = tmpHome(t);
  const key = cacheKey('m1', 'p1', 'derive', 'same input');
  await writeCache(home, key, { ok: true, text: 'cached text', usage: { inTokens: 1, outTokens: 2 } }, { clock: () => 100 });
  const hit = await readCache(home, key);
  assert.ok(hit);
  assert.equal(hit.value.text, 'cached text');
  assert.deepEqual(hit.value.usage, { inTokens: 1, outTokens: 2 });
  assert.equal(hit.ts, 100);
});

test('不同 key 不命中', async (t) => {
  const home = tmpHome(t);
  await writeCache(home, cacheKey('m1', 'p1', 'derive', 'a'), { ok: true, text: 'A' }, { clock: () => 1 });
  assert.equal(await readCache(home, cacheKey('m1', 'p1', 'derive', 'b')), null);
});

test('重复 key：取最后一条（append-only，最后写入胜出）', async (t) => {
  const home = tmpHome(t);
  const key = cacheKey('m1', 'p1', 'brief', 'q');
  await writeCache(home, key, { ok: true, text: 'first' }, { clock: () => 1 });
  await writeCache(home, key, { ok: true, text: 'second' }, { clock: () => 2 });
  await writeCache(home, key, { ok: true, text: 'third' }, { clock: () => 3 });
  const hit = await readCache(home, key);
  assert.equal(hit.value.text, 'third');
  assert.equal(hit.ts, 3);
});

test('坏行跳过：半行写入不影响读取', async (t) => {
  const home = tmpHome(t);
  const dir = path.join(home, 'llm');
  mkdirSync(dir, { recursive: true });
  const key = cacheKey('m', 'p', 'derive', 'x');
  const good = JSON.stringify({ key, value: { ok: true, text: 'good' }, ts: 1 });
  writeFileSync(path.join(dir, 'cache.jsonl'), good + '\n{"key": "broken');
  const hit = await readCache(home, key);
  assert.equal(hit.value.text, 'good');
});

test('超 2000 行：只扫尾部 2000 行仍能命中最新', async (t) => {
  const home = tmpHome(t);
  const dir = path.join(home, 'llm');
  mkdirSync(dir, { recursive: true });
  const key = cacheKey('m', 'p', 'derive', 'needle');
  // 手写 2001 行：第 1 行是目标 key 的旧值，其余是干扰；append 后应为 2001 行
  const lines = [JSON.stringify({ key, value: { ok: true, text: 'old' }, ts: 0 })];
  for (let i = 0; i < 2000; i++) {
    lines.push(JSON.stringify({ key: `filler-${i}`, value: { ok: true, text: `f${i}` }, ts: i + 1 }));
  }
  writeFileSync(path.join(dir, 'cache.jsonl'), lines.join('\n') + '\n');
  // 旧值在头部（尾部 2000 行扫不到）→ 未命中；这验证「只扫尾部」的语义
  assert.equal(await readCache(home, key), null);
  // 再写一次同 key（进尾部）→ 命中新值
  await writeCache(home, key, { ok: true, text: 'fresh' }, { clock: () => 9999 });
  const hit = await readCache(home, key);
  assert.equal(hit.value.text, 'fresh');
});

test('写入超 2000 行触发 compact：原子重写保留最新 2000 条且仍可读', async (t) => {
  const home = tmpHome(t);
  let compactedWith = null;
  const keys = [];
  // 写 2001 次：第 2001 次写入后 2001 行 > 2000 → compact 保留最新 2000 条
  for (let i = 0; i < 2001; i++) {
    const key = cacheKey('m', 'p', 'derive', `item-${i}`);
    keys.push(key);
    await writeCache(home, key, { ok: true, text: `v${i}` }, { clock: () => i, compacted: (n) => { compactedWith = n; } });
  }
  assert.equal(compactedWith, 2000);
  const lines = readFileSync(path.join(home, 'llm', 'cache.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2000); // compact 后恰好 2000 条
  // 最旧的 item-0 已被挤掉
  assert.equal(await readCache(home, keys[0]), null);
  // 最新的仍在，且是 2000 条里最后一条
  const hit = await readCache(home, keys[2000]);
  assert.equal(hit.value.text, 'v2000');
});

test('compact 后写入仍 append，读取正常', async (t) => {
  const home = tmpHome(t);
  const key = cacheKey('m', 'p', 'brief', 'after-compact');
  for (let i = 0; i < 2001; i++) {
    await writeCache(home, cacheKey('m', 'p', 'derive', `x-${i}`), { ok: true, text: `t${i}` }, { clock: () => i });
  }
  await writeCache(home, key, { ok: true, text: 'post' }, { clock: () => 5000 });
  const hit = await readCache(home, key);
  assert.equal(hit.value.text, 'post');
});

test('cacheKey 对中文与空串正常工作', async (t) => {
  const home = tmpHome(t);
  const key = cacheKey('glm-5.3-flash', 'v1', 'checkpoint', '中文输入 ünïcode');
  await writeCache(home, key, { ok: true, text: '中文缓存' }, { clock: () => 7 });
  assert.equal((await readCache(home, key)).value.text, '中文缓存');
});
