// tests/unit/transcript-real.test.js — B0：DSH 会话转录读取（多帧 zstd + 真实 v4 schema）。
// 两条路线：
//   1. 自造 fixture（tests/fixtures/transcript/ 下两帧 zstd）→ CI 必跑，断言 frames/turns/role 顺序/中文；
//   2. 本机真实 ~/.dsh/sessions → 没有真实数据（如 CI）时 t.skip，不失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cwdToSessionSlug, readDshTranscript, toTurns } from '../../src/session/transcript.js';
import {
  FIXTURE_CWD, FIXTURE_FILE, FIXTURE_SESSION_ID, FIXTURE_SESSIONS_ROOT, generateFixture,
} from '../fixtures/transcript/generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION_ROOT = path.resolve(HERE, '..', '..'); // versions/v1.2
const REPO_ROOT = path.resolve(VERSION_ROOT, '..', '..'); // sedimem 仓库根
const WORK_ROOT = path.resolve(REPO_ROOT, '..'); // 仓库上一级（DSH 进程 cwd）

test('B0 cwdToSessionSlug：DSH 目录两側各加 --，cwd 非字母数字折成 -', () => {
  assert.equal(
    cwdToSessionSlug(WORK_ROOT),
    '--Users-yeager-work-yeager-ldywoker--',
  );
  // 尾斜杠不应留下多余的 -
  assert.equal(
    cwdToSessionSlug(`${WORK_ROOT}/`),
    '--Users-yeager-work-yeager-ldywoker--',
  );
  // 空格/多分隔符折成一个 -
  assert.equal(cwdToSessionSlug('/tmp/a b/c'), '--tmp-a-b-c--');
  // 错误入参
  assert.throws(() => cwdToSessionSlug(''), (e) => e.code === 'E_INVALID_ARG');
});

test('B0 自造 fixture：两帧 zstd 全部解出，4 个对话 turn，中文不乱码', () => {
  generateFixture(); // 幂等：CI 上即使二进制未入库也能就地生成
  assert.ok(existsSync(FIXTURE_FILE), `fixture 应存在: ${FIXTURE_FILE}`);

  const res = readDshTranscript({
    sessionsRoot: FIXTURE_SESSIONS_ROOT,
    cwd: FIXTURE_CWD,
    sessionId: FIXTURE_SESSION_ID,
  });

  assert.equal(res.frames, 2, 'fixture 由两帧 zstd 拼接');
  assert.equal(res.badFrames, 0);
  assert.equal(res.events, 6, '2 条 user/message + 2 条 assistant/message + 2 条 turn/start');
  assert.equal(res.turns.length, 4, 'turn/start 不算对话 turn');
  assert.ok(res.bytes > 0);

  assert.deepEqual(res.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant'],
    '按 seq 升序且 turn/start 被跳过');
  // 逐字比较：解码/帧拼接正确则中文不可能乱码
  assert.equal(res.turns[0].text, '你好，这是第一帧的用户消息。');
  assert.equal(res.turns[1].text, '收到第一帧：上海天气晴。');
  assert.equal(res.turns[2].text, '第二帧：请总结一下。');
  assert.equal(res.turns[3].text, '第二帧总结：一切正常。');
  // rec.time 毫秒数 → ISO
  assert.equal(res.turns[0].ts, new Date(1790000000001).toISOString());
});

test('B0 宽松兜底：slug 对不上时线性扫目录仍能找到真实会话', () => {
  generateFixture();
  const res = readDshTranscript({
    sessionsRoot: FIXTURE_SESSIONS_ROOT,
    cwd: '/tmp/transcript_fixture', // 下划线 → 精确 slug 不存在，归一化后与 fixture 目录一致
    sessionId: FIXTURE_SESSION_ID,
  });
  assert.equal(res.frames, 2);
  assert.equal(res.turns.length, 4);
});

test('B0 找不到转录：抛 E_TRANSCRIPT_UNAVAILABLE 且错误里带尝试过的路径', () => {
  assert.throws(
    () => readDshTranscript({ sessionsRoot: FIXTURE_SESSIONS_ROOT, cwd: '/no/such/cwd-zz', sessionId: 'nope' }),
    (e) => e.code === 'E_TRANSCRIPT_UNAVAILABLE' && /已尝试/.test(e.message),
  );
});

test('B0 旧 schema 仍兼容（user_message / payload.role）', () => {
  const { turns } = toTurns([
    { type: 'user_message', message: '旧用户消息', ts: '2026-01-01T00:00:00Z' },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: '旧回答' }] } },
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'tool/call', seq: 1, data: { name: 'bash' } },
  ]);
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', '旧用户消息'],
    ['assistant', '旧回答'],
  ]);
});

/** 本机真实 DSH 会话：返回 {sessionsRoot, cwd, sessionId, file} 或 null */
function pickRealSession() {
  const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
  if (!existsSync(sessionsRoot)) return null;
  const cwdCandidates = [
    process.env.SEDIMEM_DSH_CWD,
    WORK_ROOT,
    VERSION_ROOT,
    process.cwd(),
  ].filter((c) => typeof c === 'string' && c !== '');
  for (const cwd of cwdCandidates) {
    const slugDir = path.join(sessionsRoot, cwdToSessionSlug(cwd));
    if (!existsSync(slugDir)) continue;
    const sessions = readdirSync(slugDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const file = path.join(slugDir, e.name, 'session.v4.jsonl.zstd');
        return { sessionId: e.name, file, size: existsSync(file) ? statSync(file).size : -1 };
      })
      .filter((s) => s.size > 0);
    if (sessions.length === 0) continue;
    // 取最大的真实会话：同时验证「大文件/多帧」不会炸内存或超时
    sessions.sort((a, b) => b.size - a.size);
    return { sessionsRoot, cwd, sessionId: sessions[0].sessionId, file: sessions[0].file, size: sessions[0].size };
  }
  return null;
}

test('B0 真实会话：本机 ~/.dsh/sessions 全量事件解析（无数据则 skip）', (t) => {
  const real = pickRealSession();
  if (!real) {
    t.skip('本机没有 ~/.dsh/sessions 真实会话数据（CI 环境），跳过');
    return;
  }
  const startedAt = Date.now();
  const res = readDshTranscript({
    sessionsRoot: real.sessionsRoot,
    cwd: real.cwd,
    sessionId: real.sessionId,
  });
  const elapsedMs = Date.now() - startedAt;

  t.diagnostic(
    `真实会话 ${real.sessionId}: ${real.size}B 压缩 → frames=${res.frames}, badFrames=${res.badFrames}, `
    + `events=${res.events}, turns=${res.turns.length}, bytes=${res.bytes}, 耗时=${elapsedMs}ms`,
  );

  assert.ok(res.frames >= 2, `多帧 zstd 应切出 >=2 帧，实际 ${res.frames}`);
  assert.ok(res.events > 1, `应解出 >1 条事件，实际 ${res.events}`);
  assert.ok(res.badFrames <= 2, `尾部半帧最多容忍 2 个坏帧，实际 ${res.badFrames}`);
  assert.ok(res.turns.length > 0, `应抽到对话 turn，实际 ${res.turns.length}`);
  assert.ok(res.bytes > 0);
  for (const turn of res.turns) {
    assert.ok(turn.role === 'user' || turn.role === 'assistant', `role 只能是 user/assistant: ${turn.role}`);
    assert.equal(typeof turn.text, 'string');
    assert.ok(turn.text.length > 0, 'turn 文本不应为空');
  }
  assert.ok(res.turns.some((x) => x.role === 'user'), '真实会话应至少有一条 user turn');
});
