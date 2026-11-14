// I51 — 任务库（session:*）必须和普通分库一样可浏览（v1.0.4 / issue #189）
//
// 钉住三件事：
//   1. SCOPE_PATTERN 认 `session:<id>`（少了它 listScopes 会把任务库过滤掉，UI 任务页永远空）
//   2. GET /api/scopes 列出磁盘上真实存在的 session:* 文件（含 records 计数）
//   3. GET /api/records?scope=session:<id> 返回 200 且只含该任务库的记录
// 反例也要钉：`session:../etc/passwd` 这类仍必须 400（放开前缀不能放开穿越）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';
import { SCOPE_PATTERN } from '../../src/core/scope-state.js';

const SRC = { agent: 'test' };

test('I51 SCOPE_PATTERN 接受 session:<id>，仍拒绝路径穿越', () => {
  assert.equal(SCOPE_PATTERN.test('session:20261114-2221-6a5b'), true);
  assert.equal(SCOPE_PATTERN.test('session:1'), true);
  assert.equal(SCOPE_PATTERN.test('session:'), false);
  assert.equal(SCOPE_PATTERN.test('session:../etc/passwd'), false);
  assert.equal(SCOPE_PATTERN.test('session:a/b'), false);
  assert.equal(SCOPE_PATTERN.test('session:UPPER'), false);
});

test('I51 /api/scopes 列出任务库，/api/records?scope= 能读到它的记录', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i51-'));
  const sessionScope = 'session:20261114-2221-6a5b';
  const main = await createMemoryService({ memoHome: home, scope: 'repo:i51', cwd: home });
  await main.write({ text: '主库事实：观察台端口 7788', kind: 'fact', source: SRC });

  // 任务库：像 `memo session start` 一样直接往 session scope 写
  const sess = await createMemoryService({ memoHome: home, scope: sessionScope, cwd: home, session: true });
  await sess.write({ text: '任务：把分库列表修好', kind: 'state', source: SRC });
  await sess.write({ text: '卡点：listScopes 用 SCOPE_PATTERN 过滤掉了 session:', kind: 'gotcha', source: SRC });
  await sess.close();

  const web = await createWebServer({ memoHome: home, scope: 'repo:i51', service: main, port: 0, includeUi: false });
  try {
    const scopesRes = await fetch(`${web.url}api/scopes`);
    assert.equal(scopesRes.status, 200);
    const scopes = (await scopesRes.json()).scopes.map((s) => s.scope);
    assert.ok(scopes.includes('repo:i51'), `主库应在列表里：${scopes.join(',')}`);
    assert.ok(scopes.includes(sessionScope), `任务库应在列表里：${scopes.join(',')}`);

    const recRes = await fetch(`${web.url}api/records?scope=${encodeURIComponent(sessionScope)}`);
    assert.equal(recRes.status, 200, '按任务库取记录必须 200');
    const body = await recRes.json();
    const texts = (body.records ?? []).map((r) => r.text).join('\n');
    assert.match(texts, /把分库列表修好/);
    assert.doesNotMatch(texts, /观察台端口 7788/, '不能串到主库记录');

    // 放开前缀不等于放开穿越
    const bad = await fetch(`${web.url}api/records?scope=${encodeURIComponent('session:../etc/passwd')}`);
    assert.equal(bad.status, 400);
  } finally {
    await web.close();
  }
});
