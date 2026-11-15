import { serviceFactory } from '../support/session-factory.js';
// tests/unit/session-checkpoint.test.js — 8 段 checkpoint 模板 / DSH 摘要解析 / 落盘（v0.6 W2）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { startSession } from '../../src/session/lifecycle.js';
import {
  CHECKPOINT_SECTIONS, normalizeCheckpoint, parseDshSummary, writeCheckpoint,
} from '../../src/session/checkpoint.js';

const FIXED_MS = Date.parse('2026-11-13T10:30:00Z');

// 时钟：两次调用推进 1 分钟，保证 checkpoint 的 recordedAt 不同（可追加多条）
let ms = FIXED_MS;
const clock = { nowMs: () => ms, now: () => new Date(ms).toISOString() };

const FULL = {
  intent: '实现会话临时库',
  concepts: ['scope 隔离', '晋升白名单'],
  files: ['src/session/lifecycle.js'],
  errorsAndFixes: ['JSONL 并发写 → scope 锁'],
  pendingJobs: ['补 MCP 工具'],
  currentState: '数据层完成',
  nextSteps: ['跑全量测试'],
  criticalContext: '不自动建库是硬约束',
};

async function freshSession() {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-session-cp-'));
  const main = await createMemoryService({ memoHome, scope: 'repo:unit-session-cp', clock });
  const { scope } = await startSession({ service: main, serviceFactory, title: 'cp', clock });
  const svc = await createMemoryService({ memoHome, scope, clock });
  return { main, svc, memoHome, scope };
}

describe('session/checkpoint', () => {
  test('CHECKPOINT_SECTIONS 冻结 8 段；normalizeCheckpoint 通过合法输入', () => {
    assert.equal(CHECKPOINT_SECTIONS.length, 8);
    const out = normalizeCheckpoint(FULL);
    assert.deepEqual(out, FULL);
    // 缺段 → 留空/空数组补齐（新对象，不改入参）
    const partial = normalizeCheckpoint({ intent: 'x' });
    assert.equal(partial.intent, 'x');
    assert.deepEqual(partial.concepts, []);
    assert.equal(partial.currentState, '');
  });

  test('normalizeCheckpoint：段类型错误 → E_INVALID_ARG', () => {
    assert.throws(
      () => normalizeCheckpoint({ concepts: '不是数组' }),
      (e) => e.code === 'E_INVALID_ARG' && /concepts/.test(e.message),
    );
    assert.throws(
      () => normalizeCheckpoint({ intent: 42 }),
      (e) => e.code === 'E_INVALID_ARG' && /intent/.test(e.message),
    );
    assert.throws(() => normalizeCheckpoint(null), (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => normalizeCheckpoint('str'), (e) => e.code === 'E_INVALID_ARG');
  });

  test('parseDshSummary：抽 compactionId/summary/shadowedTokenCount，拼 currentState，缺字段不编造', () => {
    const payload = {
      compactionId: 'cp-1',
      shadowedTokenCount: 12345,
      summary: [
        { type: 'text', text: '完成了数据层。' },
        { type: 'tool_use', name: 'bash' }, // 非 text 块跳过
        { type: 'text', text: 'CLI 已接好。' },
      ],
    };
    const { checkpoint, dsh } = parseDshSummary(payload);
    assert.equal(dsh.compactionId, 'cp-1');
    assert.equal(dsh.shadowedTokenCount, 12345);
    assert.equal(checkpoint.currentState, '完成了数据层。\n\nCLI 已接好。');
    // intent/concepts 等摘要里没有的字段留空，不编造
    assert.equal(checkpoint.intent, '');
    assert.deepEqual(checkpoint.concepts, []);
    // JSON 字符串入参也可；缺 compactionId → null 而不是抛
    const { dsh: d2, checkpoint: c2 } = parseDshSummary(JSON.stringify({ summary: [] }));
    assert.equal(d2.compactionId, null);
    assert.equal(d2.shadowedTokenCount, null);
    assert.equal(c2.currentState, '');
    // 坏 JSON → E_INVALID_ARG
    assert.throws(() => parseDshSummary('{oops'), (e) => e.code === 'E_INVALID_ARG');
  });

  test('writeCheckpoint：追加 state/session/checkpoint 记录；同内容可连续追加新版本', async () => {
    const ctx = await freshSession();
    try {
      const r1 = await writeCheckpoint({ service: ctx.svc, checkpoint: FULL, clock });
      assert.equal(r1.action, 'created');
      assert.equal(r1.record.predicate, 'checkpoint');
      assert.equal(r1.record.kind, 'state');
      const v = JSON.parse(r1.record.value);
      assert.equal(v.intent, FULL.intent);
      assert.equal(v.recordedAt, clock.now());

      ms += 60_000; // 时间推进，recordedAt 变化 → 内容不同，可追加第二条
      const r2 = await writeCheckpoint({ service: ctx.svc, checkpoint: FULL, clock });
      assert.equal(r2.action, 'created');
      assert.notEqual(r2.record.id, r1.record.id);
    } finally {
      await ctx.svc.close(); await ctx.main.close();
      rmSync(ctx.memoHome, { recursive: true, force: true });
    }
  });

  test('writeCheckpoint：非 session scope / scope 不一致 → E_INVALID_ARG', async () => {
    const ctx = await freshSession();
    try {
      await assert.rejects(
        writeCheckpoint({ service: ctx.main, checkpoint: FULL, clock }),
        (e) => e.code === 'E_INVALID_ARG',
      );
      await assert.rejects(
        writeCheckpoint({ service: ctx.svc, scope: 'session:other', checkpoint: FULL, clock }),
        (e) => e.code === 'E_INVALID_ARG',
      );
    } finally {
      await ctx.svc.close(); await ctx.main.close();
      rmSync(ctx.memoHome, { recursive: true, force: true });
    }
  });
});
