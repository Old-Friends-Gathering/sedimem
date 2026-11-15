// tests/unit/mcp-session-brief.test.js — MCP 任务账本两工具（v1.2 A3）
// 契约：docs/SEGMENT-SPEC.md §5 briefJson / §6 只 CLI 不 MCP（MCP 只读简报与段列表）。
// 走真实 stdio JSON-RPC 子进程（与 mcp-session-tools.test.js 同款 harness），覆盖：
// tools/list 含两新工具 / brief 文本含任务标题 / task 与 scope=session:<id> 等价 /
// 严格参数校验（未知字段、缺 task+scope、任务不存在）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendSegment } from '../../src/session/ledger.js';

const VER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = join(VER_DIR, 'src', 'mcp', 'server.js');

const TASK = '20261115-1100-b0b0';
const MISSING = '20261115-9999-dead';

/** 极简 MCP stdio 客户端：串行发一行请求，等对应 id 的响应行 */
function startServer(memoHome, memScope) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: memScope ?? 'repo:mcp-brief-test' },
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
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-mcpbrief-'));
  const cli = startServer(memoHome, memScope);
  try {
    await cli.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1' } });
    await fn(cli, memoHome);
  } finally {
    cli.kill();
    rmSync(memoHome, { recursive: true, force: true });
  }
}

/** 预置任务：meta.json + 两段（seg_1 [0,2) / seg_2 [2,4)） */
async function seedTask(memoHome) {
  const anchor = join(memoHome, 'anchor.jsonl');
  writeFileSync(anchor, '{"seq":1}\n');
  await appendSegment({
    memoHome,
    taskId: TASK,
    segment: {
      id: 'seg_1', taskId: TASK, fromSeq: 0, toSeq: 2, createdAt: '2026-11-15T01:00:00.000Z',
      anchor: { path: anchor, fromSeq: 0, toSeq: 2 },
      summary: '第一段：读 SEGMENT-SPEC 第 5 节',
      decisions: ['briefJson 纯只读且确定性'],
      files: ['src/session/ledger-brief.js'],
      mode: 'rules',
    },
  });
  await appendSegment({
    memoHome,
    taskId: TASK,
    segment: {
      id: 'seg_2', taskId: TASK, fromSeq: 2, toSeq: 4, createdAt: '2026-11-15T02:00:00.000Z',
      anchor: { path: anchor, fromSeq: 2, toSeq: 4 },
      summary: '第二段：MCP 工具注册',
      gotchas: ['session-tools 的 MEMO_HOME 是模块常量'],
      mode: 'rules',
    },
  });
}

async function seedMeta(memoHome, extra = {}) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(memoHome, 'sessions', TASK), { recursive: true });
  writeFileSync(
    join(memoHome, 'sessions', TASK, 'meta.json'),
    JSON.stringify({ taskId: TASK, title: 'MCP 简报任务', status: 'open', startedAt: '2026-11-15T01:00:00.000Z', ...extra }),
  );
}

test('tools/list 含 memory_session_brief 与 memory_session_segments', async () => {
  await withServer(async (cli) => {
    const list = await cli.call('tools/list');
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['memory_session_brief', 'memory_session_segments']) {
      assert.ok(names.includes(n), `tools/list 应含 ${n}`);
    }
    const briefDef = list.result.tools.find((t) => t.name === 'memory_session_brief');
    assert.equal(briefDef.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(briefDef.inputSchema.properties).sort(), ['asOf', 'maxChars', 'scope', 'task']);
  });
});

test('memory_session_brief：task 指定，文本含任务标题，task/scope 两写法等价', async () => {
  await withServer(async (cli, memoHome) => {
    await seedMeta(memoHome);
    await seedTask(memoHome);

    const byTask = await cli.tool('memory_session_brief', { task: TASK });
    assert.equal(byTask.isError, false, byTask.text);
    assert.match(byTask.text, new RegExp(`任务 ${TASK}：MCP 简报任务`));
    assert.match(byTask.text, /上下文接力/);
    assert.equal(byTask.structured.ok, true);
    assert.equal(byTask.structured.task.id, TASK);
    assert.equal(byTask.structured.task.title, 'MCP 简报任务');
    assert.equal(byTask.structured.segments.total, 2);

    const byScope = await cli.tool('memory_session_brief', { scope: `session:${TASK}` });
    assert.equal(byScope.isError, false, byScope.text);
    assert.equal(byScope.text, byTask.text, 'scope=session:<task> 与 task 应等价');

    // asOf 冻结：只留第一段
    const frozen = await cli.tool('memory_session_brief', { task: TASK, asOf: '2026-11-15T01:30:00.000Z' });
    assert.equal(frozen.isError, false, frozen.text);
    assert.equal(frozen.structured.segments.used, 1);
  });
});

test('memory_session_brief：严格参数校验与错误码', async () => {
  await withServer(async (cli, memoHome) => {
    await seedMeta(memoHome);
    await seedTask(memoHome);

    const unknown = await cli.tool('memory_session_brief', { task: TASK, foo: 1 });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /未知参数/);

    const neither = await cli.tool('memory_session_brief', {});
    assert.equal(neither.isError, true);
    assert.match(neither.text, /E_INVALID_ARG/);

    const missing = await cli.tool('memory_session_brief', { task: MISSING });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /E_NOT_FOUND/);

    const badAsOf = await cli.tool('memory_session_brief', { task: TASK, asOf: 'not-a-time' });
    assert.equal(badAsOf.isError, true);
    assert.match(badAsOf.text, /E_INVALID_ARG/);
  });
});

test('memory_session_segments：精简段列表（id/区间/mode/quarantined/summary 前 60 字）', async () => {
  await withServer(async (cli, memoHome) => {
    await seedMeta(memoHome);
    await seedTask(memoHome);

    const r = await cli.tool('memory_session_segments', { task: TASK });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.structured.ok, true);
    assert.equal(r.structured.total, 2);
    assert.equal(r.structured.count, 2);
    assert.equal(r.structured.badLines, 0);
    assert.match(r.text, new RegExp(`任务 ${TASK}：MCP 简报任务`));
    assert.match(r.text, /seg_1 \[0, 2\) mode=rules/);

    const [first, second] = r.structured.segments;
    assert.deepEqual(Object.keys(first).sort(), ['fromSeq', 'id', 'mode', 'quarantined', 'summary', 'toSeq']);
    assert.equal(first.id, 'seg_1');
    assert.equal(first.fromSeq, 0);
    assert.equal(first.toSeq, 2);
    assert.equal(first.mode, 'rules');
    assert.equal(first.quarantined, false);
    assert.ok(first.summary.length <= 60);
    assert.equal(second.id, 'seg_2');

    // scope 写法等价 + 未知字段拒绝
    const byScope = await cli.tool('memory_session_segments', { scope: `session:${TASK}` });
    assert.equal(byScope.isError, false, byScope.text);
    assert.equal(byScope.text, r.text);
    const unknown = await cli.tool('memory_session_segments', { task: TASK, limit: 1 });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /未知参数/);
  });
});
