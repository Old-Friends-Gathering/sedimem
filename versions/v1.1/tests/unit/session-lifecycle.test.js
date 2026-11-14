import { serviceFactory } from '../support/session-factory.js';
// tests/unit/session-lifecycle.test.js — 会话临时库生命周期（v0.6 W2）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { createClock } from '../../src/core/clock.js';
import {
  SESSION_PREFIX, createSessionId, isSessionScope, assertWritableKind,
  startSession, sessionStatus, sweepSessions, writeSessionRegistry,
} from '../../src/session/lifecycle.js';

// 固定时钟：2026-11-13T10:30 UTC
const FIXED_MS = Date.parse('2026-11-13T10:30:00Z');
const clock = createClock({ now: FIXED_MS });

async function fresh(over = {}) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-session-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:unit-session', clock, ...over });
  return { svc, memoHome };
}

describe('session/lifecycle', () => {
  test('createSessionId：YYYYMMDD-HHmm-4hex（本地时间 + crypto 随机后缀）', () => {
    const id = createSessionId(clock);
    // 用本地时间字段拼出期望前缀（与实现同一规则）
    const d = new Date(FIXED_MS);
    const p2 = (n) => String(n).padStart(2, '0');
    const prefix = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    assert.match(id, new RegExp(`^${prefix}-[0-9a-f]{4}$`));
    // 随机后缀：两次调用不同
    assert.notEqual(id, createSessionId(clock));
  });

  test('isSessionScope / assertWritableKind：session 下禁 fact → E_SCRATCH_KIND_FORBIDDEN', () => {
    assert.equal(isSessionScope('session:20260101-0000-ab12'), true);
    assert.equal(isSessionScope('repo:x'), false);
    assert.equal(isSessionScope('session:'), false);
    assert.equal(isSessionScope(''), false);
    // 主库 scope 不拦 fact
    assert.doesNotThrow(() => assertWritableKind('repo:x', 'fact'));
    assert.doesNotThrow(() => assertWritableKind('session:a', 'decision'));
    assert.throws(
      () => assertWritableKind('session:a', 'fact'),
      (e) => e.code === 'E_SCRATCH_KIND_FORBIDDEN',
    );
  });

  test('startSession：写 meta（state/session/meta），返回 {scope, meta}；sessionStatus 计数正确', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const { scope, meta } = await startSession({ service: svc, serviceFactory, title: '修登录', repo: '/tmp/r', clock });
      assert.ok(scope.startsWith(SESSION_PREFIX));
      assert.equal(meta.id, scope.slice(SESSION_PREFIX.length));
      assert.equal(meta.status, 'open');
      assert.equal(meta.title, '修登录');
      assert.equal(meta.repo, '/tmp/r');
      assert.equal(meta.startedAt, clock.now());

      // 用 session-scoped 服务读回校验
      const ssvc = await createMemoryService({ memoHome, scope, clock });
      try {
        const st = sessionStatus({ service: ssvc });
        assert.equal(st.status, 'open');
        assert.equal(st.checkpoints, 0);
        assert.equal(st.facts, 0);
        // session 下写一条 gotcha（允许）再查 facts
        await ssvc.write({
          text: 'dev server 端口被占用时要先 kill', title: '端口冲突先 kill',
          kind: 'gotcha', subject: 'dev', predicate: 'port',
          value: 'kill-first', source: { agent: 'test' },
        });
        assert.equal(sessionStatus({ service: ssvc }).facts, 1);
        // session 下写 fact 被数据层门禁拦（不走 CLI 也拦得住）
        assert.throws(
          () => assertWritableKind(ssvc.scope, 'fact'),
          (e) => e.code === 'E_SCRATCH_KIND_FORBIDDEN',
        );
      } finally {
        await ssvc.close();
      }
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('sessionStatus：非 session scope → E_INVALID_ARG', async () => {
    const { svc, memoHome } = await fresh();
    try {
      assert.throws(() => sessionStatus({ service: svc }), (e) => e.code === 'E_INVALID_ARG');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('sweepSessions：只报告候选 open+过期 session，不改不删', async () => {
    const { svc, memoHome } = await fresh();
    try {
      // 一个「老」的 open session（startedAt 早于阈值）
      const oldClock = createClock({ now: FIXED_MS - 20 * 86_400_000 });
      const old = await startSession({ service: svc, serviceFactory, title: '老会话', clock: oldClock });
      // 一个刚开的 open session（不该命中）
      const freshSession = await startSession({ service: svc, serviceFactory, title: '新会话', clock });
      // closed 的老 session（不该命中）：置 closed 走登记文件（B-02 后状态真相源；
      // 记忆流里的 meta 普通写入已被 E_SESSION_META_PROTECTED 禁止）
      const closed = await startSession({ service: svc, serviceFactory, title: '已关', clock: oldClock });
      writeSessionRegistry(memoHome, closed.scope,
        { ...closed.meta, status: 'closed' });

      const result = sweepSessions({
        memoHome, olderThanMs: 14 * 86_400_000, clock,
      });
      assert.equal(result.scanned, 3);
      const scopes = result.candidates.map((c) => c.scope);
      assert.ok(scopes.includes(old.scope));
      assert.ok(!scopes.includes(freshSession.scope));
      assert.ok(!scopes.includes(closed.scope));
      const cand = result.candidates.find((c) => c.scope === old.scope);
      assert.equal(cand.title, '老会话');
      assert.ok(cand.ageMs >= 20 * 86_400_000);
      // 只报告不改：再扫一遍结果一致，items 文件数不变
      const again = sweepSessions({ memoHome, olderThanMs: 14 * 86_400_000, clock });
      assert.deepEqual(again.candidates.map((c) => c.scope), scopes);
      // 非法阈值 → E_INVALID_ARG
      assert.throws(() => sweepSessions({ memoHome, olderThanMs: 0, clock }), (e) => e.code === 'E_INVALID_ARG');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
