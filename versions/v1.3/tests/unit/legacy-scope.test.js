// tests/unit/legacy-scope.test.js — 裁决 111（v1.0.3）
// 背景（真实事故 2026-11-14）：项目改名 strata → sedimem 后，遗留行的 `scope` 字段仍是旧值
// （`repo:strata`），而文件已迁移到 `repo:sedimem`。此时 forget/supersede 用
// `withPatch(旧记录, ...)` 生成快照，会**沿用旧 scope** → 快照被写进旧分库文件，
// 当前分库读不到 → 表现为「删除/取代静默不生效」，而且不抛任何错。
//
// 三条不变式（本文件守住）：
//   I1 commit 拒绝把 A 库的记录写进 B 库实例（E_SCOPE_MISMATCH）——禁止跨库静默写歪；
//   I2 forget 对遗留行自愈：墓碑归一化到当前 scope，落在**当前**文件；
//   I3 supersede 对遗留行自愈：旧行快照归一化并标 superseded，新记录 supersedes 指向它。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { itemsFileName } from '../../src/config/paths.js';

function tmpHome() {
  return mkdtempSync(path.join(tmpdir(), 'scope-heal-'));
}

function fileOf(memoHome, scope) {
  return path.join(memoHome, 'items', itemsFileName(scope));
}

function readLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 把文件里所有行的 scope 字段改写成 legacyScope（模拟改名前的历史数据）。 */
function rewriteScopeField(file, legacyScope) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.stringify({ ...JSON.parse(l), scope: legacyScope }));
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

test('I1 commit 拒绝跨库写入（E_SCOPE_MISMATCH）', async () => {
  const memoHome = tmpHome();
  const alpha = await createMemoryService({ memoHome, scope: 'repo:alpha' });
  const { record } = await alpha.write({
    text: '属于 alpha 库的事实', kind: 'fact', subject: 'x', predicate: 'y', source: { agent: 'test' },
  });
  await alpha.close();

  const beta = await createMemoryService({ memoHome, scope: 'repo:beta' });
  await assert.rejects(
    () => beta._commit({ ...record, status: 'tombstoned' }, 'forget', {}),
    (e) => e.code === 'E_SCOPE_MISMATCH',
  );
  await beta.close();
});

test('I2 forget 自愈：墓碑归一化 scope 并落到当前文件', async () => {
  const memoHome = tmpHome();
  const svc = await createMemoryService({ memoHome, scope: 'repo:sedimem' });
  const { record } = await svc.write({
    text: 'legacy 行：scope 字段还是改名前的值', kind: 'fact',
    subject: 'legacy', predicate: 'scope', source: { agent: 'cli' },
  });
  await svc.close();

  const file = fileOf(memoHome, 'repo:sedimem');
  rewriteScopeField(file, 'repo:strata');

  const svc2 = await createMemoryService({ memoHome, scope: 'repo:sedimem' });
  await svc2.forget({ id: record.id, reason: 'cleanup legacy' });
  const stats = await svc2.stats();
  assert.equal(stats.active, 0, 'forget 后不应再有 active');
  assert.equal(stats.tombstoned, 1, '应有一条墓碑');

  const tomb = readLines(file).filter((r) => r.id === record.id && r.status === 'tombstoned');
  assert.equal(tomb.length, 1, '当前分库文件里必须有墓碑行');
  assert.equal(tomb[0].scope, 'repo:sedimem', '墓碑的 scope 必须归一到当前分库');
  await svc2.close();
});

test('I3 supersede 自愈：旧行标 superseded，新记录指向它', async () => {
  const memoHome = tmpHome();
  const svc = await createMemoryService({ memoHome, scope: 'repo:sedimem' });
  const { record } = await svc.write({
    text: '旧值：缓存 TTL 30 秒', value: '30s', kind: 'fact',
    subject: 'cache', predicate: 'ttl', source: { agent: 'cli' },
  });
  await svc.close();

  const file = fileOf(memoHome, 'repo:sedimem');
  rewriteScopeField(file, 'repo:strata');

  const svc2 = await createMemoryService({ memoHome, scope: 'repo:sedimem' });
  const { record: next } = await svc2.supersede({
    oldId: record.id, value: '60s', text: '新值：缓存 TTL 60 秒', reason: 'update',
  });
  assert.equal(next.supersedes, record.id);

  const stats = await svc2.stats();
  assert.equal(stats.active, 1, '只应剩新记录一条 active');
  assert.equal(stats.superseded, 1, '旧记录必须被标成 superseded');

  const closed = readLines(file).filter((r) => r.id === record.id && r.status === 'superseded');
  assert.equal(closed.length, 1, '当前分库文件里必须有 superseded 快照');
  assert.equal(closed[0].scope, 'repo:sedimem', '快照 scope 必须归一到当前分库');
  await svc2.close();
});
