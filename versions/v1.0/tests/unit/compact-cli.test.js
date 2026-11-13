// compactCli —— 物理压实的 CLI 外壳（薄，但它是 --dry-run / --grace / --json 的唯一入口）
// 之前只有一半行覆盖：dry-run 分支与 grace 解析没被走过。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { compactCli, parseGraceMs } from '../../src/cli/compact.js';

const SRC = { agent: 'test' };

async function setup() {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-compact-cli-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:cc', cwd: memoHome });
  // 注意：文本要真的不同 —— 近似文本会命中 near-duplicate 判定变成 noop_same_value（裁决 14）
  const a = await service.write({ text: '观察台默认端口是 7788', kind: 'fact', subject: 'observer', predicate: 'port', value: '7788', source: SRC });
  const b = await service.write({ text: 'nightly 在 03:30 由 launchd 触发', kind: 'fact', subject: 'nightly', predicate: 'schedule', value: '0330', source: SRC });
  const keep = await service.write({ text: '真相层是 append-only JSONL，条目不可原地修改', kind: 'fact', subject: 'storage', predicate: 'model', value: 'append-only', source: SRC });
  for (const [rec, action] of [[a, a.action], [b, b.action]]) {
    assert.equal(action, 'created', `fixture 写入应为 created，实际 ${action}`);
    await service.forget({ id: rec.record.id, mode: 'purge', reason: 'test' });
  }
  return { memoHome, service, keep };
}

test('compactCli --dry-run：报告可删条数但一行不写', async () => {
  const { memoHome, service } = await setup();
  try {
    const itemsFile = path.join(memoHome, 'items', 'repo:cc.jsonl');
    const before = (await fsp.readFile(itemsFile, 'utf8')).trim().split('\n').length;
    // grace=0：墓碑刚失效就允许删，便于断言
    const out = await compactCli(service, { 'dry-run': true, grace: '0', json: true });
    assert.equal(out.purged, 2, JSON.stringify(out));
    assert.equal(out.backupPath, null, 'dry-run 不得产生备份文件');
    const after = (await fsp.readFile(itemsFile, 'utf8')).trim().split('\n').length;
    assert.equal(after, before, 'dry-run 一行都不许少');
  } finally {
    await service.close();
  }
});

test('compactCli 真跑：只删 purge 墓碑，active 记录与事件流都在', async () => {
  const { memoHome, service, keep } = await setup();
  try {
    // grace=0 时判定是 validTo < now（严格小于）：墓碑与压实常在同一毫秒，先让时钟走一格
    await new Promise((r) => setTimeout(r, 5));
    const out = await compactCli(service, { grace: '0', json: true });
    assert.equal(out.purged, 2, JSON.stringify(out));
    // 压实只能删 purge 墓碑：keeper 记录必须还在（否则 compact 就成了"按行删"）
    const keepId = keep?.record?.id ?? keep?.id ?? keep;
    const exported = await service.exportRecords({ status: 'all' });
    const all = Array.isArray(exported) ? exported : (exported?.records ?? exported?.items ?? []);
    assert.ok(all.some((r) => r.id === keepId), 'keeper 记录被误删');
    assert.ok(out.backupPath && out.backupPath.includes('.bak.'), `应留下备份: ${out.backupPath}`);
    const left = await service.get(keep.record.id);
    assert.equal(left.status, 'active');
    const stats = await service.stats();
    assert.equal(stats.active, 1);
    // 事件流不因压实而丢（审计要求）
    const { events } = await service.events({ ops: ['forget', 'compact'], limit: 50 });
    assert.ok(events.some((e) => e.op === 'forget'), 'forget 事件必须保留');
    assert.ok(events.some((e) => e.op === 'compact'), 'compact 事件必须留痕');
  } finally {
    await service.close();
  }
});

test('compactCli 文本输出：dry-run 明确提示未写盘', async () => {
  const { service } = await setup();
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try {
    await compactCli(service, { dryRun: true, json: false });
  } finally {
    process.stdout.write = orig;
    await service.close();
  }
  const text = chunks.join('');
  assert.match(text, /dry-run/);
  assert.match(text, /未写盘/);
});

test('parseGraceMs 与 compactCli 的 grace 传入形状一致（0 表示立即）', async () => {
  assert.equal(parseGraceMs('0'), 0);
  const { service } = await setup();
  try {
    const out = await compactCli(service, { grace: '0', json: true });
    assert.equal(typeof out.purged, 'number');
  } finally {
    await service.close();
  }
});
