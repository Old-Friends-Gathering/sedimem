import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';
import { QuotaPolicy } from '../../src/hygiene/quota.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i6-quota.json'), 'utf8'),
);

test('I6 容量：maxActive=20 写 40 条 → 只产生墓碑，doctor 报 quota_exceeded 非 error', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  const scope = 'repo:eval-i6';
  let svc;
  try {
    svc = await createMemoryService({
      memoHome, scope,
      quota: new QuotaPolicy({ maxActive: CASE.maxActive }),
    });

    for (const w of CASE.writes) {
      await svc.write({
        text: w.text, kind: 'fact',
        subject: w.subject, predicate: w.predicate, value: w.value,
        source: { agent: 'test' },
      });
    }

    const stats = await svc.stats();
    assert.ok(stats.active <= CASE.maxActive, `active 应 <= ${CASE.maxActive}，实际 ${stats.active}`);
    assert.ok(stats.tombstoned >= 1, '淘汰应产生墓碑（tombstoned >= 1）');

    // 真相层不物理删：40 条 id 全部仍在 jsonl 中（fold 后为 created/tombstoned 等状态）
    const lines = readFileSync(join(memoHome, 'items', `${scope}.jsonl`), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const ids = new Set(lines.map((r) => r.id));
    assert.equal(ids.size, CASE.writes.length, `真相层应保留全部 ${CASE.writes.length} 个 id，实际 ${ids.size}`);

    // 被淘汰条目按价值最低者优先：被 tombstone 的 id 数 = 超额数
    const folded = new Map();
    for (const r of lines) folded.set(r.id, r); // 最后一行胜出
    const tombstoned = [...folded.values()].filter((r) => r.status === 'tombstoned');
    assert.equal(tombstoned.length, CASE.writes.length - CASE.maxActive, '超额条目应恰好全部淘汰为墓碑');
    // 无 hits 的记录里，越旧越先被淘汰：tombstoned 集合应集中在更早写入的条目
    const evictedIdx = tombstoned.map((r) => CASE.writes.findIndex((w) => w.text === r.text));
    const keptIdx = [...folded.values()].filter((r) => r.status === 'active')
      .map((r) => CASE.writes.findIndex((w) => w.text === r.text));
    assert.ok(
      Math.max(...evictedIdx) <= Math.min(...keptIdx),
      `价值最低者优先：被淘汰的最大序号 ${Math.max(...evictedIdx)} 应 <= 保留的最小序号 ${Math.min(...keptIdx)}`,
    );

    // doctor 报 quota_exceeded 但不 error
    const doc = await svc.doctor();
    const codes = (doc.issues || []).map((i) => i.code);
    assert.ok(codes.includes('quota_exceeded'), `doctor 应报 quota_exceeded，实际 ${JSON.stringify(codes)}`);
    const errors = (doc.issues || []).filter((i) => i.severity === 'error');
    assert.equal(errors.length, 0, `doctor 不应报 error，实际 ${JSON.stringify(errors)}`);
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
