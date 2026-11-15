// tests/fixtures/transcript/generate.mjs — 生成 B0 自造 DSH 转录 fixture（两帧 zstd）。
// 为什么自造：CI 上没有 ~/.dsh 真实会话，必须有一条不依赖本机数据的用例。
// 结构对齐真实 DSH：
//   <sessionsRoot>/--tmp-transcript-fixture--/fixture-session/session.v4.jsonl.zstd
// 内容：2 条 user/message + 2 条 assistant/message + 2 条 turn/start，按 seq 递增排好。
// 第 2 帧的 assistant 用真实形状 data.message.content（第 1 帧用 data.content），两种都覆盖。
// 用法：node tests/fixtures/transcript/generate.mjs（测试里也直接 import generateFixture()）。
import * as zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_SESSIONS_ROOT = path.join(HERE, 'sessions');
export const FIXTURE_CWD = '/tmp/transcript-fixture';
export const FIXTURE_SESSION_ID = 'fixture-session';
export const FIXTURE_SLUG = '--tmp-transcript-fixture--';
export const FIXTURE_FILE = path.join(
  FIXTURE_SESSIONS_ROOT, FIXTURE_SLUG, FIXTURE_SESSION_ID, 'session.v4.jsonl.zstd',
);

/** 两帧的原始 JSONL 事件（frame1 3 条 / frame2 3 条） */
const FRAMES = [
  [
    { type: 'turn/start', seq: 1, time: 1790000000000, data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: 1790000000001,
      data: {
        content: [{ type: 'text', text: '你好，这是第一帧的用户消息。' }],
        source: { kind: 'user' }, role: 'user', id: 'u-1',
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message', seq: 3, time: 1790000000002,
      data: {
        turn: 1, step: 1,
        content: [{ type: 'text', text: '收到第一帧：上海天气晴。' }],
        role: 'assistant', id: 'a-1',
      },
      surfaceOp: 'append',
    },
  ],
  [
    { type: 'turn/start', seq: 4, time: 1790000000003, data: { turn: 2 } },
    {
      type: 'user/message', seq: 5, time: 1790000000004,
      data: {
        content: [{ type: 'text', text: '第二帧：请总结一下。' }],
        source: { kind: 'user' }, role: 'user', id: 'u-2',
      },
      surfaceOp: 'append',
    },
    {
      // 真实 DSH assistant 形状：文本在 data.message.content
      type: 'assistant/message', seq: 6, time: 1790000000005,
      data: {
        turn: 2, step: 1,
        message: {
          role: 'assistant', id: 'a-2',
          content: [{ type: 'text', text: '第二帧总结：一切正常。' }],
        },
      },
      surfaceOp: 'append',
    },
  ],
];

/**
 * 生成（覆盖写）fixture 文件：两段 JSONL 各压成一帧 zstd，再首尾拼接成一个文件。
 * 幂等：内容固定、可重复执行。
 * @returns {{file: string, frames: number, events: number}}
 */
export function generateFixture() {
  const frameBuffers = FRAMES.map((events) => {
    const raw = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    return zlib.zstdCompressSync(Buffer.from(raw, 'utf8'));
  });
  mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
  writeFileSync(FIXTURE_FILE, Buffer.concat(frameBuffers));
  return {
    file: FIXTURE_FILE,
    frames: frameBuffers.length,
    events: FRAMES.reduce((n, f) => n + f.length, 0),
  };
}

// 直接执行时生成并打印路径
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = generateFixture();
  console.log(`fixture 已生成: ${out.file}（${out.frames} 帧 / ${out.events} 事件）`);
}
