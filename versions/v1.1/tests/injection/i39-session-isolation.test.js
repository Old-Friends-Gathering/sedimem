import { serviceFactory } from '../support/session-factory.js';
// I39 — 会话库与主库的隔离（v0.6 W2 / 计划 §2.1）
// 钉三件事：① session 库禁止 fact；② session 记录不污染主库 brief/search；③ 主库记录不进 session brief。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { startSession } from '../../src/session/lifecycle.js';

const SRC = { agent: 'test' };

test('I39 会话库隔离：fact 被拒 + 双向不串库', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i39-'));
  const main = await createMemoryService({ memoHome: home, scope: 'repo:i39', cwd: home });
  try {
    await main.write({ text: '主库既有事实 alpha', title: '主库 alpha', kind: 'fact', subject: 'main', predicate: 'alpha', value: 'A', source: SRC });

    const { scope } = await startSession({ service: main, serviceFactory, title: 'i39 会话', clock: main.clock });
    const scratch = await createMemoryService({ memoHome: home, scope, cwd: home });
    try {
      // ① fact 被拒
      await assert.rejects(
        () => scratch.write({ text: '临时库里的事实', title: '事实', kind: 'fact', subject: 'scratch', predicate: 'f', value: 'v', source: SRC }),
        (e) => e.code === 'E_SCRATCH_KIND_FORBIDDEN',
        'session 库必须拒绝 fact',
      );

      await scratch.write({ text: '临时决策 beta', title: '临时 beta', kind: 'decision', subject: 'scratch', predicate: 'beta', value: 'B', source: SRC });

      // ② 主库看不到临时库内容
      await main.refreshView();
      const mainBrief = await main.brief({});
      assert.ok(!mainBrief.includes('临时决策 beta'), '主库 brief 不得包含临时库记录');
      const mainHits = await main.search('临时决策', { limit: 10 });
      assert.equal(mainHits.items.filter((h) => h.record.subject === 'scratch').length, 0, '主库 search 不得命中临时库');

      // ③ 临时库 brief 不含主库记录
      const scratchBrief = await scratch.brief({});
      assert.ok(!scratchBrief.includes('主库既有事实'), '临时库 brief 不得包含主库记录');
    } finally {
      await scratch.close();
    }
  } finally {
    await main.close();
  }
});
