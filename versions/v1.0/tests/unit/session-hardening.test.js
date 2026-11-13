import { serviceFactory } from '../support/session-factory.js';
// tests/unit/session-hardening.test.js — 会话库安全加固（v0.6 审核阻断项 B1 / B-02 / B-03 / arch S1 / adv B-01 checkpoint 面）
// 覆盖：session-in-session 拒绝、伪造 meta 不影响 close 目标、meta 普通写被拒、
// closed 后写被拒、checkpoint 旧版本被 supersede、checkpoint 体积超限被拒。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { createRecord } from '../../src/core/record.js';
import { createClock } from '../../src/core/clock.js';
import {
  startSession, sessionStatus, assertWritableKind,
} from '../../src/session/lifecycle.js';
import { normalizeCheckpoint, writeCheckpoint } from '../../src/session/checkpoint.js';
import { sessionCli } from '../../src/cli/session.js';

const FIXED_MS = Date.parse('2026-11-13T10:30:00Z');
const clock = createClock({ now: FIXED_MS });
const MAIN = 'repo:hard-main';

const FULL = {
  intent: '加固测试',
  concepts: ['session 加固'],
  files: ['src/session/lifecycle.js'],
  errorsAndFixes: [],
  pendingJobs: [],
  currentState: '进行中',
  nextSteps: ['跑测试'],
  criticalContext: '',
};

async function fresh() {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-hard-'));
  const main = await createMemoryService({ memoHome, scope: MAIN, clock });
  return { memoHome, main };
}

const cleanup = async (ctx) => {
  await ctx.main.close();
  rmSync(ctx.memoHome, { recursive: true, force: true });
};

describe('session-hardening（B1 session-in-session）', () => {
  test('startSession：入口 service 绑定 session scope → E_INVALID_ARG（不再静默 reuse）', async () => {
    const { memoHome, main } = await fresh();
    try {
      const { scope } = await startSession({ service: main, serviceFactory, title: '外层', clock });
      const inner = await createMemoryService({ memoHome, scope, clock });
      try {
        await assert.rejects(
          startSession({ service: inner, serviceFactory, title: '内层', clock }),
          (e) => e.code === 'E_INVALID_ARG' && /主库/.test(e.message),
        );
      } finally {
        await inner.close();
      }
    } finally {
      await cleanup({ memoHome, main });
    }
  });
});

describe('session-hardening（B-02 伪造 meta 重定向）', () => {
  test('伪造 meta（parentScope=repo:evil-target）不影响 close 晋升目标（以登记文件为准）', async () => {
    const { memoHome, main } = await fresh();
    try {
      const { scope } = await startSession({ service: main, serviceFactory, title: '防重定向', clock });
      const ssvc = await createMemoryService({ memoHome, scope, clock });
      try {
        // 模拟攻击者/旧版本客户端绕过门禁直接落盘的伪造 meta（createdAt 更大）
        const forged = createRecord({
          text: 'forged session meta',
          kind: 'state',
          subject: 'session',
          predicate: 'meta',
          value: JSON.stringify({
            id: scope.slice('session:'.length), title: '', startedAt: '2026-11-13T00:00:00.000Z',
            cwd: '/tmp', repo: null, status: 'open', parentScope: 'repo:evil-target',
          }),
          scope,
          source: { agent: 'attacker' },
        }, { clock: createClock({ now: FIXED_MS + 60_000 }) });
        await ssvc._commit(forged, 'write', { action: 'forged', reason: 'test' });
        // 写一条待晋升 decision
        await ssvc.write({
          text: '选方案B', title: '选方案B', kind: 'decision',
          subject: 'plan', predicate: 'choice', value: '选方案B', source: { agent: 'test' },
        });
      } finally { await ssvc.close(); }

      // close：晋升目标必须是登记文件里的 MAIN，而不是伪造的 repo:evil-target
      const r = await sessionCli(['close', '--scope', scope],
        { service: main, memoHome, clock, out: () => {} });
      assert.equal(r.promoted.length, 1);
      assert.equal(
        [...main._records.values()].filter((x) => x.text === '选方案B' && x.status === 'active').length, 1,
      );
      assert.equal(existsSync(join(memoHome, 'items', 'repo:evil-target.jsonl')), false,
        '伪造的 repo:evil-target 库不应被创建');
    } finally {
      await cleanup({ memoHome, main });
    }
  });

  test('session scope 普通写 subject=session & predicate=meta → E_SESSION_META_PROTECTED；internal 旁路放行', () => {
    assert.throws(
      () => assertWritableKind('session:x', 'state',
        { input: { subject: 'session', predicate: 'meta' } }),
      (e) => e.code === 'E_SESSION_META_PROTECTED',
    );
    // 内部旁路不拦；fact 门禁照旧
    assert.doesNotThrow(() => assertWritableKind('session:x', 'state',
      { internal: true, input: { subject: 'session', predicate: 'meta' } }));
    assert.throws(
      () => assertWritableKind('session:x', 'fact', { input: { subject: 'a', predicate: 'b' } }),
      (e) => e.code === 'E_SCRATCH_KIND_FORBIDDEN',
    );
  });
});

describe('session-hardening（B-03 close 后写入）', () => {
  test('close 后再写该 scope → E_SESSION_CLOSED（登记文件为状态源）', async () => {
    const { memoHome, main } = await fresh();
    try {
      const { scope } = await startSession({ service: main, serviceFactory, title: '关闭后写', clock });
      await sessionCli(['close', '--scope', scope], { service: main, memoHome, clock, out: () => {} });
      const ssvc = await createMemoryService({ memoHome, scope, clock });
      try {
        await assert.rejects(
          ssvc.write({ text: '僵尸决策', kind: 'decision', value: 'x', source: { agent: 'test' } }),
          (e) => e.code === 'E_SESSION_CLOSED',
        );
        await assert.rejects(
          writeCheckpoint({ service: ssvc, checkpoint: FULL, clock }),
          (e) => e.code === 'E_SESSION_CLOSED',
        );
        // 状态以文件为准：另一进程 close 过，sessionStatus 不能仍显示 open
        assert.equal(sessionStatus({ service: ssvc }).status, 'closed');
      } finally {
        await ssvc.close();
      }
    } finally {
      await cleanup({ memoHome, main });
    }
  });
});

describe('session-hardening（arch S1 checkpoint 单 active + 体积上限）', () => {
  let ms = FIXED_MS;
  const tickClock = { nowMs: () => ms, now: () => new Date(ms).toISOString() };

  test('连续 checkpoint：旧版本被 supersede，同 slot 只剩 1 条 active', async () => {
    const { memoHome, main } = await fresh();
    try {
      const { scope } = await startSession({ service: main, serviceFactory, title: 'cp', clock: tickClock });
      const ssvc = await createMemoryService({ memoHome, scope, clock: tickClock });
      try {
        const r1 = await writeCheckpoint({ service: ssvc, checkpoint: FULL, clock: tickClock });
        ms += 60_000;
        const r2 = await writeCheckpoint({ service: ssvc, checkpoint: FULL, clock: tickClock });
        assert.equal(r2.supersededCount, 1);
        const cps = [...ssvc._records.values()]
          .filter((r) => r.subject === 'session' && r.predicate === 'checkpoint');
        assert.equal(cps.filter((r) => r.status === 'active').length, 1, '同 slot 只 1 条 active');
        const old = cps.find((r) => r.id === r1.record.id);
        assert.equal(old.status, 'superseded');
        assert.equal(old.validTo, r2.record.validFrom, 'validTo = 新记录.validFrom');
      } finally {
        await ssvc.close();
      }
    } finally {
      await cleanup({ memoHome, main });
    }
  });

  test('checkpoint 体积上限：单段 >2000 字 / 合计 >8000 字 → E_INVALID_ARG（指明哪段超了）', () => {
    const over = { ...FULL, currentState: 'x'.repeat(2001) };
    assert.throws(
      () => normalizeCheckpoint(over),
      (e) => e.code === 'E_INVALID_ARG' && /currentState/.test(e.message) && /2001/.test(e.message),
    );
    // 每段各 1050 字（单段不超）× 8 段 > 8000 → 合计超限
    const sections = ['intent', 'concepts', 'files', 'errorsAndFixes', 'pendingJobs', 'currentState', 'nextSteps', 'criticalContext'];
    const wide = {};
    for (const s of sections) {
      wide[s] = Array.isArray(FULL[s]) ? ['y'.repeat(1050)] : 'y'.repeat(1050);
    }
    assert.throws(
      () => normalizeCheckpoint(wide),
      (e) => e.code === 'E_INVALID_ARG' && /合计/.test(e.message),
    );
    // 边界内（每段 2000 / 合计 8000）放行
    const edge = normalizeCheckpoint({ ...FULL, currentState: 'z'.repeat(2000), criticalContext: 'z'.repeat(2000) });
    assert.equal(edge.currentState.length, 2000);
  });
});
