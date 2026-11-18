// tests/unit/auto-capture.test.js — MCP 挂车自动捕获 + close 捕获（issue #223）
// 临时 MEMO_HOME + 伪转录树，captureTaskImpl 注入（不真解压 zstd、不真写段）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AUTO_CAPTURE_TOOLS,
  captureOnCloseEnabled,
  decideAutoCapture,
  isAutoCaptureCandidateTool,
  maybeAutoCapture,
  postToolAutoCapture,
  readAutoCaptureState,
} from '../../src/session/auto-capture.js';
import { cwdToSessionSlug } from '../../src/session/transcript.js';

const BASE_POLICY = {
  session: {
    ledger: {
      enabled: true,
      captureOnClose: true,
      autoCapture: { enabled: true, captureTokens: 1000, bytesPerToken: 1, minIntervalMs: 60_000, cooldownMs: 5_000 },
    },
  },
};

function makeFixture() {
  const memoHome = mkdtempSync(path.join(tmpdir(), 'sedimem-autocap-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'sedimem-autocap-cwd-'));
  const sessionsRoot = path.join(memoHome, 'dsh-sessions');
  const slug = cwdToSessionSlug(cwd);
  const txFile = path.join(sessionsRoot, slug, 'sess-1', 'session.v4.jsonl.zstd');
  mkdirSync(path.dirname(txFile), { recursive: true });
  writeFileSync(txFile, 'x'.repeat(2000));
  // 账本目录已存在（挂车捕获只维护已有账本）：segments.jsonl 是账本存在标记之一
  mkdirSync(path.join(memoHome, 'sessions', '20261114-2222-fix'), { recursive: true });
  writeFileSync(path.join(memoHome, 'sessions', '20261114-2222-fix', 'segments.jsonl'), '');
  const calls = [];
  const captureTaskImpl = async (args) => {
    calls.push(args);
    return { created: 1, skipped: 0, segments: [{ fromSeq: 1, toSeq: 2, summary: 'x', source: { kind: 'dsh', sessionId: 'sess-1' } }] };
  };
  const clock = { nowMs: () => 1_000_000 };
  const base = { memoHome, taskId: '20261114-2222-fix', cwd, sessionsRoot, policy: BASE_POLICY, clock, captureTaskImpl };
  return { memoHome, cwd, sessionsRoot, txFile, calls, clock, base };
}

test('maybeAutoCapture: 首次运行（账本在、转录在、无状态）→ 捕获并写状态', async () => {
  const f = makeFixture();
  // 显式 sessionId（模拟 bind 后的探测），并断言它透传到 captureTask（issue #230）
  const r = await maybeAutoCapture({ ...f.base, sessionId: 'sess-1' });
  assert.equal(r.ran, true);
  assert.equal(r.reason, 'first-run');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].mode, 'rules', '自动捕获必须 rules 模式（零 token）');
  assert.equal(f.calls[0].taskId, '20261114-2222-fix');
  assert.equal(f.calls[0].sessionId, 'sess-1', 'sessionId 必须透传 captureTask（bind 探测的意义，issue #230）');
  const st = readAutoCaptureState(f.memoHome, '20261114-2222-fix');
  assert.ok(st, '状态文件已写');
  assert.equal(st.mtimeMs > 0, true);
  assert.equal(st.size, 2000);
  assert.equal(st.lastSuccessAt, 1_000_000);
  assert.equal(st.sessionId, 'sess-1');
  const raw = readFileSync(path.join(f.memoHome, 'sessions', '20261114-2222-fix', 'autocapture.json'), 'utf8');
  assert.ok(raw.endsWith('\n'), '状态文件尾换行（Q8）');
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: 转录未变 → unchanged 不捕获', async () => {
  const f = makeFixture();
  await maybeAutoCapture(f.base);
  f.calls.length = 0;
  const r = await maybeAutoCapture(f.base);
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'unchanged');
  assert.equal(f.calls.length, 0);
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: 增长低于阈值且间隔未到 → below-threshold', async () => {
  const f = makeFixture();
  await maybeAutoCapture(f.base);
  f.calls.length = 0;
  writeFileSync(f.txFile, 'x'.repeat(2100)); // 增长 100 < 阈值 captureTokens(1000)×bytesPerToken(1)
  const clock2 = { nowMs: () => 1_000_000 + 6_000 }; // 过 cooldown(5s) 但未到 interval(60s)
  const r = await maybeAutoCapture({ ...f.base, clock: clock2 });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'below-threshold');
  assert.equal(f.calls.length, 0);
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: 增长小但间隔已到 → 不再按 interval 兜底，必须等 30k 阈值', async () => {
  const f = makeFixture();
  await maybeAutoCapture(f.base);
  f.calls.length = 0;
  writeFileSync(f.txFile, 'x'.repeat(2100));
  const clock2 = { nowMs: () => 1_000_000 + 61_000 };
  const r = await maybeAutoCapture({ ...f.base, clock: clock2 });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'below-threshold');
  assert.equal(f.calls.length, 0);
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: 增长达阈值 → 立即捕获（不等间隔，过 cooldown 即可）', async () => {
  const f = makeFixture();
  await maybeAutoCapture(f.base);
  f.calls.length = 0;
  writeFileSync(f.txFile, 'x'.repeat(6000)); // 增长 4000 ≥ 阈值 1000
  const clock2 = { nowMs: () => 1_000_000 + 6_000 }; // 过 cooldown(5s)
  const r = await maybeAutoCapture({ ...f.base, clock: clock2 });
  assert.equal(r.ran, true);
  assert.equal(r.reason, 'threshold-reached');
  assert.equal(f.calls.length, 1);
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: 冷却期内 → cooldown；force 绕过', async () => {
  const f = makeFixture();
  await maybeAutoCapture(f.base);
  f.calls.length = 0;
  writeFileSync(f.txFile, 'x'.repeat(8000));
  const r = await maybeAutoCapture(f.base); // 距上次成功 < cooldownMs(5s)
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'cooldown');
  const r2 = await maybeAutoCapture({ ...f.base, force: true });
  assert.equal(r2.ran, true);
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: 无账本目录（非 force）→ no-ledger；force 允许（close 语义）', async () => {
  const f = makeFixture();
  const r = await maybeAutoCapture({ ...f.base, taskId: '20991231-noledger' });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'no-ledger');
  assert.equal(f.calls.length, 0);
  const r2 = await maybeAutoCapture({ ...f.base, taskId: '20991231-noledger', force: true });
  assert.equal(r2.ran, true);
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: 无转录 → no-transcript；策略关 → disabled（优先于一切）', async () => {
  const f = makeFixture();
  const r = await maybeAutoCapture({ ...f.base, sessionsRoot: path.join(f.memoHome, 'absent') });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'no-transcript');
  const off = { session: { ledger: { enabled: true, autoCapture: { enabled: false } } } };
  const r2 = await maybeAutoCapture({ ...f.base, policy: off, force: true });
  assert.equal(r2.ran, false);
  assert.equal(r2.reason, 'disabled');
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: 捕获失败 fail-closed（不抛错、记录 reason=error、更新 lastAttemptAt）', async () => {
  const f = makeFixture();
  const boom = async () => { const e = new Error('zstd broken'); e.code = 'E_TRANSCRIPT_UNAVAILABLE'; throw e; };
  const r = await maybeAutoCapture({ ...f.base, captureTaskImpl: boom });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'error');
  assert.equal(r.code, 'E_TRANSCRIPT_UNAVAILABLE');
  const st = readAutoCaptureState(f.memoHome, '20261114-2222-fix');
  assert.equal(st.lastAttemptAt, 1_000_000, '失败也记尝试时间（防抖）');
  assert.equal(st.lastSuccessAt, undefined, '成功时间未写');
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('decideAutoCapture: 无状态 → first-run；显式 unchanged/below-threshold 分支', () => {
  const f = makeFixture();
  const probe = { mtimeMs: 111, size: 500, sessionId: 's1' };
  const d1 = decideAutoCapture({ memoHome: f.memoHome, taskId: '20261114-2222-fix', state: null, probe, policy: BASE_POLICY, clock: { nowMs: () => 10_000 }, force: false });
  assert.equal(d1.ok, true);
  assert.equal(d1.reason, 'first-run');
  const d2 = decideAutoCapture({ memoHome: f.memoHome, taskId: '20261114-2222-fix', state: { mtimeMs: 111, size: 500, lastSuccessAt: 5_000 }, probe, policy: BASE_POLICY, clock: { nowMs: () => 10_000 }, force: false });
  assert.equal(d2.ok, false);
  assert.equal(d2.reason, 'unchanged');
  const d3 = decideAutoCapture({
    memoHome: f.memoHome, taskId: '20261114-2222-fix',
    state: { mtimeMs: 111, size: 400, lastSuccessAt: 4_000 },
    probe, policy: BASE_POLICY, clock: { nowMs: () => 10_000 }, force: false,
  });
  assert.equal(d3.ok, false);
  assert.equal(d3.reason, 'below-threshold');
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('路由：session scope + 候选工具才挂车；其他 scope/工具 → null', async () => {
  const f = makeFixture();
  assert.equal(isAutoCaptureCandidateTool('memory_write'), true);
  assert.equal(isAutoCaptureCandidateTool('memory_session_checkpoint'), true);
  assert.equal(isAutoCaptureCandidateTool('memory_scope'), false);
  assert.equal(AUTO_CAPTURE_TOOLS.has('memory_session_close'), false, 'close 不走挂车层（捕获在其 handler 内部执行）');

  // 路由测试显式注入 sessionId（不读 DSH_SESSION_ID，避免测试环境泄漏）
  const hit = await postToolAutoCapture({
    state: { scope: 'session:20261114-2222-fix' },
    toolName: 'memory_write',
    overrides: { ...f.base, sessionId: 'sess-1' },
  });
  assert.equal(hit?.ran, true, 'session scope + memory_write → 触发挂车捕获');

  const miss1 = await postToolAutoCapture({ state: { scope: 'repo:sedimem' }, toolName: 'memory_write', overrides: f.base });
  assert.equal(miss1, null, '非 session scope 不触发');
  const miss2 = await postToolAutoCapture({ state: { scope: 'session:20261114-2222-fix' }, toolName: 'memory_scope', overrides: f.base });
  assert.equal(miss2, null, '非候选工具不触发');
  // 连接级 scope 是分库、调用参数显式带 session scope → 仍触发（memory_write scope: 参数场景）
  const viaArgs = await postToolAutoCapture({
    state: { scope: 'repo:sedimem' },
    toolName: 'memory_write',
    args: { scope: 'session:20261114-2222-fix' },
    overrides: { ...f.base, sessionId: 'sess-1', force: true },
  });
  assert.equal(viaArgs?.ran, true, '参数 scope=session:* 优先于连接级 scope');
  // memory_session_* 的 --task 参数形态同样生效
  const viaTask = await postToolAutoCapture({
    state: { scope: 'repo:sedimem' },
    toolName: 'memory_session_status',
    args: { task: '20261114-2222-fix' },
    overrides: { ...f.base, sessionId: 'sess-1', force: true },
  });
  assert.equal(viaTask?.ran, true, '参数 task=<taskId> → session:<task>');
  // 参数给了非 session scope → 回退连接级（repo）→ 不触发
  const viaBadArgs = await postToolAutoCapture({
    state: { scope: 'repo:sedimem' },
    toolName: 'memory_write',
    args: { scope: 'repo:other' },
    overrides: f.base,
  });
  assert.equal(viaBadArgs, null, '非 session 参数 scope 回退连接级判定');
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('captureOnCloseEnabled 读取策略；disabled 时 close 捕获跳过', async () => {
  assert.equal(captureOnCloseEnabled(BASE_POLICY), true);
  const f = makeFixture();
  const off = { session: { ledger: { enabled: true, captureOnClose: false, autoCapture: { enabled: true } } } };
  const r = await maybeAutoCapture({ ...f.base, policy: off, force: true, captureOnClose: true });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'capture-on-close-disabled');
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('bind：meta.json.hostSessionId 优先于 cwd slug；cwd 不匹配时绑定仍命中', async () => {
  const { bindSession } = await import('../../src/session/ledger.js');
  const { readBoundSessionId } = await import('../../src/session/auto-capture.js');
  const f = makeFixture();
  // 转录 sess-9 挂在与 cwd 无关的 slug 目录下（模拟 server 进程 cwd 不是会话目录）
  const tx9 = path.join(f.sessionsRoot, 'unrelated-slug', 'sess-9', 'session.v4.jsonl.zstd');
  mkdirSync(path.dirname(tx9), { recursive: true });
  writeFileSync(tx9, 'y'.repeat(3000));
  const otherCwd = mkdtempSync(path.join(tmpdir(), 'sedimem-autocap-other-'));

  // ① 无绑定：cwd slug 与所有目录都不匹配 → no-transcript（fail-closed，不猜）
  const r0 = await maybeAutoCapture({ ...f.base, cwd: otherCwd, captureTaskImpl: f.base.captureTaskImpl });
  assert.equal(r0.ran, false);
  assert.equal(r0.reason, 'no-transcript');

  // ② 绑定后：按 hostSessionId 精确命中（cwd mismatch 无影响）
  bindSession({ memoHome: f.memoHome, taskId: '20261114-2222-fix', hostSessionId: 'sess-9' });
  assert.equal(readBoundSessionId(f.memoHome, '20261114-2222-fix'), 'sess-9');
  const r1 = await maybeAutoCapture({ ...f.base, cwd: otherCwd, captureTaskImpl: f.base.captureTaskImpl });
  assert.equal(r1.ran, true, '绑定 id 命中转录 → 捕获');
  assert.equal(f.calls.at(-1)?.taskId, '20261114-2222-fix');
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
  rmSync(otherCwd, { recursive: true, force: true });
});

test('bind：空串/缺失 meta/坏 JSON → readBoundSessionId 返回 null；bindSession 校验与 E_NOT_FOUND', async () => {
  const { bindSession } = await import('../../src/session/ledger.js');
  const { readBoundSessionId } = await import('../../src/session/auto-capture.js');
  const f = makeFixture();
  assert.equal(readBoundSessionId(f.memoHome, '20261114-2222-fix'), null, '无 meta → null');
  writeFileSync(path.join(f.memoHome, 'sessions', '20261114-2222-fix', 'meta.json'), 'not-json');
  assert.equal(readBoundSessionId(f.memoHome, '20261114-2222-fix'), null, '坏 meta → null');
  bindSession({ memoHome: f.memoHome, taskId: '20261114-2222-fix', hostSessionId: '  sess-x  ' });
  assert.equal(readBoundSessionId(f.memoHome, '20261114-2222-fix'), 'sess-x', 'trim 后写入');
  assert.throws(() => bindSession({ memoHome: f.memoHome, taskId: '20261114-2222-fix', hostSessionId: '  ' }), /E_INVALID_ARG|非空/);
  assert.throws(() => bindSession({ memoHome: f.memoHome, taskId: '99999999-absent', hostSessionId: 'a' }), /E_NOT_FOUND|不存在/);
  rmSync(f.memoHome, { recursive: true, force: true });
  rmSync(f.cwd, { recursive: true, force: true });
});

test('maybeAutoCapture: policy llmMode=llm → mode=llm + 注入 llmPort（用户要求 llm 录入）', async () => {
  const f = makeFixture();
  const fakePort = { ready: () => true, derive: async () => ({}) };
  const policy = JSON.parse(JSON.stringify(f.base.policy));
  policy.session.ledger.llmMode = 'llm';
  const r = await maybeAutoCapture({ ...f.base, policy, sessionId: 'sess-1', llmPort: fakePort });
  assert.equal(r.ran, true);
  assert.equal(f.calls[0].mode, 'llm', 'llmMode=llm 时自动捕获必须用 llm 模式');
  assert.equal(f.calls[0].llmPort, fakePort, 'ready 的 llmPort 必须透传 captureTask');
});

test('maybeAutoCapture: llmPort 未 ready → 不透传（captureTask 内部回落 rules，fail-closed）', async () => {
  const f = makeFixture();
  const policy = JSON.parse(JSON.stringify(f.base.policy));
  policy.session.ledger.llmMode = 'llm';
  const notReady = { ready: () => false };
  const r = await maybeAutoCapture({ ...f.base, policy, sessionId: 'sess-1', llmPort: notReady });
  assert.equal(r.ran, true);
  assert.equal(f.calls[0].mode, 'llm', 'mode 仍按 policy');
  assert.equal(f.calls[0].llmPort, undefined, '未就绪的 llmPort 不得透传');
});
