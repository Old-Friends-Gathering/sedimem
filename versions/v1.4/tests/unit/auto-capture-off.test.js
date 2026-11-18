// tests/unit/auto-capture-off.test.js — 总开关哨兵（v1.4.1）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { autoCaptureOff, decideAutoCapture, startAutoCaptureWatcher } from '../../src/session/auto-capture.js';

test('哨兵存在：decide 返回 disabled-by-file，watcher 不启动', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'sedimem-off-'));
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  writeFileSync(path.join(home, 'autocapture.off'), 'disabled\n');
  assert.equal(autoCaptureOff(home), true);
  const d = decideAutoCapture({
    memoHome: home, taskId: '20261118-0001-x',
    probe: { mtimeMs: 1, size: 10 }, state: null,
    policy: { session: { ledger: { autoCapture: { enabled: true } } } },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'disabled-by-file');
  const w = startAutoCaptureWatcher({ memoHome: home, maybeImpl: async () => ({ ran: false }) });
  assert.equal(w.started, false);
  assert.equal(w.reason, 'disabled-by-file');
  rmSync(home, { recursive: true, force: true });
});
