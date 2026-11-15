// CLI 子命令实现层的单测（不经进程 spawn）：
// 这些函数是 `memo <cmd>` 的真身，进程入口只做参数解析。直接测它们能在覆盖率上
// 反映真实逻辑（spawn 的子进程不计入父进程覆盖率）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseGraceMs } from '../../src/cli/compact.js';
import { captureCli } from '../../src/cli/capture.js';
import { conflictsCli, resolveCli } from '../../src/cli/conflicts.js';
import { knownVectorIds, backfillCli } from '../../src/cli/backfill.js';
import { createMemoryService } from '../../src/api/service.js';

const SRC = { agent: 'test' };

async function tmpHome() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'memo-cli-'));
}

test('parseGraceMs：d/h/m/裸毫秒 都认，非法值报错', () => {
  assert.equal(parseGraceMs('7d'), 7 * 86400000);
  assert.equal(parseGraceMs('12h'), 12 * 3600000);
  assert.equal(parseGraceMs('30m'), 30 * 60000);
  assert.equal(parseGraceMs('1500'), 1500);
  // undefined / true / null 是「没给值」：返回 undefined（由调用方回落到 policy）
  for (const missing of [undefined, true, null]) assert.equal(parseGraceMs(missing), undefined);
  for (const bad of ['7x', '', 'd', '-1d', 'abc']) {
    assert.throws(() => parseGraceMs(bad), (e) => e.code === 'E_USAGE', `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('captureCli：scan 入队 → list 看得到 → reject 落状态（不写真相层）', async () => {
  const memoHome = await tmpHome();
  // scan 走 readInput(file)：不给 file 会读 stdin（会挂住），所以落一个临时文件再传。
  const srcFile = path.join(memoHome, 'notes.md');
  await fsp.writeFile(srcFile, '记住：观察台端口 7788\n坑：crontab 会被 TCC 拦\n');
  const scan = await captureCli({ sub: 'scan', memoHome, scope: 'repo:cli1', file: srcFile, json: true });
  assert.ok(scan && Array.isArray(scan.added), JSON.stringify(scan).slice(0, 120));
  const pending = await captureCli({ sub: 'list', memoHome, scope: 'repo:cli1', json: true });
  assert.ok(pending.length >= 1, 'scan 后应至少 1 条候选待决');
  const rejected = await captureCli({ sub: 'reject', memoHome, scope: 'repo:cli1', json: true, ids: [pending[0].id], note: '不是长期事实' });
  assert.ok(rejected, 'reject 应有返回');
  const after = await captureCli({ sub: 'list', memoHome, scope: 'repo:cli1', status: 'pending', json: true });
  assert.equal(after.length, pending.length - 1);
});

test('conflictsCli / resolveCli：无分歧时返回空，缺参数报 E_INVALID_ARG', async () => {
  const memoHome = await tmpHome();
  const empty = await conflictsCli({ memoHome, scope: 'repo:cli2', json: true });
  assert.deepEqual(empty.slots, []);
  await assert.rejects(() => resolveCli({ memoHome, scope: 'repo:cli2', json: true }), (e) => e.code === 'E_INVALID_ARG');
  await assert.rejects(() => resolveCli({ memoHome, scope: 'repo:cli2', slot: 'a|b' }), (e) => e.code === 'E_INVALID_ARG');
});

test('knownVectorIds：没有向量文件时返回空集合', async () => {
  const memoHome = await tmpHome();
  const ids = knownVectorIds(memoHome, 'repo:cli3');
  assert.ok(ids instanceof Set);
  assert.equal(ids.size, 0);
});

test('backfillCli：embedder 未就绪时 fail-loud（E_EMBED_UNAVAILABLE，不静默跳过）', async () => {
  const memoHome = await tmpHome();
  const service = await createMemoryService({ memoHome, scope: 'repo:cli4', cwd: memoHome });
  try {
    await service.write({ text: '一条待回填的事实', kind: 'fact', source: SRC });
  } finally {
    await service.close();
  }
  // backfillCli(argv, inject)：embedder 由 inject 给（CURRENT 的 policy 决定 kind）
  const code = await backfillCli(['--scope', 'repo:cli4', '--json'], { memoHome });
  assert.equal(code, 1, '未配置 embedder 时进程退出码应为失败');
});

