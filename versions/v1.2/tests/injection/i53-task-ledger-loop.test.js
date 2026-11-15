// I53 — 账本闭环：假转录 → captureTask 分段落盘 → index/brief/expand 全链路
// 钉住：
//   1. segments.jsonl 行数 === index.segments.length（index 只是派生视图，不是第二真相）
//   2. briefJson 的 decisions/gotchas 非空，且每条都能追溯到某个段的同名字段（segmentId/fromSeq 对得上）
//   3. expandSegment 能从段 anchor 还原原 turn 文本
//   4. captureTask 不写真相层 items/<scope>.jsonl（账本是段级视图，不改 record 层）

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { captureTask } from '../../src/session/capture.js';
import { readIndex, readSegments, segmentsFile } from '../../src/session/ledger.js';
import { briefJson } from '../../src/session/ledger-brief.js';
import { expandSegment } from '../../src/session/expand.js';
import { cwdToSessionSlug } from '../../src/session/transcript.js';

const CWD = '/tmp/demo';
const TASK_ID = '20261115-1000-i53a';
const FIXED_MS = Date.UTC(2026, 10, 15, 2, 0, 0);
const CLOCK = { nowMs: () => FIXED_MS, now: () => new Date(FIXED_MS).toISOString() };

function zstdFrame(events) {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

async function writeTranscript({ sessionsRoot, sessionId, frames }) {
  const dir = path.join(sessionsRoot, cwdToSessionSlug(CWD), sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  await fsp.writeFile(file, Buffer.concat(frames.map(zstdFrame)));
  return file;
}

function fixtureFrames() {
  const user = (seq, text) => ({ type: 'user/message', seq, time: FIXED_MS + seq, data: { content: [{ type: 'text', text }] } });
  const assistant = (seq, text) => ({ type: 'assistant/message', seq, time: FIXED_MS + seq, data: { message: { content: [{ type: 'text', text }] } } });
  return [
    [
      { type: 'turn/start', time: FIXED_MS, data: { turn: 1 } },
      user(1, '请实现会话账本段存储，I53-原始诉求标记。'),
      assistant(2, '决定把段存储改为先写 ledger.js，再补 capture.js 测试。相关文件在 src/session/ledger.js。'),
    ],
    [
      { type: 'turn/start', time: FIXED_MS + 3, data: { turn: 2 } },
      user(3, '继续，I53-原始追问标记：expand 能还原这一 turn 吗？'),
      assistant(4, '坑：appendSegment 必须在锁内判重叠，否则会重复写入。'),
    ],
  ];
}

test('I53 captureTask 写出段与 index，brief 只取段内条目，expand 还原原文，真相层为零', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i53-'));
  const memoHome = path.join(root, 'home');
  const sessionsRoot = path.join(root, 'sessions-root');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sessionId = 'sess-i53-fixture';
  const transcriptFile = await writeTranscript({ sessionsRoot, sessionId, frames: fixtureFrames() });

  const res = await captureTask({ memoHome, taskId: TASK_ID, cwd: CWD, sessionsRoot, sessionId, clock: CLOCK });
  assert.equal(res.created, 1, `应新建 1 段: ${JSON.stringify(res)}`);
  assert.equal(res.skipped, 0);
  assert.equal(res.segments.length, 1);

  // 1) index 是派生视图：行数、段数、区间三者一致
  const { segments, badLines } = await readSegments({ memoHome, taskId: TASK_ID });
  const index = await readIndex({ memoHome, taskId: TASK_ID });
  assert.equal(badLines, 0, '段文件不应有坏行');
  const raw = await fsp.readFile(segmentsFile(memoHome, TASK_ID), 'utf8');
  assert.equal(raw.split('\n').filter((line) => line.trim() !== '').length, index.segments.length,
    'segments.jsonl 行数必须等于 index 里的段数');
  assert.equal(index.segments.length, segments.length);
  assert.equal(segments[0].fromSeq, 1);
  assert.equal(segments[0].toSeq, 5, '4 条 turn 应覆盖 [1,5)');
  assert.equal(segments[0].anchor.path, transcriptFile);

  // 2) brief 的 decisions/gotchas 非空，且每条来自段（segmentId/fromSeq/文本都对得上）
  const brief = await briefJson({ memoHome, taskId: TASK_ID, clock: CLOCK });
  assert.ok(brief.decisions.length > 0, `decisions 不应为空: ${JSON.stringify(brief)}`);
  assert.ok(brief.gotchas.length > 0, `gotchas 不应为空: ${JSON.stringify(brief)}`);
  const segById = new Map(segments.map((seg) => [seg.id, seg]));
  for (const [field, items] of [['decisions', brief.decisions], ['gotchas', brief.gotchas]]) {
    for (const item of items) {
      const seg = segById.get(item.segmentId);
      assert.ok(seg, `${field} 条目必须带已知 segmentId: ${JSON.stringify(item)}`);
      assert.ok(seg[field].includes(item.text), `${field} 条目必须逐字来自段: ${JSON.stringify(item)}`);
      assert.equal(item.fromSeq, seg.fromSeq);
    }
  }
  assert.equal(brief.segments.total, 1);
  assert.equal(brief.segments.quarantined, 0);
  assert.equal(brief.budget.truncated, false);

  // 3) expand 从 anchor 重读转录，拼回原 turn 文本
  const expanded = await expandSegment({ memoHome, taskId: TASK_ID, segmentId: segments[0].id, sessionsRoot });
  assert.ok(expanded.text.includes('I53-原始诉求标记'), `expand 应含首条 user 原文: ${expanded.text}`);
  assert.ok(expanded.text.includes('I53-原始追问标记'), `expand 应含第二条 user 原文: ${expanded.text}`);
  assert.ok(expanded.text.includes('坑：appendSegment'), 'expand 应含 assistant 原文');
  assert.ok(expanded.chars > 0);

  // 4) 真相层闭环：账本不写 items/<scope>.jsonl（也没有任何 items 行）
  const itemsFile = path.join(memoHome, 'items', `session:${TASK_ID}.jsonl`);
  const itemsExists = await fsp.stat(itemsFile).then(() => true, () => false);
  assert.equal(itemsExists, false, 'captureTask 不得创建真相层 items 文件');
  const itemsFiles = await fsp.readdir(path.join(memoHome, 'items')).catch(() => []);
  assert.equal(itemsFiles.filter((name) => name.endsWith('.jsonl')).length, 0,
    `账本不得往 items/ 写 record: ${itemsFiles.join(',')}`);
});
