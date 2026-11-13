// CLI 进程入口的冒烟（spawn 真进程）：
// src/cli/memo.js 是进程外壳（顶层 await / process.exit / 直接写 stdout），无法 import 测试，
// 因此它在覆盖率统计里被 exclude —— 这个文件就是它的「行为证据」，别删。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'src', 'cli', 'memo.js');

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('入口 shell：--help 退出码 0；未知命令退出码 2 且提示用法', async () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /memo/);

  const bad = run(['definitely-not-a-command']);
  assert.equal(bad.status, 2, `未知命令应为用法错误(2)，实际 ${bad.status}: ${bad.stderr}`);
  assert.match(bad.stderr, /用法错误/);
});

test('入口 shell：write → search → stats 走通（真进程，真文件）', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-entry-'));
  const env = { MEMO_HOME: memoHome };

  const w = run(['write', '--text', '入口冒烟：观察台端口 7788', '--kind', 'fact', '--agent', 'test', '--scope', 'repo:entry'], env);
  assert.equal(w.status, 0, w.stderr);

  const s = run(['search', '端口', '--scope', 'repo:entry', '--json'], env);
  assert.equal(s.status, 0, s.stderr);
  const parsed = JSON.parse(s.stdout);
  assert.ok(Array.isArray(parsed.items), s.stdout.slice(0, 200));
  assert.ok(parsed.items.length >= 1, '写进去的应当搜得到');

  const st = run(['stats', '--scope', 'repo:entry', '--json'], env);
  assert.equal(st.status, 0, st.stderr);
  assert.equal(JSON.parse(st.stdout).total, 1);
});
