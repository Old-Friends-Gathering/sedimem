// I38 — 会话临时库全生命周期（v0.6 W2）
// 钉四件事：创建 → 记决策/坑 → checkpoint → close 晋升到主库 + 写交接文档 + 幂等。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { startSession } from '../../src/session/lifecycle.js';
import { writeCheckpoint, normalizeCheckpoint } from '../../src/session/checkpoint.js';
import { sessionCli } from '../../src/cli/session.js';

const SRC = { agent: 'test' };

test('I38 会话库：创建 → 记录 → checkpoint → close 晋升', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i38-'));
  const main = await createMemoryService({ memoHome: home, scope: 'repo:i38', cwd: home });
  try {
    const { scope, meta } = await startSession({ service: main, title: 'i38 会话', clock: main.clock });
    assert.match(scope, /^session:/);
    assert.equal(meta.status, 'open');
    assert.equal(meta.parentScope, 'repo:i38', 'meta 必须记住主库 scope，close 才能晋升回去');

    const sessionSvc = await createMemoryService({ memoHome: home, scope, cwd: home });
    try {
      await sessionSvc.write({ text: '用 JSONL 做真相层', title: '选型 JSONL', kind: 'decision', subject: 'demo', predicate: 'choice', value: 'JSONL', source: SRC });
      await sessionSvc.write({ text: 'crontab 在 macOS 被 TCC 拦', title: '坑：crontab', kind: 'gotcha', subject: 'demo', predicate: 'pitfall', value: 'TCC', source: SRC });
      const cp = normalizeCheckpoint({
        intent: '验证会话库', concepts: ['会话'], files: ['src/session/lifecycle.js'],
        errorsAndFixes: ['x→y'], pendingJobs: ['跑 eval'], currentState: '数据层完成',
        nextSteps: ['接 MCP'], criticalContext: '零依赖',
      });
      const cpRes = await writeCheckpoint({ service: sessionSvc, checkpoint: cp });
      assert.equal(cpRes.action, 'created');
      assert.equal(cpRes.record.kind, 'state');

      const closed = await sessionCli(['close', '--scope', scope, '--json'], {
        service: sessionSvc, memoHome: home, clock: main.clock, out: () => {},
      });
      assert.equal(closed.promoted.length, 2, '应晋升 2 条（decision + gotcha）');
      const md = await fsp.readFile(closed.handoffPath, 'utf8');
      for (const sect of ['做了什么', '关键决策', '踩过的坑', '改了哪些文件', '未完成事项', '下次开工入口']) {
        assert.ok(md.includes(sect), `交接文档缺章节：${sect}`);
      }

      // 幂等
      const again = await sessionCli(['close', '--scope', scope, '--json'], {
        service: sessionSvc, memoHome: home, clock: main.clock, out: () => {},
      });
      assert.equal(again.alreadyClosed, true, '重复 close 必须幂等');

      // 主库能看到晋升记录，且带 from-session 标签
      // 晋升由另一个 service 实例写入，主库实例必须先刷新再查（v0.2 refreshView）
      await main.refreshView();
      const hits = await main.search('JSONL', { limit: 10 });
      const promoted = hits.items.filter((h) => h.record.kind === 'decision');
      assert.ok(promoted.length >= 1, '主库应能搜到晋升出来的决策');
      assert.ok((promoted[0].record.tags ?? []).some((t) => t.startsWith('from-session:')), '晋升记录应带 from-session 标签');
    } finally {
      await sessionSvc.close();
    }
  } finally {
    await main.close();
  }
});
