import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i9-asof-tz.json'), 'utf8'),
);

test('I9 asOf 时区：+08:00 表达的同一时刻可查到；早 1 秒查不到；非法串抛 E_INVALID_ARG', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    // 裁决 1：用可控时钟把写入时间固定在 T，asOf 比较才有确定性
    const clock = { nowMs: () => CASE.tWriteMs, now: () => new Date(CASE.tWriteMs).toISOString() };
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i9', clock });

    const w = await svc.write({
      text: CASE.write.text, kind: 'fact',
      subject: CASE.write.subject, predicate: CASE.write.predicate, value: CASE.write.value,
      source: { agent: 'test' },
    });
    assert.equal(w.action, 'created');

    // 基线：UTC 表达的 T 时刻可查到（validFrom <= asOf）
    const utc = await svc.search(CASE.query, { asOf: CASE.asOfUtc });
    assert.ok(utc.items.length >= 1, `asOf=${CASE.asOfUtc} 应能查到写入于 T 的记录`);

    // 裁决 17：同一时刻的 +08:00 表达（等于其 UTC）必须同样查到——按 Date.parse 归一比较，禁止字典序
    const plus08 = await svc.search(CASE.query, { asOf: CASE.asOfPlus08 });
    assert.ok(
      plus08.items.length >= 1,
      `asOf=${CASE.asOfPlus08}（与 ${CASE.asOfUtc} 同一时刻）必须能查到，实际 ${plus08.items.length} 条`,
    );
    assert.equal(plus08.items[0].record.value, CASE.write.value);

    // 比 T 早 1 秒的 +08:00 表达：查不到
    const before = await svc.search(CASE.query, { asOf: CASE.asOfPlus08Before });
    assert.equal(before.items.length, 0, `asOf=${CASE.asOfPlus08Before}（早于写入 1 秒）不应查到，实际 ${before.items.length} 条`);

    // 非法输入：E_INVALID_ARG（裁决 17，不得用别的错误码）
    await assert.rejects(
      svc.search(CASE.query, { asOf: CASE.asOfInvalid }),
      (err) => err instanceof Error && err.code === 'E_INVALID_ARG',
    );
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
