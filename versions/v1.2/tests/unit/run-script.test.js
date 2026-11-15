// tests/unit/run-script.test.js — 入口脚本必须跟着 versions/CURRENT 走（issue #47）
// 为什么：有台机器的 crontab 写死了 versions/v0.1，版本切换后 nightly 一直在跑冻结代码；
// 门禁扫仓库扫不到，只有查 crontab 才发现。所以入口收敛到 scripts/sedimem-run.sh，并在这里守住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'sedimem-run.sh');
const CURRENT = readFileSync(join(ROOT, 'versions', 'CURRENT'), 'utf8').trim();

function print(...args) {
  return execFileSync('sh', [SCRIPT, '--print', ...args], { encoding: 'utf8' }).trim();
}

test('--print nightly：解析到 versions/<CURRENT>/src/cli/nightly.js', () => {
  const out = print('nightly');
  assert.match(out, new RegExp(`versions/${CURRENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/src/cli/nightly\\.js`),
    `必须跟 CURRENT=${CURRENT} 走，实际：${out}`);
  assert.ok(!/versions\/v0\.\d/.test(out.replace(`versions/${CURRENT}`, '')), `不得出现其它版本目录：${out}`);
});

test('--print serve：保留端口等参数', () => {
  const out = print('serve', '--port', '7799');
  assert.match(out, /src\/cli\/memo\.js serve --port 7799$/);
});

test('--print 不执行：打印后立即退出（无副作用）', () => {
  // 若真执行了 serve，这里会因为端口占用/阻塞而超时；能秒回就说明只打印
  const t0 = Date.now();
  print('serve', '--port', '7798');
  assert.ok(Date.now() - t0 < 3000);
});

test('未知子命令：退出码 2 并给出用法', () => {
  assert.throws(
    () => execFileSync('sh', [SCRIPT, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 2 && /用法/.test(String(err.stderr)),
  );
});
