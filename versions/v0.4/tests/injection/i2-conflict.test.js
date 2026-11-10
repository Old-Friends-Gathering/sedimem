import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i2-conflict.json'), 'utf8'),
);

test('I2 冲突：截止 3/1 → 4/1 supersede，asOf 可回看 3/1', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    // 可变时钟：第一笔写在 tFirstMs，第二笔写在 tSecondMs（更晚，才构成“新更晚”）
    let nowMs = CASE.tFirstMs;
    const clock = { nowMs: () => nowMs, now: () => new Date(nowMs).toISOString() };
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i2', clock });

    const first = await svc.write({
      text: CASE.first.text, kind: 'fact',
      subject: CASE.subject, predicate: CASE.predicate, value: CASE.first.value,
      source: { agent: 'test' },
    });
    assert.equal(first.action, 'created');

    nowMs = CASE.tSecondMs;
    const second = await svc.write({
      text: CASE.second.text, kind: 'fact',
      subject: CASE.subject, predicate: CASE.predicate, value: CASE.second.value,
      source: { agent: 'test' },
    });
    assert.equal(second.action, 'supersede', `第二次写入 action 应为 supersede，实际 ${second.action}`);

    const stats = await svc.stats();
    assert.equal(stats.superseded, 1, `stats.superseded 应为 1，实际 ${stats.superseded}`);

    const current = await svc.search(CASE.query);
    assert.ok(current.items.length >= 1, '当前 search 应有结果');
    for (const it of current.items) {
      assert.equal(it.record.value, CASE.second.value, `当前 search 只应返回 ${CASE.second.value}`);
    }
    assert.equal(current.items.filter((it) => it.record.value === CASE.first.value).length, 0);

    // asOf 在两次写入之间：应能取回 3/1 版本
    const hist = await svc.search(CASE.query, { asOf: CASE.asOfBeforeSupersede });
    assert.ok(hist.items.length >= 1, `asOf=${CASE.asOfBeforeSupersede} 应有结果`);
    assert.equal(hist.items[0].record.value, CASE.first.value, 'asOf 查询应返回 3/1 版本');
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
