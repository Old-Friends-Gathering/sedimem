// I45 — 会话临时库接 LLM 的自动 checkpoint（W4）
// 钉住：LLM 就绪 → mode='llm' 且 8 段齐全（files/nextSteps 非空）；
// ready:false → mode='fallback' 且 8 段仍齐全；
// autoCheckpoint 只写 session 库——主库 items 文件 sha256 调用前后不变。
// 全程用 mkdtemp 临时目录，不碰 ~/.memo。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMemoryService } from '../../src/api/service.js';
import { startSession } from '../../src/session/lifecycle.js';
import { serviceFactory as makeService } from '../support/session-factory.js';
import { CHECKPOINT_SECTIONS } from '../../src/session/checkpoint.js';
import { autoCheckpoint } from '../../src/session/checkpoint-llm.js';
import { toTurns, compactTranscript } from '../../src/session/transcript.js';

// LLM 返回的合法 8 段 JSON（含代码围栏，验证围栏容忍）
const GOOD_JSON = [
  '```json',
  JSON.stringify({
    intent: '把会话临时库接上 LLM',
    concepts: ['session', 'checkpoint', 'llm-port'],
    files: ['src/session/checkpoint-llm.js', 'src/session/transcript.js'],
    errorsAndFixes: ['zstdDecompressSync 缺失时抛 E_TRANSCRIPT_UNAVAILABLE'],
    pendingJobs: ['冒烟 CLI'],
    currentState: '模块已写完，测试进行中',
    nextSteps: ['跑 node --test 全量回归'],
    criticalContext: '零依赖，Node >= 22',
  }),
  '```',
].join('\n');

const goodPort = () => ({
  ready: true,
  model: 'fake',
  complete: async () => ({ ok: true, text: GOOD_JSON, usage: { inTokens: 10, outTokens: 10 } }),
});

async function setup() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i45-'));
  const main = await createMemoryService({ memoHome: home, scope: 'repo:i45', cwd: home });
  const started = await startSession({ service: main, serviceFactory: makeService, clock: main.clock });
  const session = await createMemoryService({ memoHome: home, scope: started.scope, cwd: home });
  return { home, main, session, scope: started.scope };
}

/** 主库 items 文件的 sha256（不存在按空字符串算） */
async function mainItemsSha(home) {
  const dir = path.join(home, 'items');
  const names = await fsp.readdir(dir).catch(() => []);
  const file = names.find((n) => n.startsWith('repo_i45') || n.includes('i45'));
  if (!file) return createHash('sha256').update('').digest('hex');
  const raw = await fsp.readFile(path.join(dir, file));
  return createHash('sha256').update(raw).digest('hex');
}

const TURNS = [
  { role: 'user', text: '任务：实现 src/session/checkpoint-llm.js，修复 E_TRANSCRIPT_UNAVAILABLE 分支。接下来: 跑测试。' },
  { role: 'assistant', text: '已完成模块编写，修改了 src/session/transcript.js。' },
];

test('I45 LLM 就绪：mode=llm，8 段齐全，files/nextSteps 非空，带 cost', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.main.close(); await ctx.session.close(); });
  const res = await autoCheckpoint({
    service: ctx.session, turns: TURNS, llmPort: goodPort(),
    price: { inPerM: 0.8, outPerM: 2.8 },
  });
  assert.equal(res.mode, 'llm');
  for (const k of CHECKPOINT_SECTIONS) assert.ok(k in res.checkpoint, `缺段 ${k}`);
  assert.ok(res.checkpoint.files.length > 0, 'files 非空');
  assert.ok(res.checkpoint.nextSteps.length > 0, 'nextSteps 非空');
  assert.ok(res.cost && Number.isFinite(res.cost.estimatedCny), 'cost.estimatedCny 应为有限数');
  assert.ok(res.cost.inputChars > 0 && res.cost.outputChars > 0);
  // 落盘验证：session 库里能搜到 checkpoint 记录
  const all = await ctx.session.exportRecords({ status: 'all' });
  const list = Array.isArray(all) ? all : (all?.records ?? all?.items ?? []);
  assert.ok(list.some((r) => r.subject === 'session' && r.predicate === 'checkpoint'), 'checkpoint 已落 session 库');
});

test('I45 ready:false：mode=fallback，reason 有值，8 段仍齐全，规则抽出 files/nextSteps', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.main.close(); await ctx.session.close(); });
  const res = await autoCheckpoint({
    service: ctx.session, turns: TURNS,
    llmPort: { ready: false, complete: async () => ({ ok: false, error: { code: 'E_LLM_UNAVAILABLE', message: 'none' } }) },
  });
  assert.equal(res.mode, 'fallback');
  assert.ok(res.reason, 'fallback 应带 reason');
  for (const k of CHECKPOINT_SECTIONS) assert.ok(k in res.checkpoint, `缺段 ${k}`);
  assert.ok(res.checkpoint.files.some((f) => f.includes('checkpoint-llm.js')), '规则应抽出文件路径');
  assert.ok(res.checkpoint.nextSteps.length > 0, '规则应抽出「接下来:」句子');
});

test('I45 LLM 输出坏 JSON 也回落 fallback，8 段齐全', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.main.close(); await ctx.session.close(); });
  const res = await autoCheckpoint({
    service: ctx.session, turns: TURNS,
    llmPort: { ready: true, complete: async () => ({ ok: true, text: '抱歉我无法输出 JSON' }) },
  });
  assert.equal(res.mode, 'fallback');
  for (const k of CHECKPOINT_SECTIONS) assert.ok(k in res.checkpoint);
});

test('I45 主库 items 文件 sha256 调用前后不变', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.main.close(); await ctx.session.close(); });
  const before = await mainItemsSha(ctx.home);
  await autoCheckpoint({ service: ctx.session, turns: TURNS, llmPort: goodPort() });
  const after = await mainItemsSha(ctx.home);
  assert.equal(after, before, '主库 items 不应被 autoCheckpoint 触碰');
});

test('I45 transcript.js：toTurns 兼容多形状 + compactTranscript 超限保留头尾', async (t) => {
  // user_message 形状
  const a = toTurns([{ type: 'user_message', message: '你好', ts: '2026-01-01T00:00:00Z' }]);
  assert.equal(a.turns[0].role, 'user');
  // response_item 形状（payload.content 数组）
  const b = toTurns([{
    type: 'response_item',
    payload: { role: 'assistant', content: [{ type: 'output_text', text: '回答' }] },
  }]);
  assert.equal(b.turns[0].role, 'assistant');
  assert.equal(b.turns[0].text, '回答');
  // 坏记录跳过
  assert.equal(toTurns([null, {}, 'x']).turns.length, 0);
  // compact：超限出现省略说明，且包含头尾内容
  const big = Array.from({ length: 2000 }, (_, i) => ({ role: 'user', text: `行${i} ` + 'x'.repeat(50) }));
  const out = compactTranscript(big, { maxChars: 3000 });
  assert.ok(out.length <= 3200, '压缩后不应明显超限');
  assert.match(out, /中间省略/);
  assert.ok(out.includes('行0'), '应保留头部');
  assert.ok(out.includes(`行${big.length - 1}`), '应保留尾部');
});
