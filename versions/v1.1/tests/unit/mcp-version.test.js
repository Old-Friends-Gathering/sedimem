// tests/unit/mcp-version.test.js — MCP serverInfo.version 必须跟 package.json 走（issue #41）
// 为什么：这个字段是客户端确认「加载的是哪一版服务」的唯一手段；写死过一次 0.1.1 就落后四个版本。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = join(VER_DIR, 'src', 'mcp', 'server.js');
const PKG = JSON.parse(readFileSync(join(VER_DIR, 'package.json'), 'utf8'));

test('initialize 返回的 serverInfo.version 与 package.json 一致', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-mcpver-'));
  try {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: 'repo:ver' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('MCP initialize 超时')), 10000);
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        const line = buf.split('\n').find((l) => l.includes('"serverInfo"'));
        if (line) {
          clearTimeout(timer);
          resolve(line);
        }
      });
      child.on('error', reject);
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1' } },
      }) + '\n');
    });
    child.kill();
    const info = JSON.parse(out).result.serverInfo;
    assert.equal(info.name, 'memo');
    assert.equal(info.version, PKG.version, 'serverInfo.version 必须等于 package.json 的 version（别写死）');
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});
