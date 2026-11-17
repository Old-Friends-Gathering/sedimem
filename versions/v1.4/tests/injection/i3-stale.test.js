import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i3-stale.json'), 'utf8'),
);

test('I3 过时：写入不可比较的矛盾旧结论 → disputed，默认 search 不可见', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i3' });

    const first = await svc.write({
      text: CASE.first.text, kind: 'fact',
      subject: CASE.subject, predicate: CASE.predicate, value: CASE.first.value,
      source: { agent: 'test' },
    });
    assert.equal(first.action, 'created');

    const second = await svc.write({
      text: CASE.second.text, kind: 'fact',
      subject: CASE.subject, predicate: CASE.predicate, value: CASE.second.value,
      source: { agent: 'test' },
    });
    assert.equal(second.action, 'disputed', `矛盾且值不可比较 → action 应为 disputed，实际 ${second.action}`);

    const stats = await svc.stats();
    assert.ok(stats.disputed >= 1, `stats.disputed 应 >=1，实际 ${stats.disputed}`);

    const def = await svc.search(CASE.query);
    for (const it of def.items) {
      assert.notEqual(it.record.status, 'disputed', '默认 search 不应返回 disputed 条目');
    }
    // includeDisputed=true 时才可见（公开参数，仍走公开 API）
    const withDisputed = await svc.search(CASE.query, { includeDisputed: true });
    assert.ok(
      withDisputed.items.some((it) => it.record.status === 'disputed'),
      'includeDisputed=true 应能看到 disputed 条目',
    );
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
