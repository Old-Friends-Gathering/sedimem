import { serviceFactory } from '../support/session-factory.js';
// tests/unit/session-close-promote.test.js — close 双 service 晋升契约（v0.6 修复）
// 场景：入口 service 因 MEMO_SCOPE 被切到 session 库时，close 仍必须把 decision/gotcha
// 晋升到 meta.parentScope 指向的主库，而不是落回 session 库再被 tombstone。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { createClock } from '../../src/core/clock.js';
import { startSession, sessionStatus } from '../../src/session/lifecycle.js';
import { sessionCli } from '../../src/cli/session.js';

const FIXED_MS = Date.parse('2026-11-13T10:30:00Z');
const clock = createClock({ now: FIXED_MS });
const MAIN_SCOPE = 'repo:unit-close-main';

// 端到端夹具：start（主库 service）→ 写 2 条 decision/gotcha → 返回 session scope
async function seedSession() {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-close-'));
  const main = await createMemoryService({ memoHome, scope: MAIN_SCOPE, clock });
  const { scope } = await startSession({ service: main, serviceFactory, title: '晋升测试', clock });
  const ssvc = await createMemoryService({ memoHome, scope, clock });
  await ssvc.write({
    text: '晋升目标走 meta.parentScope', title: '晋升走主库',
    kind: 'decision', subject: 'arch', predicate: 'promote',
    value: 'parent-scope', source: { agent: 'test' },
  });
  await ssvc.write({
    text: 'close 剩余记录要 tombstone', title: '关闭即弃',
    kind: 'gotcha', subject: 'session', predicate: 'close',
    value: 'tombstone-rest', source: { agent: 'test' },
  });
  await ssvc.close();
  return { memoHome, main, scope };
}

describe('session close 晋升（双 service）', () => {
  test('晋升记录真的进主库 scope（入口 service 即使绑 session 库也不落错）', async () => {
    const { memoHome, main, scope } = await seedSession();
    try {
      // 复现缺陷场景：入口 service 被切到 session scope（如 MEMO_SCOPE=<session>）
      const entryOnSession = await createMemoryService({ memoHome, scope, clock });
      try {
        const res = await sessionCli(['close', '--scope', scope, '--json'],
          { service: entryOnSession, memoHome, clock, out: () => {} });
        assert.equal(res.alreadyClosed, false);
        assert.equal(res.promoted.length, 2);
      } finally {
        await entryOnSession.close();
      }
      // 主库命中 2 条晋升记录（含 from-session 标签）；重开主库服务读最新真相层
      await main.close();
      const main2 = await createMemoryService({ memoHome, scope: MAIN_SCOPE, clock });
      try {
        const promotedInMain = [...main2._records.values()].filter(
          (r) => r.status === 'active' && (r.tags ?? []).includes(`from-session:${scope.slice('session:'.length)}`),
        );
        assert.equal(promotedInMain.length, 2, `主库应有 2 条晋升记录，实际 ${promotedInMain.length}`);
        assert.ok(promotedInMain.every((r) => r.scope === MAIN_SCOPE));
      } finally { await main2.close(); }
      // session 库不应残留任何 active 的 decision/gotcha
      const ssvc = await createMemoryService({ memoHome, scope, clock });
      try {
        const active = [...ssvc._records.values()].filter((r) => r.status === 'active');
        assert.equal(active.filter((r) => r.kind === 'decision' || r.kind === 'gotcha').length, 0);
      } finally { await ssvc.close(); }
    } finally {
      // main 已在断言前关闭（重开 main2 读最新真相层），这里只兜底清理目录
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('session 库剩余记录 tombstoned（只留 closed meta）', async () => {
    const { memoHome, main, scope } = await seedSession();
    try {
      await sessionCli(['close', '--scope', scope],
        { service: main, memoHome, clock, out: () => {} });
      const ssvc = await createMemoryService({ memoHome, scope, clock });
      try {
        const active = [...ssvc._records.values()].filter((r) => r.status === 'active');
        assert.equal(active.length, 1, '只剩 closed meta 一条 active');
        assert.equal(active[0].subject, 'session');
        assert.equal(active[0].predicate, 'meta');
      } finally { await ssvc.close(); }
    } finally {
      await main.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('重复 close 幂等：already-closed 且主库不重复晋升', async () => {
    const { memoHome, main, scope } = await seedSession();
    try {
      await sessionCli(['close', '--scope', scope],
        { service: main, memoHome, clock, out: () => {} });
      const again = await sessionCli(['close', '--scope', scope, '--json'],
        { service: main, memoHome, clock, out: () => {} });
      assert.equal(again.alreadyClosed, true);
      // 主库仍只有首次晋升的 2 条（第二次 close 不重复晋升）
      const promotedInMain = [...main._records.values()].filter(
        (r) => (r.tags ?? []).includes(`from-session:${scope.slice('session:'.length)}`),
      );
      assert.equal(promotedInMain.length, 2);
    } finally {
      await main.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('close 后 meta status=closed（且 parentScope 保留）', async () => {
    const { memoHome, main, scope } = await seedSession();
    try {
      await sessionCli(['close', '--scope', scope],
        { service: main, memoHome, clock, out: () => {} });
      const ssvc = await createMemoryService({ memoHome, scope, clock });
      try {
        // closed meta 走同 slot 新值（supersede/disputed 版本链），用 sessionStatus 取最新版本
        const st = sessionStatus({ service: ssvc });
        assert.equal(st.status, 'closed');
        assert.ok(st.meta.closedAt);
        assert.equal(st.meta.parentScope, MAIN_SCOPE);
      } finally { await ssvc.close(); }
    } finally {
      await main.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('start 把 parentScope 记进 meta 并随返回值透出', async () => {
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-close-'));
    const main = await createMemoryService({ memoHome, scope: MAIN_SCOPE, clock });
    try {
      const r = await startSession({ service: main, serviceFactory, title: 't', clock });
      assert.equal(r.parentScope, MAIN_SCOPE);
      assert.equal(r.meta.parentScope, MAIN_SCOPE);
    } finally {
      await main.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
