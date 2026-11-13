// I28 — 半自动捕获（v0.4 D3 / issue #108）
// 钉住：候选抽取有正/反例边界、候选进 inbox 但不入库、accept 才写入真相层、
// reject 不留痕、重复 accept 幂等（inbox 是 append-only 状态流，不是第二真相层）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { extractCandidates } from '../../src/capture/extract.js';
import { createCaptureQueue } from '../../src/capture/queue.js';

const SRC = 'capture-test';

test('I28 抽取：引导词/前缀/列表命中，代码块与 URL 不命中', () => {
  const text = [
    '记住：观察台默认端口是 7788',
    '约定：晚上 03:30 由 launchd 跑 nightly',
    '结论：FTS5 在 Node 24 可用',
    '坑：crontab 在 TCC 下会挂死',
    '- 部署脚本在 scripts/sedimem-run.sh',
    'https://example.com/this-is-not-a-memory',
    '```',
    'const x = 1; // 代码块内不算',
    '```',
  ].join('\n');
  const got = extractCandidates(text);
  const texts = got.map((c) => c.text);
  assert.ok(texts.some((t) => t.includes('7788')), `缺 7788: ${texts}`);
  assert.ok(texts.some((t) => t.includes('launchd')), '缺 launchd');
  assert.ok(texts.some((t) => t.includes('FTS5')), '缺 FTS5');
  assert.ok(texts.some((t) => t.includes('crontab')), '缺 crontab');
  assert.ok(texts.some((t) => t.includes('sedimem-run.sh')), '缺列表项');
  assert.ok(!texts.some((t) => t.includes('example.com')), 'URL 行不该进候选');
  assert.ok(!texts.some((t) => t.includes('const x = 1')), '代码块不该进候选');
  // kind 映射：结论→fact、坑→gotcha、约定→decision
  const byText = new Map(got.map((c) => [c.text, c.kind]));
  const kindOf = (needle) => [...byText].find(([t]) => t.includes(needle))?.[1];
  assert.equal(kindOf('FTS5'), 'fact');
  assert.equal(kindOf('crontab'), 'gotcha');
  assert.equal(kindOf('launchd'), 'decision');
});

test('I28 队列：候选先落 inbox，accept 才进真相层，reject 不入库', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i28-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i28', cwd: memoHome });
  try {
    const queue = createCaptureQueue({ memoHome, scope: 'repo:i28' });
    const cands = extractCandidates('记住：sedimem 的真相层是 append-only JSONL\n坑：crontab 会被 TCC 拦');
    assert.ok(cands.length >= 2, `候选数: ${cands.length}`);
    queue.add(cands, { by: SRC });
    assert.equal(queue.size(), cands.length, `inbox 条数应为 ${cands.length}`);

    // 候选阶段：真相层必须还是空的（半自动 = 人/Agent 决定后才写）
    assert.equal((await service.stats()).total, 0, 'inbox 不得直接写真相层');

    const pending = queue.list({ status: 'pending' });
    const [first, second] = pending;
    const acc = await queue.accept([first.id], { service });
    assert.equal(acc.accepted.length, 1, JSON.stringify(acc));
    const after = await service.stats();
    assert.equal(after.total, 1, 'accept 后才有 1 条入库');
    assert.equal(queue.size(), cands.length, 'inbox 行数不变（append-only 状态流）');

    queue.reject([second.id], { note: '不是长期事实' });
    assert.equal((await service.stats()).total, 1, 'reject 不入库');
    assert.equal(queue.list({ status: 'rejected' }).length, 1);

    // 幂等：重复 accept 不再写第二条
    const again = await queue.accept([first.id], { service });
    assert.equal(again.accepted.length, 0, `重复 accept 应为空: ${JSON.stringify(again)}`);
    assert.equal((await service.stats()).total, 1);
  } finally {
    await service.close();
  }
});
