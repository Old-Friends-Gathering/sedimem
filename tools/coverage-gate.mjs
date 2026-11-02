#!/usr/bin/env node
// tools/coverage-gate.mjs — 覆盖率门禁（零依赖）
//
// 为什么单独一个脚本：node 的覆盖率报告是**文本表格**，没有机器可读输出；
// 直接 grep 容易在列宽/版本变化时假通过。这里显式解析 `all files | l | b | f` 行并做区间校验。
//
// 用法：node tools/coverage-gate.mjs [--min-lines 85] [--min-branches 70] [--min-functions 90]

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_DIR = path.join(ROOT, 'versions', 'v0.1');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const MIN = { lines: opt('min-lines', 85), branches: opt('min-branches', 70), functions: opt('min-functions', 90) };

const nodeCmd = process.execPath;
let stdout;
try {
  ({ stdout } = await execFileAsync(nodeCmd,
    ['--test', '--experimental-test-coverage', 'tests/**/*.test.js'],
    { cwd: VERSION_DIR, maxBuffer: 32 * 1024 * 1024 }));
} catch (e) {
  console.error('覆盖率采集失败（测试本身未全绿？）：');
  console.error((e.stdout ?? '').split('\n').slice(-30).join('\n'));
  process.exit(1);
}

// 形如： ℹ all files           |  85.75 |    71.47 |   94.03 |
const m = stdout.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
if (!m) {
  console.error('无法从覆盖率报告中解析出 all files 行：');
  console.error(stdout.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
const seen = { lines: Number(m[1]), branches: Number(m[2]), functions: Number(m[3]) };

let ok = true;
for (const key of ['lines', 'branches', 'functions']) {
  const pass = seen[key] >= MIN[key];
  if (!pass) ok = false;
  console.log(`${pass ? '✓' : '✗'} ${key.padEnd(9)} ${seen[key].toFixed(2)}% (下限 ${MIN[key]}%)`);
}
console.log(ok ? '覆盖率门禁通过' : '覆盖率门禁失败');
process.exit(ok ? 0 : 1);
