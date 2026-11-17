// tests/unit/mcp-token.test.js — B4：直连 MCP 的 token 门禁
// 契约：docs/02 §3.24、docs/08 §7。
//
// 取舍必须可见：默认**信任本机 stdio**（否则 DSH / Codex / Claude 三端配置全挂），
// 只有 MEMO_MCP_TOKEN 或 MEMO_MCP_REQUIRE_TOKEN=1 时才强制 token。
// 本文件同时锁住「默认不破坏三端」和「强制模式下必须拒绝」两条语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  MCP_REQUIRE_ENV, MCP_TOKEN_ENV, checkMcpToken, createMcpTokenGate, mcpPresentedToken,
} from '../../src/mcp/token-gate.js';
import { issueWebToken, webTokenPath } from '../../src/config/web-token.js';

const SERVER = fileURLToPath(new URL('../../src/mcp/server.js', import.meta.url));

function startMcp(env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  let waiter = null;
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (waiter) { const w = waiter; waiter = null; w(msg); } else pending.push(msg);
  });
  return {
    child,
    stderr: () => stderr,
    send: (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`),
    next: (timeoutMs = 5000) => new Promise((resolve, reject) => {
      if (pending.length) { resolve(pending.shift()); return; }
      const timer = setTimeout(() => reject(new Error(`等待 MCP 响应超时；stderr=${stderr}`)), timeoutMs);
      waiter = (msg) => { clearTimeout(timer); resolve(msg); };
    }),
    close: async () => {
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      });
    },
  };
}

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-mcp-token-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

function baseEnv(home, extra = {}) {
  const env = { ...process.env, MEMO_HOME: home };
  delete env[MCP_TOKEN_ENV];
  delete env[MCP_REQUIRE_ENV];
  return { ...env, ...extra };
}

test('B4 MCP token：门禁默认关闭（本机 stdio 信任），显式环境变量才强制', async (t) => {
  const home = await tempHome(t);
  assert.deepEqual(await createMcpTokenGate({ env: {}, memoHome: home }), { required: false, expected: null });

  const envToken = 'env-token-0123456789abcdef';
  const fromEnv = await createMcpTokenGate({ env: { [MCP_TOKEN_ENV]: envToken }, memoHome: home });
  assert.equal(fromEnv.required, true);
  assert.equal(fromEnv.expected, envToken);

  const fileToken = await issueWebToken(home);
  const fromFile = await createMcpTokenGate({ env: { [MCP_REQUIRE_ENV]: '1' }, memoHome: home });
  assert.equal(fromFile.required, true);
  assert.equal(fromFile.expected, fileToken);
});

test('B4 MCP token：强制模式但没有可用 token → E_MCP_TOKEN_MISSING（fail-closed）', async (t) => {
  const home = await tempHome(t);
  await assert.rejects(
    () => createMcpTokenGate({ env: { [MCP_REQUIRE_ENV]: '1' }, memoHome: home }),
    (err) => err.code === 'E_MCP_TOKEN_MISSING',
  );
});

test('B4 MCP token：首帧 header 的三个携带位置都认，其余一律拒绝', async (t) => {
  const home = await tempHome(t);
  const token = await issueWebToken(home);
  const gate = await createMcpTokenGate({ env: { [MCP_REQUIRE_ENV]: '1' }, memoHome: home });
  assert.equal(checkMcpToken(gate, { _meta: { token } }), null);
  assert.equal(checkMcpToken(gate, { _meta: { headers: { authorization: `Bearer ${token}` } } }), null);
  assert.equal(checkMcpToken(gate, { _meta: { headers: { 'x-memo-token': token } } }), null);
  assert.equal(mcpPresentedToken({ _meta: { token } }), token);

  for (const params of [{}, { _meta: {} }, { _meta: { token: 'wrong-token-000000000000' } }, null]) {
    assert.match(checkMcpToken(gate, params), /^E_MCP_UNAUTHORIZED/);
  }
  // 未强制时永远放行（保持三端现状）
  assert.equal(checkMcpToken({ required: false, expected: null }, {}), null);
});

test('B4 MCP token：强制模式下未带 token 的 initialize 返回 -32001，且不触达存储', async (t) => {
  const home = await tempHome(t);
  const token = await issueWebToken(home);
  const mcp = startMcp(baseEnv(home, { [MCP_REQUIRE_ENV]: '1' }));
  t.after(() => mcp.close());

  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const denied = await mcp.next();
  assert.equal(denied.id, 1);
  assert.equal(denied.error.code, -32001);
  assert.match(denied.error.message, /E_MCP_UNAUTHORIZED/);

  // 未认证请求不得创建任何 scope/items 文件（存储零副作用）
  const itemsDir = path.join(home, 'items');
  assert.deepEqual(await fs.readdir(itemsDir).catch(() => []), []);

  mcp.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'b4-test' }, _meta: { token } },
  });
  const ok = await mcp.next();
  assert.equal(ok.id, 2);
  assert.ok(ok.result, `带对应 token 应成功，实际 ${JSON.stringify(ok)}`);
  assert.equal(typeof ok.result.protocolVersion, 'string');
});

test('B4 MCP token：默认（不设环境变量）仍信任本机 stdio，不破坏现有三端', async (t) => {
  const home = await tempHome(t);
  const mcp = startMcp(baseEnv(home));
  t.after(() => mcp.close());
  mcp.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'dsh-existing-config' } },
  });
  const res = await mcp.next();
  assert.ok(res.result, `默认模式必须保持可用（三端配置不带 token），实际 ${JSON.stringify(res)}`);
  assert.equal(typeof res.result.protocolVersion, 'string');
});

test('B4 MCP token：强制模式缺 token 文件时启动即失败并给出可操作错误', async (t) => {
  const home = await tempHome(t);
  const child = spawn(process.execPath, [SERVER], { env: baseEnv(home, { [MCP_REQUIRE_ENV]: '1' }), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /E_MCP_TOKEN_MISSING/);
  assert.match(stderr, new RegExp(webTokenPath(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await fs.readFile(webTokenPath(home), 'utf8').catch(() => null), null);
});
