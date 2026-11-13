import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i1-duplicate.json'), 'utf8'),
);

test('I1 重复：同一事实 5 种措辞写 5 次，只留 1 条 active', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i1' });
    const actions = [];
    for (const text of CASE.texts) {
      const res = await svc.write({
        text,
        kind: 'fact',
        subject: CASE.subject,
        predicate: CASE.predicate,
        value: CASE.value,
        source: { agent: 'test' },
      });
      assert.ok(res && typeof res.action === 'string', '每次写操作必返回 action（hook 静默失败防线）');
      actions.push(res.action);
    }
    assert.equal(actions[0], 'created', `首写应为 created，实际 ${actions[0]}`);
    for (let i = 1; i < actions.length; i++) {
      assert.ok(
        actions[i] === 'noop_duplicate' || actions[i] === 'noop_same_value',
        `第 ${i + 1} 次写入 action 应为 noop_duplicate/noop_same_value，实际 ${actions[i]}`,
      );
    }

    const stats = await svc.stats();
    assert.equal(stats.active, 1, `stats.active 应为 1，实际 ${stats.active}`);

    const search = await svc.search(CASE.query);
    assert.equal(search.items.length, 1, `search 应只返回 1 条，实际 ${search.items.length}`);
    assert.equal(search.items[0].record.value, CASE.value);

    const brief = await svc.brief();
    const hitLines = brief.split('\n').filter((l) => l.includes(CASE.value));
    assert.equal(hitLines.length, 1, `brief 中该事实只出现 1 行，实际 ${hitLines.length} 行`);
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
