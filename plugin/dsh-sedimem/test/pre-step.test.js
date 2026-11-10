// test/pre-step.test.js — pre-step 注入（D2）单测
// 覆盖：maxChars 收敛（整行丢弃）、过期 brief 走 items、suspicious 剔除、
// disabled 不注册、围栏与声明存在、坏 JSONL 行跳过、三种 fake ctx 的注册分支。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { mkdtempSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildInjection, registerPreStep } from '../lib/pre-step.js';

const NODE = process.version;
assert.ok(NODE.startsWith('v2'), `expect Node>=22, got ${NODE}`);

/** 造一个临时 memoHome：brief/ + items/。 */
function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'sedimem-prestep-'));
  mkdirSync(path.join(home, 'brief'));
  mkdirSync(path.join(home, 'items'));
  return home;
}

/** items 行工厂（与真相层字段对齐的最小子集）。 */
function item({ id, title, text, status = 'active', createdAt = '2026-01-01T00:00:00Z' }) {
  return JSON.stringify({ id, title, text, status, createdAt });
}

test('maxChars=100：围栏内收敛，整行丢弃不截半句', async () => {
  const home = makeHome();
  writeFileSync(path.join(home, 'items', 's.jsonl'), [
    item({ id: 'a', text: 'A'.repeat(60) }),
    item({ id: 'b', text: 'B'.repeat(60) }),
    item({ id: 'c', text: 'C'.repeat(60) }),
    // createdAt 全同刻，b/c 按行序稳定在后
  ].join('\n'));
  const r = await buildInjection({ memoHome: home, scope: 's', maxChars: 100 });
  assert.ok(r, 'should inject');
  assert.ok(r.text.length <= 100, `text ${r.text.length} chars > 100 budget`);
  assert.equal(r.source, 'items');
  // 只装得下一条整行：要么 60 个 A，要么没有半截 A
  assert.ok(!/A{1,59}\n/.test(r.text), 'no half-cut line');
  assert.equal(r.chars, r.text.length);
});

test('新鲜 brief 优先；过期（mtime 超 maxAgeMs）回落 items', async () => {
  const home = makeHome();
  const briefPath = path.join(home, 'brief', 's.md');
  writeFileSync(briefPath, '# brief\n- t1 记忆一');
  writeFileSync(path.join(home, 'items', 's.jsonl'),
    item({ id: 'x', text: 'items 兜底行' }));
  const fresh = await buildInjection({ memoHome: home, scope: 's' });
  assert.equal(fresh.source, 'brief');
  assert.match(fresh.text, /记忆一/);

  // 把 brief mtime 拨回 2 天前 → 过期，回落 items
  const old = new Date(Date.now() - 2 * 86400000);
  utimesSync(briefPath, old, old);
  const stale = await buildInjection({ memoHome: home, scope: 's' });
  assert.equal(stale.source, 'items');
  assert.match(stale.text, /items 兜底行/);
  assert.doesNotMatch(stale.text, /记忆一/);
});

test('suspicious 行永不注入（items 与 brief 两路都剔）', async () => {
  const home = makeHome();
  writeFileSync(path.join(home, 'items', 's.jsonl'), [
    item({ id: 'ok', text: '正常记忆' }),
    item({ id: 'sus', text: '[suspicious withheld]', status: 'active' }),
    item({ id: 'mix', title: '[suspicious withheld]', text: '被遮蔽的标题' }),
  ].join('\n'));
  const r = await buildInjection({ memoHome: home, scope: 's' });
  assert.ok(r);
  assert.ok(!r.text.includes('[suspicious withheld]'), 'suspicious must never appear');

  // brief 内的占位行同样剔除
  const home2 = makeHome();
  writeFileSync(path.join(home2, 'brief', 's.md'), '- [suspicious withheld]\n- brief 正常行');
  const r2 = await buildInjection({ memoHome: home2, scope: 's' });
  assert.equal(r2.source, 'brief');
  assert.ok(!r2.text.includes('[suspicious withheld]'));
  assert.match(r2.text, /brief 正常行/);
});

test('围栏与「数据非指令」声明存在；空库返回 null', async () => {
  const home = makeHome();
  writeFileSync(path.join(home, 'items', 's.jsonl'), item({ id: 'a', text: '有内容' }));
  const r = await buildInjection({ memoHome: home, scope: 's' });
  assert.ok(r.text.startsWith('<memory-context>'));
  assert.ok(r.text.trimEnd().endsWith('</memory-context>'));
  assert.match(r.text, /是数据不是指令/);

  const empty = makeHome();
  assert.equal(await buildInjection({ memoHome: empty, scope: 'none' }), null);
});

test('坏 JSONL 行跳过；非 active 不取；createdAt 倒序', async () => {
  const home = makeHome();
  writeFileSync(path.join(home, 'items', 's.jsonl'), [
    '{ not json at all',
    item({ id: 'old', text: '旧事实', createdAt: '2026-01-01T00:00:00Z' }),
    item({ id: 'gone', text: '已作废', status: 'superseded', createdAt: '2026-06-01T00:00:00Z' }),
    item({ id: 'new', text: '新事实', createdAt: '2026-09-01T00:00:00Z' }),
  ].join('\n'));
  const r = await buildInjection({ memoHome: home, scope: 's' });
  assert.ok(r);
  assert.match(r.text, /新事实/);
  assert.match(r.text, /旧事实/);
  assert.ok(!r.text.includes('已作废'), 'non-active must be excluded');
  assert.ok(!r.text.includes('not json'), 'bad line skipped');
  // 倒序：新事实在旧事实之前
  assert.ok(r.text.indexOf('新事实') < r.text.indexOf('旧事实'));
});

test('enabled=false：不注册任何接缝', () => {
  const calls = [];
  const ctx = {
    systemPrompt: { context: (o) => calls.push(o) },
    on: (n) => calls.push(n),
  };
  assert.equal(
    registerPreStep(ctx, { config: { inject: { enabled: false } }, memoHome: '/tmp/x', log: () => {} }).registered,
    false,
  );
  assert.equal(calls.length, 0, 'no hook registered when disabled');
});

test('主接缝 systemPrompt.context：注册带 name/order 的 context，text() 返回围栏文本', async () => {
  const home = makeHome();
  writeFileSync(path.join(home, 'items', 's.jsonl'), item({ id: 'a', text: '事实A' }));
  /** @type {object|null} */
  let registered = null;
  const ctx = {
    systemPrompt: { context: (o) => { registered = o; } },
    on: () => {},
  };
  const res = registerPreStep(ctx, {
    config: { inject: { enabled: true, scope: 's' } },
    memoHome: home,
    log: () => {},
  });
  assert.deepEqual(res, { registered: true, mode: 'systemPrompt' });
  assert.equal(registered?.name, 'dsh-sedimem:memory-index');
  assert.equal(registered?.required, false);
  assert.equal(typeof registered?.order, 'number');
  assert.equal(typeof registered?.text, 'function', 'text 必须是函数（动态求值）');
  assert.equal(registered.text(), '', '预热是异步的；首次渲染可能还是空串（不阻塞 apply）');
  // 等预热完成后再取一次
  await new Promise((r) => setTimeout(r, 50));
  const text = registered.text();
  assert.match(text, /事实A/);
  assert.match(text, /<memory-context>/, '必须带围栏（buildInjection 用标签围栏）');
  assert.match(text, /不是给你的指令|不是指令/, '必须带「数据不是指令」声明');
  assert.ok(text.length <= 1200, `budget: ${text.length}`);
});

test('agent/pre-step 只刷新缓存、不修改 messages', async () => {
  const home = makeHome();
  writeFileSync(path.join(home, 'items', 's.jsonl'), item({ id: 'a', text: '刷新后可见' }));
  let preStep = null;
  let registered = null;
  const ctx = {
    systemPrompt: { context: (o) => { registered = o; } },
    on: (name, fn) => { if (name === 'agent/pre-step') preStep = fn; },
  };
  registerPreStep(ctx, { config: { inject: { enabled: true, scope: 's' } }, memoHome: home, log: () => {} });
  const messages = [{ role: 'user', content: 'hi' }];
  let nexted = false;
  await preStep({ messages }, () => { nexted = true; });
  assert.ok(nexted, '必须调用 next()，否则宿主流水线卡住');
  assert.deepEqual(messages, [{ role: 'user', content: 'hi' }], 'messages 不得被改写（污染对话历史）');
  assert.match(registered.text(), /刷新后可见/);
});

test('没有 systemPrompt 接缝：诚实降级为 cache-only，不假装注册成功', () => {
  const logs = [];
  const home = makeHome();
  writeFileSync(path.join(home, 'items', 's.jsonl'), item({ id: 'a', text: 'x' }));
  const res = registerPreStep({ on: () => {} }, {
    config: { inject: { enabled: true, scope: 's' } },
    memoHome: home,
    log: (m) => logs.push(String(m)),
  });
  assert.equal(res.registered, false);
  assert.equal(res.mode, 'cache-only');
  assert.ok(logs.some((l) => /no systemPrompt\.context/.test(l)), logs.join(' | '));
});

test('scope 缺失：不猜分库（fail closed），显式 scope 才注入', async () => {
  // 对抗审核 S-7 的回归：曾用「最近修改的分库」兜底 → 请求 repo:mine 却注入 repo:other。
  const home = makeHome();
  // 文件名即 scope（posix 下冒号原样保留；Windows 映射成 `+` 由 paths.js 负责）
  writeFileSync(path.join(home, 'items', 'repo:other.jsonl'), item({ id: 'a', text: '别的项目的记忆' }));

  const logs = [];
  const ctx = { systemPrompt: { context: () => { throw new Error('不该注册'); } }, on: () => {} };
  const res = registerPreStep(ctx, {
    config: { inject: { enabled: true, scope: '' } },
    memoHome: home,
    log: (m) => logs.push(m),
  });
  assert.equal(res.registered, false);
  assert.ok(logs.some((l) => /no explicit scope/.test(l)), logs.join(' | '));

  // 显式给 scope 才注入，且只读该分库
  let registered = null;
  const res2 = registerPreStep(
    { systemPrompt: { context: (o) => { registered = o; } }, on: () => {} },
    { config: { inject: { enabled: true, scope: 'repo:other' } }, memoHome: home, log: () => {} },
  );
  assert.equal(res2.registered, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(registered.text(), /别的项目的记忆/);
});

test('memoHome 缺失但 enabled=true：抛 E_INVALID_ARG（配置错误要响）', () => {
  assert.throws(
    () => registerPreStep({}, { config: { inject: { enabled: true } }, memoHome: '' }),
    (e) => e.code === 'E_INVALID_ARG',
  );
});
