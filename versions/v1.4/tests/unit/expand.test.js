// tests/unit/expand.test.js — B2 段展开（versions/v1.2/src/session/expand.js）
// 覆盖（SPEC §6）：按 anchor 重读转录，把 [fromSeq, toSeq) 的 turn 还原成 `[seq] role: text`；
//   - 用 tests/fixtures 的两帧 zstd fixture（同 transcript-real.test.js 做法），验证跨帧解码 + seq 对齐；
//   - turn/start 不算对话 turn，行数 = 区间内 turn 数；
//   - toFile=true 写到 sessions/<taskId>/expanded/<segmentId>.txt 并返回路径；
//   - 段不存在抛 E_NOT_FOUND；转录缺失抛 E_TRANSCRIPT_UNAVAILABLE；相对 anchor.path 走 sessionsRoot。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendSegment } from '../../src/session/ledger.js';
import { newId } from '../../src/core/ids.js';
import { expandSegment } from '../../src/session/expand.js';
import { FIXTURE_FILE, generateFixture } from '../fixtures/transcript/generate.mjs';

const MS = Date.parse('2026-11-15T09:45:00.000Z');
const ISO = new Date(MS).toISOString();
const clock = { nowMs: () => MS, now: () => ISO };

let home;
let idCounter = 0;

beforeEach(() => {
  generateFixture(); // 幂等：CI 上二进制未必入库，就地生成
  home = mkdtempSync(path.join(tmpdir(), 'memo-expand-'));
  idCounter = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function makeSegment(fromSeq, toSeq, over = {}) {
  idCounter += 1;
  return {
    id: `seg_${newId(MS + idCounter)}`,
    taskId: 'unused',
    fromSeq,
    toSeq,
    createdAt: ISO,
    source: { kind: 'dsh', path: FIXTURE_FILE, sessionId: 'fixture-session', frames: 2 },
    anchor: { path: FIXTURE_FILE, fromSeq, toSeq },
    summary: `段 [${fromSeq}, ${toSeq}) 摘要`,
    facts: [],
    decisions: [],
    gotchas: [],
    pendingJobs: [],
    files: [],
    nextSteps: [],
    tokens: null,
    trust: 'T1',
    taint: [],
    quarantined: false,
    mode: 'rules',
    ...over,
  };
}

/** 造一个任务账本，返回写入的段（每段区间互不相交，appendSegment 会校验） */
async function seedTask(taskId, ranges) {
  const out = [];
  for (const [fromSeq, toSeq, over] of ranges) {
    const segment = makeSegment(fromSeq, toSeq, over);
    await appendSegment({ memoHome: home, taskId, segment, clock });
    out.push(segment);
  }
  return out;
}

/** 把展开文本解析回 [{seq, role, text}]，用于断言「行数与 seq 对得上」 */
function parseExpanded(text) {
  if (text === '') return [];
  return text.split('\n').map((line) => {
    const m = /^\[(\d+)\] ([a-zA-Z_]+): ([\s\S]*)$/.exec(line);
    assert.ok(m, `展开行格式必须是 "[seq] role: text"，实际：${JSON.stringify(line)}`);
    return { seq: Number(m[1]), role: m[2], text: m[3] };
  });
}

describe('expand: fixture 两帧 zstd 的 seq 对齐', () => {
  test('段 [2,4)：展开 user/assistant 两条，行首 seq 与转录一致', async () => {
    const [seg] = await seedTask('t-basic', [[2, 4]]);

    const res = expandSegment({ memoHome: home, taskId: 't-basic', segmentId: seg.id });

    assert.equal(res.text, [
      '[2] user: 你好，这是第一帧的用户消息。',
      '[3] assistant: 收到第一帧：上海天气晴。',
    ].join('\n'));
    assert.equal(res.chars, res.text.length);
    assert.equal(res.file, undefined, '未传 toFile 时不写文件');
    assert.ok(!existsSync(path.join(home, 'sessions', 't-basic', 'expanded')));

    const turns = parseExpanded(res.text);
    assert.equal(turns.length, 2, '行数 = 区间内对话 turn 数（turn/start 不算）');
    assert.deepEqual(turns.map((t) => t.seq), [2, 3]);
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
  });

  test('跨帧区间 [3,6)：跨两帧 zstd 拼接后按 seq 对齐，turn/start(seq=4) 被跳过', async () => {
    const [seg] = await seedTask('t-cross', [[3, 6]]);

    const res = expandSegment({ memoHome: home, taskId: 't-cross', segmentId: seg.id });
    const turns = parseExpanded(res.text);

    assert.deepEqual(turns.map((t) => t.seq), [3, 5], 'seq 4 是 turn/start，不产生行');
    assert.deepEqual(turns.map((t) => t.text), [
      '收到第一帧：上海天气晴。',
      '第二帧：请总结一下。',
    ]);
  });

  test('整段 [2,7)：4 个 turn 全部展开，行数与 seq 一一对应', async () => {
    const [seg] = await seedTask('t-all', [[2, 7]]);
    const res = expandSegment({ memoHome: home, taskId: 't-all', segmentId: seg.id });
    const turns = parseExpanded(res.text);
    assert.deepEqual(turns.map((t) => t.seq), [2, 3, 5, 6]);
    assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(turns[3].text, '第二帧总结：一切正常。', '第 2 帧 data.message.content 形状也要解出');
  });
});

describe('expand: toFile / 错误路径', () => {
  test('toFile=true 写到 sessions/<taskId>/expanded/<segmentId>.txt 并返回绝对路径', async () => {
    const [seg] = await seedTask('t-file', [[2, 4]]);

    const res = expandSegment({ memoHome: home, taskId: 't-file', segmentId: seg.id, toFile: true });

    const expected = path.join(home, 'sessions', 't-file', 'expanded', `${seg.id}.txt`);
    assert.equal(res.file, expected);
    assert.ok(existsSync(expected), '文件必须落盘');
    assert.equal(readFileSync(expected, 'utf8'), res.text);
  });

  test('toFile=显式路径：写到指定位置（本地 CLI --out）', async () => {
    const [seg] = await seedTask('t-out', [[2, 4]]);
    const out = path.join(home, 'exports', 'seg.txt');
    const res = expandSegment({ memoHome: home, taskId: 't-out', segmentId: seg.id, toFile: out });
    assert.equal(res.file, out);
    assert.equal(readFileSync(out, 'utf8'), res.text);
  });

  test('段不存在 / 任务不存在 → E_NOT_FOUND', async () => {
    const [seg] = await seedTask('t-missing', [[2, 4]]);
    assert.throws(
      () => expandSegment({ memoHome: home, taskId: 't-missing', segmentId: 'seg_nope000000000000000000000' }),
      (e) => e.code === 'E_NOT_FOUND' && /seg_nope/.test(e.message),
    );
    assert.throws(
      () => expandSegment({ memoHome: home, taskId: 't-no-task', segmentId: seg.id }),
      (e) => e.code === 'E_NOT_FOUND',
    );
  });

  test('anchor 指向的转录不存在 → E_TRANSCRIPT_UNAVAILABLE，错误里带已尝试路径', async () => {
    const [seg] = await seedTask('t-gone', [[2, 4, {
      anchor: { path: path.join(home, 'nope', 'missing.jsonl.zstd'), fromSeq: 2, toSeq: 4 },
    }]]);
    assert.throws(
      () => expandSegment({ memoHome: home, taskId: 't-gone', segmentId: seg.id }),
      (e) => e.code === 'E_TRANSCRIPT_UNAVAILABLE' && /已尝试/.test(e.message),
    );
  });

  test('anchor.path 为相对路径时按 sessionsRoot 解析', async () => {
    const sessionsRoot = path.dirname(FIXTURE_FILE);
    const [seg] = await seedTask('t-rel', [[2, 4, {
      anchor: { path: path.basename(FIXTURE_FILE), fromSeq: 2, toSeq: 4 },
    }]]);
    const res = expandSegment({
      memoHome: home, taskId: 't-rel', segmentId: seg.id, sessionsRoot,
    });
    assert.equal(parseExpanded(res.text).length, 2);
  });

  test('参数校验：非法 segmentId / toFile → E_INVALID_ARG', async () => {
    const [seg] = await seedTask('t-bad', [[2, 4]]);
    assert.throws(
      () => expandSegment({ memoHome: home, taskId: 't-bad', segmentId: '../escape' }),
      (e) => e.code === 'E_INVALID_ARG',
    );
    assert.throws(
      () => expandSegment({ memoHome: home, taskId: 't-bad', segmentId: seg.id, toFile: 7 }),
      (e) => e.code === 'E_INVALID_ARG',
    );
  });
});
