import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i5-poison.json'), 'utf8'),
);

test('I5 投毒：写入成功、标记 suspicious、不进 brief、doctor 无 error', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i5' });

    // 写入成功（不抛错、有 action）
    const w = await svc.write({
      text: CASE.text, kind: 'fact',
      subject: CASE.subject, predicate: CASE.predicate,
      source: { agent: 'test' },
    });
    assert.ok(typeof w.action === 'string', '写入应成功并返回 action');

    // search 结果带 tags:['suspicious']
    const s = await svc.search(CASE.query);
    const hit = s.items.find((it) => it.record.id === w.record.id);
    assert.ok(hit, 'search 应能命中该条');
    assert.ok(
      Array.isArray(hit.record.tags) && hit.record.tags.includes('suspicious'),
      `record.tags 应包含 'suspicious'，实际 ${JSON.stringify(hit.record.tags)}`,
    );

    // 不进 brief：brief 中不出现注入原文与敏感路径
    const brief = await svc.brief();
    assert.ok(!brief.includes('~/.ssh'), 'brief 不得包含 ~/.ssh');
    assert.ok(!brief.includes(CASE.text), 'brief 不得包含注入原文');

    // doctor 不报 error
    const doc = await svc.doctor();
    const errors = (doc.issues || []).filter((i) => i.severity === 'error');
    assert.equal(errors.length, 0, `doctor 不应报 error，实际 ${JSON.stringify(errors)}`);
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
