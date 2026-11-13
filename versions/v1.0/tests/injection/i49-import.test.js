// I49 — 五源导入器（W7）：dry-run 不写盘、apply 写入并留 import 事件、重复 apply 幂等
// 钉住：默认 dry-run 是"只看不写"、--apply 才落真相层、跑两遍 apply 不会把同一条事实写两次。
// 走真实 CLI 子进程：cmdImport 内部自己 loadService()（按 cwd/MEMO_SCOPE 解析），
// 用 env 把 MEMO_HOME/MEMO_SCOPE 固定到临时库，比 mock 更接近用户实际用法。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli/memo.js', import.meta.url));
const AGENTS_MD = ['# AGENTS', '- 只用 node 内置模块', '## 测试', '- 先写测试再写实现'].join('\n');

async function setup() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i49-'));
  const file = path.join(home, 'AGENTS.md');
  await fsp.writeFile(file, AGENTS_MD);
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, MEMO_HOME: home, MEMO_SCOPE: 'repo:i49' },
      timeout: 60000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  return { home, file, run };
}

test('I49 dry-run 不写盘：预览出条目数，但真相层仍然是 0 条', async (t) => {
  const ctx = await setup();
  t.after(async () => { await fsp.rm(ctx.home, { recursive: true, force: true }); });

  const r = await ctx.run(['import', 'agents', ctx.file, '--json']);
  assert.equal(r.code, 0, `dry-run 退出码非 0: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.dryRun, true);
  assert.ok(out.parsed >= 2, `应解析出 ≥2 条，实际 ${out.parsed}`);

  const stats = await ctx.run(['stats', '--json']);
  const s = JSON.parse(stats.stdout.trim().split('\n').at(-1));
  assert.equal(s.total, 0, 'dry-run 不该写入任何记录');
});

test('I49 apply 落库并留 import 事件；再跑一次不产生重复', async (t) => {
  const ctx = await setup();
  t.after(async () => { await fsp.rm(ctx.home, { recursive: true, force: true }); });

  const first = await ctx.run(['import', 'agents', ctx.file, '--apply', '--json']);
  assert.equal(first.code, 0, `apply 退出码非 0: ${first.stderr}`);
  const out1 = JSON.parse(first.stdout.trim().split('\n').at(-1));
  assert.ok(out1.written >= 2, `首次 apply 应写入 ≥2 条，实际 ${out1.written}`);

  // 事件流里留 op=import
  const ev = await ctx.run(['events', '--json']);
  if (ev.code === 0 && ev.stdout.trim()) {
    const rows = JSON.parse(ev.stdout.trim().split('\n').at(-1));
    const list = Array.isArray(rows) ? rows : (rows?.events ?? []);
    assert.ok(list.some((e) => e.op === 'import'), 'apply 必须留下 op=import 审计事件');
  }

  // 同一个源再 apply 一次：写入门禁应判 noop（活跃记录数不增）
  const second = await ctx.run(['import', 'agents', ctx.file, '--apply', '--json']);
  const out2 = JSON.parse(second.stdout.trim().split('\n').at(-1));
  assert.equal(out2.written, 0, '重复 apply 不应新增记录');
  assert.ok(out2.skipped >= 2, `重复 apply 应全部跳过，实际 skipped=${out2.skipped}`);
});
