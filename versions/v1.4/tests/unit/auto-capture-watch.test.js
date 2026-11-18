// tests/unit/auto-capture-watch.test.js — v1.4.1 周期扫描 watcher
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { listOpenTaskIds, startAutoCaptureWatcher } from '../../src/session/auto-capture.js';

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'sedimem-watch-'));
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const write = (id, status) => writeFileSync(
    path.join(home, 'sessions', `${id}.json`),
    `${JSON.stringify({ id, status, cwd: home })}\n`,
  );
  write('20261118-0001-open', 'open');
  write('20261118-0002-closed', 'closed');
  return home;
}

test('listOpenTaskIds: 只返回 open 且 id 合法', () => {
  const home = fixture();
  assert.deepEqual(listOpenTaskIds(home), ['20261118-0001-open']);
  // 新布局只有 sessions/<taskId>/meta.json（登记文件可能已丢）也必须被扫描到
  mkdirSync(path.join(home, 'sessions', '20261118-0003-meta'), { recursive: true });
  writeFileSync(path.join(home, 'sessions', '20261118-0003-meta', 'meta.json'), `${JSON.stringify({ taskId: '20261118-0003-meta', status: 'open' })}\n`);
  assert.deepEqual(listOpenTaskIds(home), ['20261118-0001-open', '20261118-0003-meta']);
  writeFileSync(path.join(home, 'sessions', 'bad.json'), '{not json');
  assert.deepEqual(listOpenTaskIds(home), ['20261118-0001-open', '20261118-0003-meta']);
  rmSync(home, { recursive: true, force: true });
});

test('watcher: 对 open 任务调用 maybe，closed 不调用；stop 删 pid', async () => {
  const home = fixture();
  const pidFile = path.join(home, 'watch.pid');
  const calls = [];
  const w = startAutoCaptureWatcher({
    memoHome: home,
    pidFile,
    intervalMs: 60_000,
    maybeImpl: async ({ taskId }) => { calls.push(taskId); return { ran: false }; },
  });
  assert.equal(w.started, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, ['20261118-0001-open']);
  w.stop();
  rmSync(home, { recursive: true, force: true });
});

test('watcher: 同 pid 文件第二个不启动', () => {
  const home = fixture();
  const pidFile = path.join(home, 'watch.pid');
  const a = startAutoCaptureWatcher({ memoHome: home, pidFile, maybeImpl: async () => ({ ran: false }) });
  const b = startAutoCaptureWatcher({ memoHome: home, pidFile, maybeImpl: async () => ({ ran: false }) });
  assert.equal(a.started, true);
  assert.equal(b.started, false);
  assert.equal(b.reason, 'already-running');
  a.stop();
  rmSync(home, { recursive: true, force: true });
});

test('watcher: policy disabled 不启动', () => {
  const home = fixture();
  const r = startAutoCaptureWatcher({
    memoHome: home,
    policy: { session: { ledger: { autoCapture: { enabled: false } } } },
    maybeImpl: async () => ({ ran: false }),
  });
  assert.equal(r.started, false);
  assert.equal(r.reason, 'disabled');
  rmSync(home, { recursive: true, force: true });
});
