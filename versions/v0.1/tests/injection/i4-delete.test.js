import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i4-delete.json'), 'utf8'),
);

test('I4 删除：forget 后两次查不到，真相层只追加墓碑，reindex 不改字节', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  const scope = 'repo:eval-i4';
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope });
    const w = await svc.write({
      text: CASE.text, kind: 'fact',
      subject: CASE.subject, predicate: CASE.predicate, value: CASE.value,
      source: { agent: 'test' },
    });
    const id = w.record.id;

    await svc.forget({ id });

    // 立即查：search 空 & get 查不到
    const s1 = await svc.search(CASE.query);
    assert.equal(s1.items.filter((it) => it.record.id === id).length, 0, 'forget 后 search 应查不到');
    const g1 = await svc.get(id);
    assert.ok(
      g1 === null || g1 === undefined || g1.status === 'tombstoned',
      'forget 后 get 应返回 null 或仅剩墓碑（不得返回 active）',
    );

    // reindex 前后 items.jsonl 字节数不变
    const itemsPath = join(memoHome, 'items', `${scope}.jsonl`);
    const sizeBefore = statSync(itemsPath).size;
    await svc.reindex();
    const sizeAfter = statSync(itemsPath).size;
    assert.equal(sizeAfter, sizeBefore, 'reindex 只读真相层，items.jsonl 字节数不得变化');

    // reindex 后再查仍查不到
    const s2 = await svc.search(CASE.query);
    assert.equal(s2.items.filter((it) => it.record.id === id).length, 0, 'reindex 后不得复活已删条目');

    // 真相层该 id 最后一行 status=='tombstoned'（读文件断言，不调内部函数）
    const lines = readFileSync(itemsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const mine = lines.filter((r) => r.id === id);
    assert.ok(mine.length >= 1, '真相层应有该 id 的记录');
    assert.equal(mine[mine.length - 1].status, 'tombstoned', '最后一行应为 tombstoned');
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
