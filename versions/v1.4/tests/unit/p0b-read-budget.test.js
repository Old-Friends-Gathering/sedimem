// p0b B6.2：检索读预算——单条片段 ≤200 字、默认 ≤20 条、每会话条数/字节上限；
// 超限截断并显式标记（不允许「悄悄少给」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { clipSnippet, SNIPPET_CHARS_DEFAULT, resetReadBudget } from '../../src/api/search-path.js';

const SCOPE = 'repo:p0b-budget';
const TAIL = '尾巴'.repeat(400);

async function makeService(over = {}) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-budget-'));
  const svc = await createMemoryService({ memoHome, scope: SCOPE, ...over });
  return { svc, memoHome };
}

test('B6.2 clipSnippet：≤200 字 + 省略号；不越界不改写', () => {
  assert.equal(SNIPPET_CHARS_DEFAULT, 200);
  assert.equal(clipSnippet('短句', 200), '短句');
  const clipped = clipSnippet('x'.repeat(500), 200);
  assert.equal(clipped.length, 201);
  assert.ok(clipped.endsWith('…'));
});

test('B6.2 search 默认返回片段：单条正文 ≤200 字并标 snippetTruncated', async () => {
  const { svc, memoHome } = await makeService();
  try {
    for (let i = 0; i < 3; i++) {
      await svc.write({ kind: 'fact', text: `budgetprobe 记录 ${i} ${TAIL}`, source: { agent: 'test' } });
    }
    const r = await svc.search('budgetprobe');
    assert.equal(r.items.length, 3);
    assert.equal(r.snippetChars, 200);
    for (const { record } of r.items) {
      assert.ok(record.text.length <= 201, `单条 ${record.text.length} 字超限`);
      assert.ok(record.text.endsWith('…'));
      assert.equal(record.snippetTruncated, true);
    }
    assert.equal(r.readBudget.truncated, false);
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B6.2 会话条数上限：第二次检索被截断并标记 session-items', async () => {
  const { svc, memoHome } = await makeService({ policy: { search: { sessionMaxItems: 2 } } });
  try {
    for (let i = 0; i < 5; i++) {
      await svc.write({ kind: 'fact', text: `条数探针 ${i}`, source: { agent: 'test' } });
    }
    const first = await svc.search('条数探针');
    assert.equal(first.items.length, 2);
    assert.equal(first.readBudget.maxItems, 2);
    assert.equal(first.readBudget.truncated, true);
    assert.equal(first.readBudget.truncatedReason, 'session-items');
    assert.equal(first.readBudget.sessionUsed.items, 2);

    const second = await svc.search('条数探针');
    assert.equal(second.items.length, 0);
    assert.equal(second.readBudget.truncated, true);
    assert.equal(second.readBudget.truncatedReason, 'session-items');
    assert.ok(second.total >= 2, 'total 仍是真实命中数，便于调用方提示');

    resetReadBudget(svc);
    const after = await svc.search('条数探针');
    assert.equal(after.items.length, 2, '重置后预算恢复');
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B6.2 会话字节上限：单条就超过剩余预算时返回 0 条并标记 session-bytes', async () => {
  const { svc, memoHome } = await makeService({ policy: { search: { sessionMaxBytes: 50 } } });
  try {
    await svc.write({ kind: 'fact', text: `字节探针 ${TAIL}`, source: { agent: 'test' } });
    const r = await svc.search('字节探针');
    assert.equal(r.items.length, 0);
    assert.equal(r.readBudget.maxBytes, 50);
    assert.equal(r.readBudget.truncated, true);
    assert.equal(r.readBudget.truncatedReason, 'session-bytes');
    assert.equal(r.readBudget.returned, 0);
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});
