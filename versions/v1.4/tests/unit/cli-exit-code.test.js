// 回归：命令返回结构化 payload（非退出码）时不得崩（曾经 process.exitCode = {}）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/cli/memo.js');

test('capture scan 返回 payload 时退出码 0 且不抛 ERR_INVALID_ARG_TYPE', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'sedimem-exit-'));
  const file = path.join(home, 'input.txt');
  await writeFile(file, '记住：这个项目用 pnpm\n');
  const { stdout, stderr } = await exec(process.execPath, [CLI, 'capture', 'scan', '--file', file], {
    env: { ...process.env, MEMO_HOME: home, MEMO_SCOPE: 'repo:exit' },
  });
  assert.equal(stderr, '');
  assert.match(stdout, /扫描完成/);
});

test('capture list 空队列也退出 0', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'sedimem-exit2-'));
  const { stdout, stderr } = await exec(process.execPath, [CLI, 'capture', 'list', '--json'], {
    env: { ...process.env, MEMO_HOME: home, MEMO_SCOPE: 'repo:exit' },
  });
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).length, 0);
});
