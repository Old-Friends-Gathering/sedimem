// p0b B6.3：Windows 只支持 kernel/CLI；adapters 不支持；doctor 在 win32 说明并 exit 2。
// 单测通过显式 platform 参数覆盖分支（不在 Windows 机器上也能跑）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { cmdDoctor, windowsAdapterNotice } from '../../src/cli/commands/memory.js';

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    const cb = rest.find((x) => typeof x === 'function');
    if (cb) cb();
    return true;
  };
  return Promise.resolve(fn()).then((code) => {
    process.stdout.write = orig;
    return { code, out: chunks.join('') };
  }, (err) => {
    process.stdout.write = orig;
    throw err;
  });
}

test('B6.3 windowsAdapterNotice：kernel/CLI 支持，adapters 明确不支持，exitCode 2', () => {
  const n = windowsAdapterNotice('win32');
  assert.equal(n.ok, false);
  assert.equal(n.platform, 'win32');
  assert.deepEqual(n.supported, ['kernel', 'cli']);
  assert.ok(n.unsupported.includes('adapters'));
  assert.equal(n.exitCode, 2);
  assert.equal(n.issues[0].code, 'windows_adapters_unsupported');
  assert.match(n.issues[0].message, /仅支持 kernel\/CLI/);
  assert.match(n.issues[0].message, /adapters/);
});

test('B6.3 win32 doctor：说明并 exit 2；不因库损坏/缺失而变成其它退出码', async () => {
  const prevHome = process.env.MEMO_HOME;
  process.env.MEMO_HOME = '/nonexistent/p0b-win32-home';
  try {
    const { code, out } = await captureStdout(() => cmdDoctor(false, 'win32'));
    assert.equal(code, 2);
    assert.match(out, /Windows/);
    assert.match(out, /windows_adapters_unsupported/);
    const json = await captureStdout(() => cmdDoctor(true, 'win32'));
    assert.equal(json.code, 2);
    const payload = JSON.parse(json.out);
    assert.equal(payload.ok, false);
    assert.equal(payload.exitCode, 2);
  } finally {
    if (prevHome === undefined) delete process.env.MEMO_HOME;
    else process.env.MEMO_HOME = prevHome;
  }
});
