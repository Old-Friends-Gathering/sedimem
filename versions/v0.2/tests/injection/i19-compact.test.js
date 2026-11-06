// tests/injection/i19-compact.test.js — 注入用例 I19（车道 D，issue #35）
// 断言清单（契约 docs/02 §3.13 裁决 51）：
//   1) purge 墓碑过宽限期 → compact 后物理消失（items 文件与内存索引都查不到）；
//   2) search 搜不到被删记录；
//   3) events 永不删：forget/delete 事件仍能查到（审计面）；
//   4) stats.total 下降，而 superseded / disputed 计数不变（compact 不改语义状态）；
//   5) 普通墓碑保留（as-of 可回查）。
// purge 打标签不由本车道实现：用 withPatch 手工构造 tags:['purge'] 墓碑快照后 svc._commit 落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';
import { withPatch } from '../../src/core/record.js';
import { createClock } from '../../src/core/clock.js';
import { compact } from '../../src/api/maintenance.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i19-compact.json'), 'utf8'),
);

test('I19 compact：purge 超期物理删除，events 仍在，stats.total 降而 superseded/disputed 不变', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  const scope = CASE.scope;
  const DAY = 86_400_000;
  const T = Date.now(); // 固定时钟：cutoff = T - graceMs 可复现
  const clock = createClock({ now: T });
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope, clock });

    // 1) 播种 5 条（eval/cases/i19-compact.json）
    const ids = [];
    for (const r of CASE.records) {
      const w = await svc.write({
        text: r.text, kind: r.kind, subject: r.subject,
        predicate: r.predicate, value: r.value,
        source: { agent: 'eval-i19' },
      });
      ids.push(w.record.id);
    }
    assert.equal(ids.length, 5, '种子应为 5 条记录');

    // 2) 手工构造墓碑：purgeIndices 两条 → purge 墓碑（validTo = T - staleDaysAgo 天，超过 7d 宽限）；
    //    plainTombstoneIndex 一条 → 普通墓碑（同样古老，但无 purge 标签，必须保留）
    const staleIso = new Date(T - CASE.staleDaysAgo * DAY).toISOString();
    // 真实墓碑 validFrom 必须早于 validTo：回溯 validFrom 一天，否则记录校验拒绝
    const staleFromIso = new Date(T - (CASE.staleDaysAgo + 1) * DAY).toISOString();
    for (const idx of CASE.purgeIndices) {
      const rec = svc._records.get(ids[idx]);
      await svc._commit(
        withPatch(rec, {
          status: 'tombstoned', validFrom: staleFromIso, validTo: staleIso,
          tags: [...(rec.tags ?? []), 'purge'],
        }),
        'forget',
        { mode: 'purge', reason: 'eval-i19' },
      );
    }
    {
      const rec = svc._records.get(ids[CASE.plainTombstoneIndex]);
      await svc._commit(
        withPatch(rec, { status: 'tombstoned', validFrom: staleFromIso, validTo: staleIso }),
        'forget',
        { mode: 'tombstone', reason: 'eval-i19' },
      );
    }

    // 3) compact（grace 用种子里的 7d）
    const res = await compact(svc, { purgeGraceMs: CASE.graceMs });
    assert.equal(res.purged, CASE.purgeIndices.length, `应物理删除 ${CASE.purgeIndices.length} 条`);
    assert.equal(res.before, 5);
    assert.equal(res.after, 3);

    // 4) search 搜不到被删记录
    const s = await svc.search(CASE.queries.purged);
    assert.equal(s.items.length, 0, 'purge 记录物理删除后 search 必须搜不到');

    // 5) events 永不删：delete（forget）事件仍可查（审计面）
    const evs = (await svc.events({ ops: ['forget'] })).events;
    assert.ok(evs.length >= 3, `events 应保留全部 forget 事件（含被物理删除记录的），实际 ${evs.length}`);
    const evIds = new Set(evs.map((e) => e.id));
    for (const idx of CASE.purgeIndices) {
      assert.ok(evIds.has(ids[idx]), `被删记录 ${ids[idx]} 的 forget 事件必须仍在 events 里`);
    }
    // compact 本身也留了审计事件
    const compactEvs = (await svc.events({ ops: ['compact'] })).events;
    assert.equal(compactEvs.length, 1, 'compact 应写一条 compact 审计事件');

    // 6) stats：total 下降，superseded/disputed 不变
    const st = await svc.stats();
    assert.equal(st.total, 3, 'total 应从 5 降到 3');
    assert.equal(st.superseded, 0, 'compact 不得改变 superseded 计数');
    assert.equal(st.disputed, 0, 'compact 不得改变 disputed 计数');
    assert.equal(st.tombstoned, 1, '普通墓碑保留（1 条）');

    // 7) 普通墓碑在真相层仍在（as-of 回查依赖）
    const raw = readFileSync(join(memoHome, 'items', `${scope}.jsonl`), 'utf8');
    for (const idx of CASE.purgeIndices) {
      assert.ok(!raw.includes(ids[idx]), `被删记录 ${ids[idx]} 不得残留在 items 文件`);
    }
    assert.ok(raw.includes(ids[CASE.plainTombstoneIndex]), '普通墓碑必须保留在 items 文件');

    // 8) 未被删除的 active 记录仍可检索
    const kept = await svc.search(CASE.queries.kept);
    assert.ok(kept.items.length >= 1, '保留的 active 记录应仍可检索');
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
