// tests/unit/conflicts.test.js — 分歧视图（施工图 D4 / 用例 I29）：
// listConflicts 只读展示同 slot 冲突；resolveConflicts 走 curateApply a_wins 非破坏落败。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { listConflicts, resolveConflicts } from '../../src/views/conflicts.js';

/** 同 slot、值互不可比（parseComparable 均失败）的三条 → 1 active + 2 disputed */
const SLOT = { subject: 'deploy', predicate: 'branch' };
const VALUES = ['alpha 主线', 'beta 旁路', 'gamma 实验线'];

async function fresh() {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-conflicts-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:unit-conflicts' });
  return { svc, memoHome };
}

/** 写三条同 slot 不同 value 的记录，返回写入结果（首条 active，其余 disputed） */
async function seedConflict(svc) {
  const writes = [];
  const texts = [
    '值班同学确认后，发布流量统一切到 alpha 主线',
    '灰度期间走 beta 旁路，观察报错再放量',
    '研究员专属的 gamma 实验线不承载真实用户',
  ];
  for (let i = 0; i < VALUES.length; i++) {
    // 文本刻意差异化，避免命中近重复阈值（nearDupThreshold 默认 0.85）被吸收为 variant
    writes.push(await svc.write({
      text: texts[i],
      value: VALUES[i],
      subject: SLOT.subject,
      predicate: SLOT.predicate,
      source: { agent: 'test' },
    }));
  }
  return writes;
}

/** 真相层 items/*.jsonl 的总行数（append-only，resolve 后不得减少） */
function truthLines(memoHome) {
  const dir = join(memoHome, 'items');
  let lines = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    lines += readFileSync(join(dir, name), 'utf8').split('\n').filter((l) => l.trim() !== '').length;
  }
  return lines;
}

describe('listConflicts（D4 分歧视图）', () => {
  test('同 slot 三条不同 value → 默认检索 1 条、listConflicts 收 3 条且计数正确', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const writes = await seedConflict(svc);
      assert.equal(writes[0].action, 'created');
      assert.equal(writes[1].action, 'disputed');
      assert.equal(writes[2].action, 'disputed');

      // 默认检索只回 active（includeDisputed=false）→ 1 条
      const search = await svc.search('发布流量主线');
      assert.equal(search.items.length, 1, `默认检索应只见 1 条 active，实际 ${search.items.length}`);
      assert.equal(search.items[0].record.status, 'active');

      // 分歧视图：3 条全可见，计数正确
      const view = await listConflicts({ service: svc });
      assert.equal(view.slots.length, 1);
      const slot = view.slots[0];
      assert.equal(slot.records.length, 3, 'slot 内应收 3 条（1 active + 2 disputed）');
      assert.equal(slot.disputedCount, 2);
      assert.equal(view.disputedCount, 2);
      assert.equal(view.supersededCount, 0);
      assert.equal(view.scanned, 3);
      // 记录字段投影
      for (const r of slot.records) {
        assert.ok(r.id && typeof r.text === 'string' && typeof r.status === 'string');
        assert.equal(r.subject, SLOT.subject);
        assert.equal(r.predicate, SLOT.predicate);
        assert.ok(typeof r.hits === 'number');
      }
      // 逐对相似度：3 条 → C(3,2)=3 对，值在 [0,1]
      assert.equal(slot.pairs.length, 3);
      for (const p of slot.pairs) {
        assert.ok(p.aId !== p.bId);
        assert.ok(p.similarity >= 0 && p.similarity <= 1);
      }
      // slot 键能唯一定位（供 resolve --slot 使用）
      assert.equal(new Set(view.slots.map((s) => s.key)).size, 1);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('空库与无冲突 → slots 为空、计数为 0', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const view = await listConflicts({ service: svc });
      assert.equal(view.slots.length, 0);
      assert.equal(view.disputedCount, 0);
      assert.equal(view.supersededCount, 0);
      assert.equal(view.scanned, 0);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});

describe('resolveConflicts（D4 一键修复）', () => {
  test('resolve 后 active=1、其它 superseded、真相层行数不减', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const writes = await seedConflict(svc);
      const before = truthLines(memoHome);

      const view = await listConflicts({ service: svc });
      const slotKey = view.slots[0].key;
      const winnerId = writes[0].record.id; // 首条是 active

      const out = await resolveConflicts({ service: svc, slot: slotKey, winnerId, note: 'unit: 选定第一版' });
      assert.equal(out.resolved.length, 2, '应落败 2 条 disputed');

      const all = await svc.exportRecords({ status: 'all' });
      const active = all.records.filter((r) => r.status === 'active');
      const superseded = all.records.filter((r) => r.status === 'superseded');
      assert.equal(active.length, 1);
      assert.equal(active[0].id, winnerId);
      assert.equal(superseded.length, 2);

      // append-only：真相层行数只增不减（a_wins 语义非破坏）
      const after = truthLines(memoHome);
      assert.ok(after >= before, `真相层行数不得减少（before=${before}, after=${after}）`);

      // 修复后 slot 从分歧视图消失（只剩 1 条 active）
      const view2 = await listConflicts({ service: svc });
      assert.equal(view2.slots.length, 0);
      assert.equal(view2.supersededCount, 2);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('winner 不在 slot → E_INVALID_ARG', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await seedConflict(svc);
      const outsider = await svc.write({
        text: '完全无关的另一条事实：会议室在 3 楼 B 区',
        value: '3 楼 B 区',
        subject: 'office',
        predicate: 'meeting-room',
        source: { agent: 'test' },
      });
      const view = await listConflicts({ service: svc });
      const slotKey = view.slots[0].key;
      await assert.rejects(
        resolveConflicts({ service: svc, slot: slotKey, winnerId: outsider.record.id }),
        (err) => err.code === 'E_INVALID_ARG',
      );
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('winner 非 active（已 superseded）→ E_INVALID_ARG', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const writes = await seedConflict(svc);
      const view = await listConflicts({ service: svc });
      const slotKey = view.slots[0].key;
      const winnerId = writes[0].record.id;
      await resolveConflicts({ service: svc, slot: slotKey, winnerId });
      // winner 现在仍是 active；把一条已 superseded 的败者当 winner → 拒绝
      const loserId = writes[1].record.id;
      await assert.rejects(
        resolveConflicts({ service: svc, slot: slotKey, winnerId: loserId }),
        (err) => err.code === 'E_INVALID_ARG',
      );
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('重复 resolve 幂等：第二次 resolved 为空、active 仍 1', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const writes = await seedConflict(svc);
      const view = await listConflicts({ service: svc });
      const slotKey = view.slots[0].key;
      const winnerId = writes[0].record.id;

      const first = await resolveConflicts({ service: svc, slot: slotKey, winnerId });
      assert.equal(first.resolved.length, 2);
      const second = await resolveConflicts({ service: svc, slot: slotKey, winnerId });
      assert.equal(second.resolved.length, 0, '重复 resolve 不应再动任何记录');

      const all = await svc.exportRecords({ status: 'all' });
      assert.equal(all.records.filter((r) => r.status === 'active').length, 1);
      assert.equal(all.records.filter((r) => r.status === 'superseded').length, 2);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('slot 已唯一（无落败者）→ resolved 为空', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const writes = await seedConflict(svc);
      // 先手工裁决掉两条，再 resolve 应空手而归
      const view = await listConflicts({ service: svc });
      const slotKey = view.slots[0].key;
      await svc.curateApply({
        decisions: [
          { ids: [writes[0].record.id, writes[1].record.id], decision: 'a_wins' },
          { ids: [writes[0].record.id, writes[2].record.id], decision: 'a_wins' },
        ],
      });
      const out = await resolveConflicts({ service: svc, slot: slotKey, winnerId: writes[0].record.id });
      assert.deepEqual(out, { resolved: [], skipped: [] });
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
