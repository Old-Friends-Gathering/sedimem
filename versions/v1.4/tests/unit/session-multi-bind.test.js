// tests/unit/session-multi-bind.test.js — v1.4.2 多会话关联
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { bindSession, readBoundSessionIds, rememberSession } from '../../src/session/ledger.js';
import { readAutoCaptureState, startAutoCaptureWatcher } from '../../src/session/auto-capture.js';

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'sedimem-multi-'));
  const taskId = '20261118-1200-multi';
  const dir = path.join(home, 'sessions', taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'segments.jsonl'), '');
  writeFileSync(path.join(home, 'sessions', `${taskId}.json`), `${JSON.stringify({ id: taskId, status: 'open' })}\n`);
  return { home, taskId, dir };
}

test('bindSession: 会话并集，hostSessionId 保留最新主会话', () => {
  const { home, taskId } = fixture();
  bindSession({ memoHome: home, taskId, hostSessionId: 'session-a' });
  bindSession({ memoHome: home, taskId, hostSessionId: 'session-b' });
  assert.deepEqual(readBoundSessionIds(home, taskId), ['session-b', 'session-a']);
  const meta = JSON.parse(readFileSync(path.join(home, 'sessions', taskId, 'meta.json'), 'utf8'));
  assert.equal(meta.hostSessionId, 'session-b');
  assert.deepEqual(meta.hostSessionIds, ['session-a', 'session-b']);
  rmSync(home, { recursive: true, force: true });
});

test('rememberSession: 自动追加且幂等', () => {
  const { home, taskId } = fixture();
  bindSession({ memoHome: home, taskId, hostSessionId: 'session-a' });
  const first = rememberSession({ memoHome: home, taskId, hostSessionId: 'session-c' });
  assert.equal(first.added, true);
  const again = rememberSession({ memoHome: home, taskId, hostSessionId: 'session-c' });
  assert.equal(again.added, false);
  assert.deepEqual(readBoundSessionIds(home, taskId), ['session-a', 'session-c']);
  rmSync(home, { recursive: true, force: true });
});

test('watcher: 对同一任务的全部关联会话逐个调用', async () => {
  const { home, taskId } = fixture();
  bindSession({ memoHome: home, taskId, hostSessionId: 'session-a' });
  rememberSession({ memoHome: home, taskId, hostSessionId: 'session-b' });
  const calls = [];
  const w = startAutoCaptureWatcher({
    memoHome: home,
    pidFile: path.join(home, 'watch.pid'),
    intervalMs: 60_000,
    maybeImpl: async ({ taskId: t, sessionId }) => { calls.push([t, sessionId]); return { ran: false }; },
  });
  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(calls.sort(), [[taskId, 'session-a'], [taskId, 'session-b']].sort());
  rmSync(home, { recursive: true, force: true });
});

test('readAutoCaptureState: 按会话读嵌套状态，旧顶层仍兼容', () => {
  const { home, taskId, dir } = fixture();
  writeFileSync(path.join(dir, 'autocapture.json'), `${JSON.stringify({
    sessionId: 'session-a', mtimeMs: 1, size: 2,
    sessions: { 'session-b': { mtimeMs: 3, size: 4 } },
  })}\n`);
  assert.equal(readAutoCaptureState(home, taskId, 'session-a').mtimeMs, 1);
  assert.equal(readAutoCaptureState(home, taskId, 'session-b').size, 4);
  assert.equal(readAutoCaptureState(home, taskId, 'session-c'), null);
  rmSync(home, { recursive: true, force: true });
});
