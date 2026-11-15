// I54 — 区间幂等与重叠：重复 capture 不重复落段，重叠 append 抛 E_ALREADY_CAPTURED
// 钉住：
//   1. 同一转录连跑两次 captureTask：第二次 {created:0, skipped:1}，segments.jsonl 仍只有 1 行
//   2. 手工 append 与既有段重叠的区间 → E_ALREADY_CAPTURED，且零写入（fail-closed）
//   3. 半开区间相切不算重叠（[1,5)+[5,7) 可追加），coveredSeqs 合并为 [1,7) 且无重叠

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { captureTask } from '../../src/session/capture.js';
import { appendSegment, coveredSeqs, readSegments, segmentsFile } from '../../src/session/ledger.js';
import { cwdToSessionSlug } from '../../src/session/transcript.js';

const CWD = '/tmp/demo';
const TASK_ID = '20261115-1001-i54a';
const FIXED_MS = Date.UTC(2026, 10, 15, 2, 10, 0);
const CLOCK = { nowMs: () => FIXED_MS, now: () => new Date(FIXED_MS).toISOString() };

function zstdFrame(events) {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

async function writeTranscript({ sessionsRoot, sessionId, frames }) {
  const dir = path.join(sessionsRoot, cwdToSessionSlug(CWD), sessionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames.map(zstdFrame)));
}

function fixtureFrames() {
  const user = (seq, text) => ({ type: 'user/message', seq, time: FIXED_MS + seq, data: { content: [{ type: 'text', text }] } });
  const assistant = (seq, text) => ({ type: 'assistant/message', seq, time: FIXED_MS + seq, data: { message: { content: [{ type: 'text', text }] } } });
  return [
    [
      { type: 'turn/start', time: FIXED_MS, data: { turn: 1 } },
      user(1, '实现账本区间去重，I54-第一段。'),
      assistant(2, '决定先写 coveredSeqs 再写 appendSegment。'),
    ],
    [
      { type: 'turn/start', time: FIXED_MS + 3, data: { turn: 2 } },
      user(3, '继续，I54-第二段。'),
      assistant(4, '注意半开区间相切不算重叠，但 index 会合并区间。'),
    ],
  ];
}

async function lineCount(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return raw.split('\n').filter((line) => line.trim() !== '').length;
}

test('I54 重复 capture 幂等、重叠 append 抛错、coveredSeqs 合并且无重叠', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i54-'));
  const memoHome = path.join(root, 'home');
  const sessionsRoot = path.join(root, 'sessions-root');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sessionId = 'sess-i54-fixture';
  await writeTranscript({ sessionsRoot, sessionId, frames: fixtureFrames() });

  const first = await captureTask({ memoHome, taskId: TASK_ID, cwd: CWD, sessionsRoot, sessionId, clock: CLOCK });
  assert.equal(first.created, 1);
  const file = segmentsFile(memoHome, TASK_ID);
  assert.equal(await lineCount(file), 1);

  // 1) 第二次 capture 是幂等的：不重复落段，只报 skipped
  const second = await captureTask({ memoHome, taskId: TASK_ID, cwd: CWD, sessionsRoot, sessionId, clock: CLOCK });
  assert.equal(second.created, 0, `第二次 created 必须为 0: ${JSON.stringify(second)}`);
  assert.equal(second.skipped, 1);
  assert.equal(second.segments.length, 0);
  assert.equal(await lineCount(file), 1, '重复 capture 不得追加段行');
  assert.deepEqual(await coveredSeqs({ memoHome, taskId: TASK_ID }), [[1, 5]]);

  // 2) 手工追加与 [1,5) 重叠的区间 → E_ALREADY_CAPTURED，且零写入
  const before = await fsp.readFile(file, 'utf8');
  const overlapSeg = {
    fromSeq: 2,
    toSeq: 4,
    anchor: { path: '/tmp/i54-overlap.jsonl', fromSeq: 2, toSeq: 4 },
    summary: 'I54-重叠段（不应落盘）',
  };
  await assert.rejects(
    appendSegment({ memoHome, taskId: TASK_ID, segment: overlapSeg, clock: CLOCK }),
    (err) => {
      assert.equal(err.code, 'E_ALREADY_CAPTURED', `应抛 E_ALREADY_CAPTURED，实际 ${err.code}: ${err.message}`);
      return true;
    },
  );
  assert.equal(await fsp.readFile(file, 'utf8'), before, '重叠 append 失败后段文件必须零改动');
  assert.deepEqual(await coveredSeqs({ memoHome, taskId: TASK_ID }), [[1, 5]], '失败的 append 不得污染 index');

  // 3) 半开区间相切（[5,7)）可以追加；index 合并为 [1,7)，coveredSeqs 无重叠
  const added = await appendSegment({
    memoHome,
    taskId: TASK_ID,
    clock: CLOCK,
    segment: {
      fromSeq: 5,
      toSeq: 7,
      anchor: { path: '/tmp/i54-tail.jsonl', fromSeq: 5, toSeq: 7 },
      summary: 'I54-相切追加段，覆盖后续 turn',
      decisions: ['决定用相切区间验证半开区间语义。'],
    },
  });
  assert.equal(added.index.segments.length, 2);
  assert.equal(await lineCount(file), 2);
  const { segments } = await readSegments({ memoHome, taskId: TASK_ID });
  assert.equal(segments.length, 2);

  const covered = await coveredSeqs({ memoHome, taskId: TASK_ID });
  assert.deepEqual(covered, [[1, 7]], `相邻区间应被合并: ${JSON.stringify(covered)}`);
  for (let i = 1; i < covered.length; i++) {
    assert.ok(covered[i][0] >= covered[i - 1][1],
      `区间必须升序且两两不重叠: ${JSON.stringify(covered)}`);
  }
});
