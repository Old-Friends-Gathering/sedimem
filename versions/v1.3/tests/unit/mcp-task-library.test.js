// tests/unit/mcp-task-library.test.js — 任务库术语与 MCP 入口契约（v1.3.1）
// 背景：用户说「任务库」时，模型在 task_board_* 与 memory_scope 之间猜错。
// 契约：INSTRUCTIONS / 工具描述必须出现「任务库 = 临时记忆库」；memory_write 支持 session scope；
// 写不存在的任务库必须 fail-loud；参数错误必须提示可用参数。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUCTIONS, TOOL_DEFS } from '../../src/mcp/tools.js';
import { validateArgs } from '../../src/mcp/validate.js';

const VER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = join(VER_DIR, 'src', 'mcp', 'server.js');
const DEFS = new Map(TOOL_DEFS.map((d) => [d.name, d]));

function startServer(memoHome, { memoScope = 'repo:task-library-test' } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: memoScope },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  let nextId = 1;
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* 忽略残行 */ }
    }
  });
  return {
    call(method, params, timeoutMs = 15000) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    async tool(name, args) {
      const msg = await this.call('tools/call', { name, arguments: args });
      const r = msg.result;
      return {
        isError: r?.isError === true,
        text: r?.content?.[0]?.text ?? '',
        structured: r?.structuredContent,
      };
    },
    kill: () => child.kill(),
  };
}

async function withServer(fn, { memoScope } = {}) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-tasklib-'));
  const cli = startServer(memoHome, { memoScope });
  try {
    await cli.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'task-lib-test', version: '1' } });
    await fn(cli, memoHome);
  } finally {
    cli.kill();
    rmSync(memoHome, { recursive: true, force: true });
  }
}

test('术语：INSTRUCTIONS 与工具描述把「任务库」指向 session，而不是记忆分库', () => {
  assert.match(INSTRUCTIONS, /任务库/);
  assert.match(INSTRUCTIONS, /memory_session_start/);
  assert.match(INSTRUCTIONS, /记忆分库/);

  for (const name of ['memory_session_start', 'memory_write', 'memory_scope']) {
    assert.match(DEFS.get(name).description, /任务库/, `${name} 描述应出现「任务库」`);
  }
  assert.match(DEFS.get('memory_session_start').description, /临时记忆库/);
  assert.match(DEFS.get('memory_write').description, /scope:"session:/);
  assert.match(DEFS.get('memory_scope').description, /session:<id>/);
});

test('参数错误时列出可用参数（id/name 猜错时能看到 title）', () => {
  const r = validateArgs(DEFS.get('memory_session_start').inputSchema, { id: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('未知参数: id') && e.includes('可用参数: title, repo')), JSON.stringify(r.errors));
});

test('memory_write 带 session scope 直接写入任务库，且不改变当前分库', async () => {
  await withServer(async (cli) => {
    const started = await cli.tool('memory_session_start', { title: '任务库写入契约' });
    assert.equal(started.isError, false, started.text);
    const scope = started.structured.scope;

    const before = await cli.tool('memory_scope', { action: 'get' });
    assert.equal(before.structured.scope, 'repo:task-library-test');

    const w = await cli.tool('memory_write', {
      text: '决定：任务库入口统一为 memory_session_start',
      kind: 'decision',
      scope,
    });
    assert.equal(w.isError, false, w.text);
    assert.match(w.text, /action=created/);

    const status = await cli.tool('memory_session_status', { scope });
    assert.equal(status.isError, false, status.text);
    assert.equal(status.structured.facts, 1);

    const after = await cli.tool('memory_scope', { action: 'get' });
    assert.equal(after.structured.scope, 'repo:task-library-test', '一次性写任务库不应切走当前分库');
  });
});

test('切到任务库后 close 会恢复到主库，下一次写入不再撞 E_SESSION_CLOSED', async () => {
  await withServer(async (cli) => {
    const started = await cli.tool('memory_session_start', { title: '关闭恢复' });
    const scope = started.structured.scope;
    assert.match(started.text, /checkpoint\/status\/close 需带 scope/);

    const used = await cli.tool('memory_scope', { action: 'use', scope });
    assert.equal(used.isError, false, used.text);

    const closed = await cli.tool('memory_session_close', {});
    assert.equal(closed.isError, false, closed.text);
    assert.match(closed.text, /任务库 .* 已关闭/);

    const after = await cli.tool('memory_scope', { action: 'get' });
    assert.equal(after.structured.scope, 'repo:task-library-test', 'close 后应恢复到主库');

    const w = await cli.tool('memory_write', { text: '关闭后仍可写主库', kind: 'decision' });
    assert.equal(w.isError, false, w.text);
    assert.match(w.text, /action=created/);

    const second = await cli.tool('memory_session_start', { title: '第二个任务库' });
    assert.equal(second.isError, false, second.text);
  });
});

test('memory_write 写不存在的任务库 → E_SESSION_NOT_FOUND；写 repo scope 被 schema 拒', async () => {
  await withServer(async (cli) => {
    const ghost = 'session:20990101-0000-ghost';
    const useGhost = await cli.tool('memory_scope', { action: 'use', scope: ghost });
    assert.equal(useGhost.isError, true);
    assert.match(useGhost.text, /E_SESSION_NOT_FOUND/);
    const still = await cli.tool('memory_scope', { action: 'get' });
    assert.equal(still.structured.scope, 'repo:task-library-test', '失败切换不应改变当前 scope');

    const missing = await cli.tool('memory_write', {
      text: '孤儿决定',
      kind: 'decision',
      scope: 'session:20990101-0000-nope',
    });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /E_SESSION_NOT_FOUND/);
    assert.match(missing.text, /memory_session_start/);

    const repo = await cli.tool('memory_write', {
      text: '不该写 repo',
      kind: 'decision',
      scope: 'repo:other',
    });
    assert.equal(repo.isError, true);
    assert.match(repo.text, /E_INVALID_ARGS/);
  });
});


test('旧覆盖文件指向 ghost 任务库：启动自愈回主库，仍能建新任务库', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-tasklib-heal-'));
  writeFileSync(join(memoHome, '.scope.ghost-client.json'), '{"scope":"session:ghost-stale"}\n');
  const cli = startServer(memoHome, { memoScope: '' });
  try {
    await cli.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'ghost-client', version: '1' } });
    const g = await cli.tool('memory_scope', { action: 'get' });
    assert.equal(g.isError, false, g.text);
    assert.doesNotMatch(g.text, /session:ghost-stale/);
    const started = await cli.tool('memory_session_start', { title: '自愈后新任务库' });
    assert.equal(started.isError, false, started.text);
    assert.match(started.text, /任务库已创建/);
  } finally {
    cli.kill();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('已关闭任务库：use 与 scoped write 都 fail-loud，且不改当前 scope', async () => {
  await withServer(async (cli) => {
    const started = await cli.tool('memory_session_start', { title: '关闭语义' });
    const scope = started.structured.scope;
    await cli.tool('memory_session_close', { scope });
    const use = await cli.tool('memory_scope', { action: 'use', scope });
    assert.equal(use.isError, true);
    assert.match(use.text, /E_SESSION_CLOSED/);
    const w = await cli.tool('memory_write', { text: '写关闭库', kind: 'decision', scope });
    assert.equal(w.isError, true);
    assert.match(w.text, /E_SESSION_CLOSED/);
    const g = await cli.tool('memory_scope', { action: 'get' });
    assert.doesNotMatch(g.text, /session:/);
  });
});
