// tests/unit/compact.test.js — 车道 D（issue #35）：物理压实三重条件 + 备份策略。
// 契约 docs/02 §3.13 裁决 51：只有「墓碑 + tags 含 purge + validTo 早于 now-grace」才物理删除。
// 注意：service.forget 的 purge 打标签属另一车道，这里用 withPatch 手工构造带 tags:['purge']
// 的墓碑快照再走 svc._commit 落盘（等价于 forget --purge 的真相层结果）。
import { test } from 'node:test';
import { itemsFileName } from '../../src/config/paths.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { withPatch } from '../../src/core/record.js';
import { createClock } from '../../src/core/clock.js';
import { compact } from '../../src/api/maintenance.js';

// 固定时钟：cutoff 可复现（T - 7d），「超期」用 validTo = T - 8d 表示
const T = 1_800_000_000_000;
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
/** 写一条记录并按需转成墓碑：mode='purge' 打 tags:['purge']，mode='plain' 普通墓碑 */
async function writeOne(svc, { text, subject, tombstone = null, validToMs = null }) {
  const w = await svc.write({
    text, kind: 'fact', subject, predicate: 'p', value: text,
    source: { agent: 'compact-test' },
  });
  const id = w.record.id;
  if (tombstone) {
    const rec = svc._records.get(id);
    // 真实墓碑的 validFrom 一定早于 validTo：回溯 validFrom，否则校验器拒绝 validFrom > validTo
    const patch = {
      status: 'tombstoned',
      validFrom: iso(Math.min(Date.parse(rec.validFrom ?? T), validToMs != null ? validToMs - 1 : Infinity)),
      validTo: rec.validTo ?? iso(validToMs ?? T),
    };
    if (tombstone === 'purge') patch.tags = [...(rec.tags ?? []), 'purge'];
    await svc._commit(withPatch(rec, patch), 'forget', { mode: tombstone, reason: 'compact-test' });
  }
  return id;
}

function itemsPath(memoHome, scope) {
  return join(memoHome, 'items', itemsFileName(scope));
}

test('compact：purge+超期 物理消失；purge 未超期/普通墓碑 保留；dryRun 字节不变；二次压实只留一份 .bak', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-compact-'));
  const scope = `repo:compact-${++seq}`;
  const clock = createClock({ now: T });
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope, clock });

    // 种子 ≥5 条：2 条 purge+超期（validTo = T-8d）、1 条 purge 未超期、1 条普通墓碑、1 条 active
    const gone1 = await writeOne(svc, { text: 'purged-old-1', subject: 'a', tombstone: 'purge', validToMs: T - 8 * DAY });
    const gone2 = await writeOne(svc, { text: 'purged-old-2', subject: 'b', tombstone: 'purge', validToMs: T - 8 * DAY });
    await writeOne(svc, { text: 'purge-fresh', subject: 'c', tombstone: 'purge', validToMs: T }); // 未超期
    await writeOne(svc, { text: 'plain-tomb', subject: 'd', tombstone: 'plain', validToMs: T - 8 * DAY });
    await writeOne(svc, { text: 'alive-record', subject: 'e' });

    const file = itemsPath(memoHome, scope);

    // —— dryRun：只统计，文件字节不变 ——
    const bytesBefore = readFileSync(file);
    const dry = await compact(svc, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.purged, 2, 'dryRun 应只统计出 2 条可删（双重超期 purge 墓碑）');
    assert.equal(readFileSync(file).length, bytesBefore.length, 'dryRun 不得动文件');
    assert.ok(readFileSync(file).equals(bytesBefore), 'dryRun 后文件字节必须完全一致');

    // —— 真删 ——
    const res = await compact(svc, {});
    assert.equal(res.dryRun, false);
    assert.equal(res.before, 5);
    assert.equal(res.purged, 2);
    assert.equal(res.after, 3);
    assert.equal(res.kept, 3);
    assert.ok(res.backupPath && res.backupPath.startsWith(file + '.bak.'), '应返回备份路径');

    // 物理消失：文件里不再有这两个 id 的任何一行
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes(gone1), `purge+超期记录 ${gone1} 应物理消失`);
    assert.ok(!raw.includes(gone2), `purge+超期记录 ${gone2} 应物理消失`);
    // 未超期 purge 墓碑 / 普通墓碑 / active 均保留
    assert.ok(raw.includes('purge-fresh'), 'purge 但未超期的墓碑必须保留');
    assert.ok(raw.includes('plain-tomb'), '普通墓碑（无 purge 标签）必须保留（as-of 回查依赖）');
    assert.ok(raw.includes('alive-record'), 'active 记录当然保留');

    // reindex 生效：缓存与索引不得复活已删记录
    assert.equal(svc._records.get(gone1), undefined, '物理删除后内存缓存不得残留已删记录');

    // —— 第二次压实：只留最新一份 .bak ——
    await new Promise((r) => setTimeout(r, 5)); // 时间戳去掉冒点后毫秒级仍可能同值，稍错开
    await compact(svc, {});
    const baks = readdirSync(join(memoHome, 'items')).filter((f) => f.startsWith(`${itemsFileName(scope)}.bak.`));
    assert.equal(baks.length, 1, `第二次压实后应只保留一份 .bak，实际: ${baks.join(',')}`);
    // 剩余记录 ≥5 条快照行（未删的 3 条 fold 后仍在，历史 append 行不减少表述不适用于重写后文件）
    const keptLines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(keptLines.length >= 3, '重写后文件至少保留 3 条记录');
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('compact：purgeGraceMs 入参与非法入参', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-compact-'));
  const scope = `repo:compact-arg-${++seq}`;
  const clock = createClock({ now: T });
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope, clock });
    await writeOne(svc, { text: 'edge-case', subject: 'x', tombstone: 'purge', validToMs: T - DAY });

    // grace = 12h：T-1d 的墓碑已超期 → 删
    const r1 = await compact(svc, { purgeGraceMs: 12 * 3600_000 });
    assert.equal(r1.purged, 1);
    // grace 巨大（如 365d）：同条件不再可删（已删完，before=0）
    const r2 = await compact(svc, { purgeGraceMs: 365 * DAY });
    assert.equal(r2.before, 0);
    assert.equal(r2.purged, 0);
    // 非法 grace：fail-loud
    await assert.rejects(() => compact(svc, { purgeGraceMs: '7d' }), /purgeGraceMs/);
    await assert.rejects(() => compact(svc, { purgeGraceMs: -1 }), /purgeGraceMs/);
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
