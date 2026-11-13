// tests/unit/mcp-session-tools.test.js — MCP 会话临时库五工具（v0.6 W2）
// 契约：docs/plans/v0.6-memory-quality-and-session.md §2.2/§2.3。
// 走真实 stdio JSON-RPC 子进程（与 mcp-version.test.js 同款），覆盖：
// start 返回 scope / checkpoint 缺参报错 / status 计数 / close 幂等 / 非 session scope 报错。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = join(VER_DIR, 'src', 'mcp', 'server.js');

/** 极简 MCP stdio 客户端：串行发一行请求，等对应 id 的响应行 */
function startServer(memoHome, memScope) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: memScope ?? 'repo:mcp-session-test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume(); // 测试不关心 server 日志
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
    /** tools/call 快捷方式：返回 { text, structured, isError } */
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

async function withServer(fn, { memScope } = {}) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-mcpsess-'));
  const cli = startServer(memoHome, memScope);
  try {
    await cli.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1' } });
    await fn(cli, memoHome);
  } finally {
    cli.kill();
    rmSync(memoHome, { recursive: true, force: true });
  }
}

const CP = {
  intent: '验证 MCP 会话工具',
  concepts: [], files: [], errorsAndFixes: [], pendingJobs: [],
  currentState: '进行中', nextSteps: ['跑测试'], criticalContext: '',
};

test('memory_session_start 返回 session:* scope 与提示', async () => {
  await withServer(async (cli) => {
    const r = await cli.tool('memory_session_start', { title: '会话工具测试' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.structured.ok, true);
    assert.match(r.structured.scope, /^session:/);
    assert.ok(r.structured.hint.includes('临时库'));
    // tools/list 里能看到全部 5 个会话工具
    const list = await cli.call('tools/list');
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['memory_session_start', 'memory_session_checkpoint', 'memory_session_status', 'memory_session_close', 'memory_session_sweep']) {
      assert.ok(names.includes(n), `tools/list 应含 ${n}`);
    }
  });
});

test('memory_session_start 校验：title 必填且 ≤120，未知参数拒绝', async () => {
  await withServer(async (cli) => {
    const missing = await cli.tool('memory_session_start', {});
    assert.equal(missing.isError, true);
    assert.match(missing.text, /E_INVALID_ARGS/);
    const tooLong = await cli.tool('memory_session_start', { title: 'x'.repeat(121) });
    assert.equal(tooLong.isError, true);
    const unknown = await cli.tool('memory_session_start', { title: 'ok', foo: 1 });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /未知参数/);
  });
});

test('memory_session_checkpoint 缺 checkpoint/fromSummary → E_INVALID_ARG；非 session scope 同样报错', async () => {
  await withServer(async (cli) => {
    // 当前 scope 是 repo:mcp-session-test（非 session:*），不带 scope → 提示先 start
    const noScope = await cli.tool('memory_session_checkpoint', { checkpoint: CP });
    assert.equal(noScope.isError, true);
    assert.match(noScope.text, /E_INVALID_ARG/);
    assert.match(noScope.text, /memory_session_start/);
    // 建库后不带任何 checkpoint 来源 → E_INVALID_ARG
    const started = await cli.tool('memory_session_start', { title: 'cp' });
    const scope = started.structured.scope;
    const noBody = await cli.tool('memory_session_checkpoint', { scope });
    assert.equal(noBody.isError, true);
    assert.match(noBody.text, /E_INVALID_ARG/);
  });
});

test('status 计数：checkpoint/facts 随写入增长；close 幂等', async () => {
  await withServer(async (cli) => {
    const started = await cli.tool('memory_session_start', { title: '计数' });
    const scope = started.structured.scope;

    const before = await cli.tool('memory_session_status', { scope });
    assert.equal(before.isError, false, before.text);
    assert.equal(before.structured.ok, true);
    assert.equal(before.structured.checkpoints, 0);
    assert.equal(before.structured.facts, 0);
    assert.equal(before.structured.lastCheckpointAt, null);

    const cp1 = await cli.tool('memory_session_checkpoint', { scope, checkpoint: CP });
    assert.equal(cp1.isError, false, cp1.text);
    const cp2 = await cli.tool('memory_session_checkpoint', { scope, checkpoint: { ...CP, currentState: '第二步' } });
    assert.equal(cp2.isError, false, cp2.text);

    const mid = await cli.tool('memory_session_status', { scope });
    assert.equal(mid.structured.checkpoints, 2, '应有 2 条 checkpoint');
    assert.equal(mid.structured.facts, 0, 'meta/checkpoint 不计 facts');
    assert.notEqual(mid.structured.lastCheckpointAt, null);

    const closed = await cli.tool('memory_session_close', { scope });
    assert.equal(closed.isError, false, closed.text);
    assert.equal(closed.structured.ok, true);
    assert.ok(Array.isArray(closed.structured.promoted));
    assert.equal(typeof closed.structured.forgotten, 'number');
    assert.ok(closed.structured.handoffPath.endsWith('.md'));

    // 幂等：再 close 返回 alreadyClosed，且仍 ok
    const again = await cli.tool('memory_session_close', { scope });
    assert.equal(again.isError, false, again.text);
    assert.equal(again.structured.alreadyClosed, true);
    assert.deepEqual(again.structured.promoted, []);
    assert.equal(again.structured.forgotten, 0);
  });
});

test('close 后 checkpoint（非 session 当前 scope）报错；sweep 返回候选结构', async () => {
  await withServer(async (cli) => {
    // 不带 scope 直接对非 session 当前 scope 调 close/status → E_INVALID_ARG 提示 start
    const badClose = await cli.tool('memory_session_close', {});
    assert.equal(badClose.isError, true);
    assert.match(badClose.text, /memory_session_start/);
    const badStatus = await cli.tool('memory_session_status', {});
    assert.equal(badStatus.isError, true);

    // sweep：建一个旧会话不关，默认阈值 14 天扫不到；返回结构正确（只报告）
    const sweep = await cli.tool('memory_session_sweep', {});
    assert.equal(sweep.isError, false, sweep.text);
    assert.equal(sweep.structured.ok, true);
    assert.ok(Array.isArray(sweep.structured.candidates));
    // olderThanMs=1 会把刚建的 open session 报为候选
    const started = await cli.tool('memory_session_start', { title: '待扫' });
    const scope = started.structured.scope;
    const sweep2 = await cli.tool('memory_session_sweep', { olderThanMs: 1 });
    assert.equal(sweep2.isError, false);
    assert.ok(sweep2.structured.candidates.some((c) => c.scope === scope));
  });
});
