import { serviceFactory } from '../support/session-factory.js';
// tests/unit/session-handoff.test.js — 交接文档渲染/落盘 + session CLI close 幂等（v0.6 W2）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { createClock } from '../../src/core/clock.js';
import { startSession } from '../../src/session/lifecycle.js';
import { writeCheckpoint } from '../../src/session/checkpoint.js';
import { renderHandoff, writeHandoff } from '../../src/session/handoff.js';
import { sessionCli } from '../../src/cli/session.js';

const FIXED_MS = Date.parse('2026-11-13T10:30:00Z');
const clock = createClock({ now: FIXED_MS });

const CP = {
  intent: '实现会话临时库',
  concepts: [], files: ['src/session/lifecycle.js'],
  errorsAndFixes: ['并发写 → scope 锁'],
  pendingJobs: ['补 MCP 工具'],
  currentState: '数据层与 CLI 完成',
  nextSteps: ['跑全量测试'],
  criticalContext: '不自动建库',
};

/** 收集输出的 out 桩 */
function collector() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

async function fresh() {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-session-ho-'));
  const main = await createMemoryService({ memoHome, scope: 'repo:unit-session-ho', clock });
  const { scope } = await startSession({ service: main, serviceFactory, title: '交接测试', clock });
  const svc = await createMemoryService({ memoHome, scope, clock });
  return { main, svc, memoHome, scope };
}

describe('session/handoff', () => {
  test('renderHandoff：六节齐全，映射正确（决策/坑/文件/未完成/入口）', () => {
    const md = renderHandoff({
      sessionId: '20261113-1830-ab12',
      meta: { title: '交接测试', startedAt: clock.now(), repo: '/tmp/r' },
      checkpoint: CP,
      promoted: [
        { kind: 'decision', title: 'session 禁 fact' },
        { kind: 'gotcha', title: '端口占用先 kill' },
        { kind: 'fact', title: '不该出现在决策节' },
      ],
      pending: ['复盘会议'],
    });
    for (const sec of ['做了什么', '关键决策', '踩过的坑', '改了哪些文件', '未完成事项', '下次开工入口']) {
      assert.ok(md.includes(`## ${sec}`), `缺节: ${sec}`);
    }
    assert.ok(md.includes(CP.intent));
    assert.ok(md.includes('- session 禁 fact'));
    assert.ok(md.includes('- 端口占用先 kill'));
    assert.ok(!md.includes('不该出现在决策节')); // fact 不属于决策节
    assert.ok(md.includes('- src/session/lifecycle.js'));
    assert.ok(md.includes('- 补 MCP 工具'));
    assert.ok(md.includes('- 复盘会议'));
    assert.ok(md.includes('- 跑全量测试'));
    assert.ok(md.includes('关键上下文：不自动建库'));
    // sessionId 必填
    assert.throws(() => renderHandoff({}), (e) => e.code === 'E_INVALID_ARG');
  });

  test('renderHandoff：空 checkpoint 每节都有「（无）」占位，不崩', () => {
    const md = renderHandoff({ sessionId: 'x', promoted: [], pending: [] });
    const none = (md.match(/（无）/g) ?? []).length;
    assert.ok(none >= 4);
  });

  test('writeHandoff：写到 <memoHome>/handoffs/<id>.md（递归建目录，幂等覆盖）', () => {
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-session-ho2-'));
    try {
      const p = writeHandoff({ memoHome, sessionId: '20261113-1830-ab12', markdown: '# v1\n' });
      assert.equal(p, join(memoHome, 'handoffs', '20261113-1830-ab12.md'));
      assert.ok(existsSync(p));
      writeHandoff({ memoHome, sessionId: '20261113-1830-ab12', markdown: '# v2\n' });
      assert.equal(readFileSync(p, 'utf8'), '# v2\n');
      assert.throws(
        () => writeHandoff({ memoHome, sessionId: 'x', markdown: '' }),
        (e) => e.code === 'E_INVALID_ARG',
      );
    } finally {
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('sessionCli close：晋升白名单 + handoff md + tombstone 其余 + 幂等', async () => {
    const ctx = await fresh();
    const out = collector();
    try {
      // 期间记录：1 decision + 1 gotcha（晋升）、1 pref（不晋升）、1 checkpoint
      await ctx.svc.write({
        text: 'session 库禁 fact', title: 'session 禁 fact', kind: 'decision',
        subject: 'session', predicate: 'rule', value: 'no-fact', source: { agent: 'test' },
      });
      await ctx.svc.write({
        text: '端口占用先 kill', title: '端口占用先 kill', kind: 'gotcha',
        subject: 'dev', predicate: 'port', value: 'kill-first', source: { agent: 'test' },
      });
      await ctx.svc.write({
        text: '用户偏好中文注释', kind: 'pref',
        subject: 'style', predicate: 'lang', value: 'zh', source: { agent: 'test' },
      });
      await writeCheckpoint({ service: ctx.svc, checkpoint: CP, clock });
      // 主库先记一条已有记录，验证 close 后主库确实新增
      const before = ctx.main._records.size;

      const r1 = await sessionCli(['close', '--scope', ctx.scope, '--json'],
        { service: ctx.main, memoHome: ctx.memoHome, clock, out });
      assert.equal(r1.alreadyClosed, false);
      assert.equal(r1.promoted.length, 2);
      assert.ok(r1.promoted.every((p) => p.kind === 'decision' || p.kind === 'gotcha'));
      assert.ok(existsSync(r1.handoffPath));
      const md = readFileSync(r1.handoffPath, 'utf8');
      assert.ok(md.includes('## 下次开工入口'));
      assert.ok(md.includes('- 跑全量测试'));
      // 主库新增：2 晋升 + 1 handoff state = 3
      const after = ctx.main._records.size;
      assert.equal(after - before, 3);
      // 晋升的 decision/gotcha 带 from-session tag（handoff state 也带，但 kind 不同）
      const promotedTags = [...ctx.main._records.values()]
        .filter((r) => (r.kind === 'decision' || r.kind === 'gotcha')
          && Array.isArray(r.tags) && r.tags.includes(`from-session:${ctx.scope.slice(8)}`));
      assert.equal(promotedTags.length, 2);

      // 重复 close（人类可读输出）→ already-closed，不再写主库
      const r2 = await sessionCli(['close', '--scope', ctx.scope],
        { service: ctx.main, memoHome: ctx.memoHome, clock, out });
      assert.equal(r2.alreadyClosed, true);
      assert.equal(ctx.main._records.size, after);
      assert.ok(out.text().includes('已关闭'));
    } finally {
      await ctx.svc.close(); await ctx.main.close();
      rmSync(ctx.memoHome, { recursive: true, force: true });
    }
  });
});
