// tests/unit/session-codex-capture.test.js — 跨 harness：Codex rollout → 任务账本段
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureTask } from '../../src/session/capture.js';
import { readCodexSession, findLatestCodexRollout } from '../../src/session/transcript.js';
import { readSegments } from '../../src/session/ledger.js';
import { resolveSessionSource } from '../../src/session/auto-capture.js';

const SID = '01a1ec76-0fc0-7293-8196-d7eba86c6124';
const CWD = '/tmp/sedimem-codex-fixture';
let home; let root; let file;

function rec(type, payload) {
  return JSON.stringify({ timestamp: '2026-11-18T02:26:32.202Z', type, payload });
}
function msg(role, text) {
  return rec('response_item', { type: 'message', role, content: [{ type: 'input_text', text }] });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memo-codex-'));
  root = join(home, 'codex', 'sessions');
  const dir = join(root, '2026', '11', '18');
  mkdirSync(dir, { recursive: true });
  file = join(dir, `rollout-2026-11-18T10-22-02-${SID}.jsonl`);
  writeFileSync(file, [
    rec('session_meta', { session_id: SID, id: SID, cwd: CWD }),
    msg('user', '先读 sedimem 的未来计划，再评估 Codex 会话能否自动入账。'),
    msg('assistant', '结论：DSH 有转录适配器，Codex 只有 readCodexRollout，还没接进 captureTask。'),
    msg('user', '那就把 Codex 也接进来，自动捕获一起做。'),
    msg('assistant', '决定：新增 sourceKind=codex，按 rollout 文件切段。'),
    msg('user', '下一步补测试和文档。'),
    msg('assistant', '好，先跑规则抽取，LLM 不可用回落 rules。'),
    msg('user', '确认一下第二次捕获幂等。'),
    msg('assistant', '第二次 created=0。'),
  ].join('\n') + '\n');
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test('readCodexSession: 解析 rollout 为 turns 并带 sessionId', () => {
  const tx = readCodexSession({ sessionsRoot: root, file });
  assert.equal(tx.sessionId, SID);
  assert.ok(tx.turns.length >= 5);
  assert.equal(tx.turns[0].role, 'user');
});

test('findLatestCodexRollout: 按 cwd 找到该会话', () => {
  assert.equal(findLatestCodexRollout({ sessionsRoot: root, cwd: CWD }), file);
});

test('resolveSessionSource: 绑定 id 能解析到 Codex rollout', () => {
  const r = resolveSessionSource({ sessionId: SID, cwd: CWD, codexRoot: root });
  assert.equal(r.kind, 'codex');
  assert.equal(r.file, file);
});

test('captureTask(sourceKind=codex): 写 codex 段、第二次幂等', async () => {
  const args = {
    memoHome: home, taskId: 'task-codex', cwd: CWD,
    sourceKind: 'codex', codexSessionsRoot: root, codexFile: file,
    sessionId: SID, mode: 'rules',
  };
  const first = await captureTask(args);
  assert.equal(first.created, 1);
  assert.equal(first.segments[0].source.kind, 'codex');
  const segs = readSegments({ memoHome: home, taskId: 'task-codex' }).segments;
  assert.equal(segs.length, 1);
  assert.equal(segs[0].source.sessionId, SID);
  const second = await captureTask(args);
  assert.equal(second.created, 0);
  assert.equal(readSegments({ memoHome: home, taskId: 'task-codex' }).segments.length, 1);
});
