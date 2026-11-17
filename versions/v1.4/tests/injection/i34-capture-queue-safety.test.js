// I34 — 捕获队列的并发安全与坏行容忍（v0.4 对抗审核 B4 / S-3 的回归）
// 钉住：①多进程并发入队不丢条目（原来全量读+全量写，200 条丢一半）；
//       ②单行坏 JSON 不阻断整个队列（add/list 仍可用，且坏行计数可观察）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createCaptureQueue } from '../../src/capture/queue.js';
import { scopeKeyOf } from '../../src/config/paths.js';

const INBOX = (home, scope) => path.join(home, 'inbox', `${scopeKeyOf(scope)}.jsonl`);

test('I34 两个进程各入队 100 条，最终 200 条一条不丢', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i34-'));
  const script = `
    import { createCaptureQueue } from ${JSON.stringify(new URL('../../src/capture/queue.js', import.meta.url).href)};
    const q = createCaptureQueue({ memoHome: ${JSON.stringify(home)}, scope: 'repo:i34' });
    for (let i = 0; i < 100; i++) q.add([{ text: '候选-' + process.argv[2] + '-' + i, kind: 'fact' }]);
  `;
  await fsp.writeFile(path.join(home, 'child.mjs'), script);
  const run = (tag) => new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(home, 'child.mjs'), tag], (err, out, errOut) => {
      if (err) reject(new Error(`${err.message}\n${errOut}`)); else resolve(out);
    });
  });
  await Promise.all([run('a'), run('b')]);
  const q = createCaptureQueue({ memoHome: home, scope: 'repo:i34' });
  assert.equal(q.size(), 200, `期望 200 条，实际 ${q.size()}`);
  await fsp.rm(path.join(home, 'child.mjs'), { force: true });
});

test('I34 坏行不阻断队列，且计数可观察', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i34b-'));
  const q = createCaptureQueue({ memoHome: home, scope: 'repo:i34b' });
  q.add([{ text: '正常候选一' }]);
  await fsp.appendFile(INBOX(home, 'repo:i34b'), '{"broken": \n');
  q.add([{ text: '正常候选二' }]);
  const list = q.list();
  assert.equal(list.length, 2, JSON.stringify(list.map((r) => r.text)));
  assert.ok(q.lastCorrupt >= 1, `lastCorrupt=${q.lastCorrupt}`);
  assert.equal(q.size(), 2);
});
