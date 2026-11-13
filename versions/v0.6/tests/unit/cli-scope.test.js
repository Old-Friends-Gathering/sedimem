// tests/unit/cli-scope.test.js — 0.6.2 回归：命令行 `--scope` 必须真的生效
//
// 背景（实测）：0.6.0/0.6.1 里 `memo write --scope session:<id>` 被静默写进「按 cwd 解析出的分库」，
// 于是会话库的写入落到了主库，session 禁 fact 的门禁也一起被绕过（close 报告晋升 0 条、tombstone 0 条）。
// 根因：所有命令都走 loadService()，而它只按 cwd/env 解析 scope，从不读 --scope。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = new URL('../../src/cli/memo.js', import.meta.url).pathname;

async function memo(memoHome, args) {
  const env = { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: '' };
  return run(process.execPath, [CLI, ...args], { env, cwd: memoHome, timeout: 30000 });
}

test('CLI --scope 生效：写进指定分库而不是 cwd 分库', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-cliscope-'));
  try {
    // ① 建一个会话库
    const started = await memo(memoHome, ['session', 'start', '--scope', 'repo:main-demo', '--title', 'CLI scope 用例']);
    const sid = /session:[0-9]{8}-[0-9]{4}-[0-9a-f]{4}/.exec(started.stdout)?.[0];
    assert.ok(sid, `没解析到 session id：${started.stdout}`);

    // ② decision 写进 session 库
    const w = await memo(memoHome, ['write', '--scope', sid, '--agent', 'cli', '--kind', 'decision',
      '--title', '作用域用例', '--text', '这条 decision 应该落在 session 库', '--subject', 'cliscope', '--predicate', 'p']);
    assert.match(w.stdout, /created/);

    // 文件层面核实：没有写进 cwd 分库（dir:memo-cliscope-*），而是写进 session 文件
    const items = await fsp.readdir(path.join(memoHome, 'items'));
    const sessionFile = items.find((f) => f.startsWith(sid));
    assert.ok(sessionFile, `session 库文件不存在：${items.join(',')}`);
    const lines = (await fsp.readFile(path.join(memoHome, 'items', sessionFile), 'utf8')).trim().split('\n');
    assert.ok(lines.length >= 2, `session 库应含 meta + decision，实际 ${lines.length} 行`);

    // ③ session 库禁 fact：必须非零退出
    await assert.rejects(
      memo(memoHome, ['write', '--scope', sid, '--agent', 'cli', '--kind', 'fact', '--text', '这条 fact 应该被拒']),
      (err) => /E_SCRATCH_KIND_FORBIDDEN/.test(String(err.stderr ?? err.message)),
    );

    // ④ close 后主库能搜到晋升的 decision
    const closed = await memo(memoHome, ['session', 'close', '--scope', sid]);
    assert.match(closed.stdout, /晋升 1 条/);
    const hit = await memo(memoHome, ['search', '--scope', 'repo:main-demo', 'session', '--json']);
    const payload = JSON.parse(hit.stdout);
    assert.ok(payload.total >= 1, `主库应能搜到晋升的记录，实际 ${hit.stdout}`);
    assert.ok(payload.items.some((it) => (it.record?.title ?? '') === '作用域用例' || String(it.record?.text ?? '').includes('session 库')),
      `晋升记录内容不对：${hit.stdout}`);
  } finally {
    await fsp.rm(memoHome, { recursive: true, force: true });
  }
});
