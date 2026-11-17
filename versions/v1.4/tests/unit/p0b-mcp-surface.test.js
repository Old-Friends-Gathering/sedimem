// p0b B6.1：MCP 工具面 `--surface core|all` 与 `--session-tools`。
// 兼容红线：无参数默认 all（17 个）——老客户端不带参数，升级后绝不能静默少工具。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_TOOL_NAMES, TOOL_DEFS, toolsForSurface } from '../../src/mcp/tools.js';

const VER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = join(VER_DIR, 'src', 'mcp', 'server.js');
const CLI = join(VER_DIR, 'src', 'cli', 'memo.js');

function startServer(memoHome, args = [], entry = SERVER) {
  const child = spawn(process.execPath, [entry, ...(entry === CLI ? ['mcp', ...args] : args)], {
    env: { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: 'repo:p0b-surface' },
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
      } catch { /* 残行 */ }
    }
  });
  return {
    call(method, params, timeoutMs = 15000) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), timeoutMs);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    kill: () => child.kill(),
  };
}

async function toolNames(server) {
  const init = await server.call('initialize', {
    protocolVersion: '2025-06-18', clientInfo: { name: 'surface-test', version: '1' },
  });
  assert.ok(init.result);
  const list = await server.call('tools/list', {});
  return list.result.tools.map((t) => t.name).sort();
}

async function withServer(fn, args, entry = SERVER) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-surface-'));
  const server = startServer(memoHome, args, entry);
  try {
    await fn(server);
  } finally {
    server.kill();
    rmSync(memoHome, { recursive: true, force: true });
  }
}

test('B6.1 toolsForSurface：core=3，all=17，core+session-tools=10', () => {
  assert.deepEqual(CORE_TOOL_NAMES, ['memory_search', 'memory_write', 'memory_brief']);
  assert.equal(toolsForSurface('all').length, TOOL_DEFS.length);
  assert.equal(toolsForSurface('all').length, 17);
  assert.deepEqual(toolsForSurface('core').map((t) => t.name).sort(), [...CORE_TOOL_NAMES].sort());
  assert.equal(toolsForSurface('core', { sessionTools: true }).length, 10);
});

test('B6.1 无参数默认 all：老客户端不漏工具', async () => {
  await withServer(async (server) => {
    const names = await toolNames(server);
    assert.equal(names.length, 17);
    assert.ok(names.includes('memory_get'));
    assert.ok(names.includes('memory_session_start'));
  }, []);
});

test('B6.1 --surface core 只暴露 3 个工具；未暴露的工具调用被拒绝', async () => {
  await withServer(async (server) => {
    const names = await toolNames(server);
    assert.deepEqual(names, [...CORE_TOOL_NAMES].sort());
    const msg = await server.call('tools/call', { name: 'memory_get', arguments: { id: 'x' } });
    assert.equal(msg.error?.code, -32601, 'core 面下 memory_get 必须不可见不可调');
  }, ['--surface', 'core']);
});

test('B6.1 --surface core --session-tools = 10；--surface=all 显式等于默认', async () => {
  await withServer(async (server) => {
    const names = await toolNames(server);
    assert.equal(names.length, 10);
    assert.ok(names.includes('memory_search'));
    assert.ok(names.includes('memory_session_close'));
  }, ['--surface', 'core', '--session-tools']);
  await withServer(async (server) => {
    const names = await toolNames(server);
    assert.equal(names.length, 17);
  }, ['--surface=all']);
});

test('B6.1 memo mcp 子命令把参数原样转给 server（CLI 入口）', async () => {
  await withServer(async (server) => {
    const names = await toolNames(server);
    assert.equal(names.length, 3);
  }, ['--surface', 'core'], CLI);
});

test('B6.1 非法 --surface 立刻失败（不被当成 all 静默降级）', () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-surface-bad-'));
  try {
    const r = spawnSync(process.execPath, [SERVER, '--surface', 'tiny'], {
      env: { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: 'repo:p0b-surface' },
      encoding: 'utf8',
      input: '',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--surface/);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});
