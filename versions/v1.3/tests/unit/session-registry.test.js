// tests/unit/session-registry.test.js — I52 任务库管理数据层（listSessions / renameSession / removeSession）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClock } from '../../src/core/clock.js';
import { writeSessionRegistry } from '../../src/session/lifecycle.js';
import { listSessions, renameSession, removeSession } from '../../src/session/lifecycle.js';

const FIXED_MS = Date.parse('2026-11-14T15:00:00Z');
const clock = createClock({ now: FIXED_MS });

function fresh() {
  return mkdtempSync(join(tmpdir(), 'memo-i52-unit-'));
}

describe('listSessions', () => {
  test('读 meta（title/status/startedAt）并数 active 行，按 updatedAt 降序', () => {
    const home = fresh();
    try {
      const s1 = 'session:20261114-1000-aaaa';
      const s2 = 'session:20261114-1100-bbbb';
      mkdirSync(join(home, 'sessions'), { recursive: true });
      writeSessionRegistry(home, s1, { id: '20261114-1000-aaaa', title: '修任务库', status: 'open', startedAt: '2026-11-14T10:00:00Z' });
      writeSessionRegistry(home, s2, { id: '20261114-1100-bbbb', title: '写评测', status: 'closed', startedAt: '2026-11-14T11:00:00Z', closedAt: '2026-11-14T12:00:00Z' });
      mkdirSync(join(home, 'items'), { recursive: true });
      writeFileSync(join(home, 'items', `${s1}.jsonl`), [
        JSON.stringify({ id: 'a1', status: 'active' }),
        JSON.stringify({ id: 'a2', status: 'tombstoned' }),
        JSON.stringify({ id: 'a3', status: 'active' }),
      ].join('\n') + '\n');
      // s2 更晚写 items → updatedAt 更新 → 排前面（显式钉 mtime，避免同毫秒写入导致排序随机）
      writeFileSync(join(home, 'items', `${s2}.jsonl`), JSON.stringify({ id: 'b1', status: 'active' }) + '\n');
      utimesSync(join(home, 'items', `${s1}.jsonl`), new Date(FIXED_MS), new Date(FIXED_MS));
      utimesSync(join(home, 'items', `${s2}.jsonl`), new Date(FIXED_MS + 5000), new Date(FIXED_MS + 5000));

      const { tasks } = listSessions({ memoHome: home });
      assert.equal(tasks.length, 2);
      assert.equal(tasks[0].scope, s2);
      assert.equal(tasks[0].title, '写评测');
      assert.equal(tasks[0].status, 'closed');
      assert.equal(tasks[0].records, 1);
      assert.equal(tasks[1].scope, s1);
      assert.equal(tasks[1].title, '修任务库');
      assert.equal(tasks[1].records, 2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('坏 meta 文件跳过不抛；title 缺失回落 id', () => {
    const home = fresh();
    try {
      mkdirSync(join(home, 'sessions'), { recursive: true });
      writeFileSync(join(home, 'sessions', 'bad1.json'), '{not-json');
      writeFileSync(join(home, 'sessions', 'plain.json'), '"just a string"');
      writeSessionRegistry(home, 'session:20261114-0900-cccc', { status: 'open', startedAt: '2026-11-14T09:00:00Z' });
      const { tasks } = listSessions({ memoHome: home });
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, '20261114-0900-cccc');
      assert.equal(tasks[0].title, '20261114-0900-cccc', 'title 缺失回落 id');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('memoHome 不存在 sessions 目录 → 空 tasks 不抛', () => {
    const home = fresh();
    try {
      const { tasks } = listSessions({ memoHome: home });
      assert.deepEqual(tasks, []);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('renameSession', () => {
  test('改 title 保留其它字段；返回 previous', () => {
    const home = fresh();
    try {
      const scope = 'session:20261114-1000-aaaa';
      writeSessionRegistry(home, scope, { id: 'x', title: '旧标题', status: 'open', parentScope: 'repo:r' });
      const r = renameSession({ memoHome: home, scope, title: '  新标题  ' });
      assert.equal(r.title, '新标题', '去首尾空白');
      assert.equal(r.previous, '旧标题');
      const saved = JSON.parse(readFileSync(join(home, 'sessions', '20261114-1000-aaaa.json'), 'utf8'));
      assert.equal(saved.title, '新标题');
      assert.equal(saved.status, 'open', '其它字段保留');
      assert.equal(saved.parentScope, 'repo:r');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('空白 / 超长 / 换行 → E_INVALID_ARG；scope 非法 / 不存在 → 抛', () => {
    const home = fresh();
    try {
      const scope = 'session:20261114-1000-dddd';
      writeSessionRegistry(home, scope, { title: 't', status: 'open' });
      assert.throws(() => renameSession({ memoHome: home, scope, title: '   ' }), (e) => e.code === 'E_INVALID_ARG');
      assert.throws(() => renameSession({ memoHome: home, scope, title: 'x'.repeat(81) }), (e) => e.code === 'E_INVALID_ARG');
      assert.throws(() => renameSession({ memoHome: home, scope, title: 'a\nb' }), (e) => e.code === 'E_INVALID_ARG');
      assert.throws(() => renameSession({ memoHome: home, scope: 'repo:x', title: 'ok' }), (e) => e.code === 'E_INVALID_ARG');
      assert.throws(() => renameSession({ memoHome: home, scope: 'session:nope-zzzz', title: 'ok' }), (e) => e.code === 'E_NOT_FOUND');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('removeSession', () => {
  test('文件移到 trash/<stamp>/ 并向 events.jsonl 追加 session_remove 行', () => {
    const home = fresh();
    try {
      const scope = 'session:20261114-1000-eeee';
      writeSessionRegistry(home, scope, { title: 't', status: 'open' });
      mkdirSync(join(home, 'items'), { recursive: true });
      writeFileSync(join(home, 'items', `${scope}.jsonl`), JSON.stringify({ id: 'r1', status: 'active' }) + '\n');

      const { movedTo, files } = removeSession({ memoHome: home, scope, clock });
      assert.ok(movedTo.includes(join(home, 'trash')), `movedTo 应在 trash 下: ${movedTo}`);
      assert.match(movedTo, /trash[/\\]\d{8}-\d{6}$/);
      assert.deepEqual(files.sort(), [`${scope}.jsonl`, '20261114-1000-eeee.json'].sort());
      assert.ok(existsSync(join(movedTo, `${scope}.jsonl`)));
      assert.ok(existsSync(join(movedTo, '20261114-1000-eeee.json')));
      assert.ok(!existsSync(join(home, 'items', `${scope}.jsonl`)), '原 items 文件应已移走');
      assert.ok(!existsSync(join(home, 'sessions', '20261114-1000-eeee.json')), '原登记文件应已移走');

      const events = readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const ev = events.find((e) => e.op === 'session_remove');
      assert.ok(ev, '应有 session_remove 事件');
      assert.equal(ev.scope, scope);
      assert.equal(ev.detail.movedTo, movedTo);
      assert.ok(typeof ev.ts === 'string' && ev.ts.length > 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('两个文件都不存在 → E_NOT_FOUND', () => {
    const home = fresh();
    try {
      assert.throws(
        () => removeSession({ memoHome: home, scope: 'session:20261114-1000-ffff', clock }),
        (e) => e.code === 'E_NOT_FOUND',
      );
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
