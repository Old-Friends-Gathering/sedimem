// tests/injection/i23-l3-budget.test.js — I23 L3 预算硬上限 + 真库落盘可溯源（issue #52）
// 验收（研究文档 §4B Memobase 固定调用次数 / Letta 可回滚 / Graphiti 强制溯源）：
// 1) 40 条值得进 L3 的记录 → planL3 断言 candidates ≤ batchSize(10) 且 callsEstimate ≤ maxCallsPerRun(20)；
// 2) 假 judge 每调用一次计数，跑满一轮断言真实调用次数 ≤ maxCallsPerRun；
// 3) buildL3Record 产物写进真库（createMemoryService）→ 真相层多 1 行、
//    sourceRefs 可 traceL3 回原始记录（missing/stale 为空）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { loadPolicy } from '../../src/config/policy.js';
import { buildL2 } from '../../src/views/l2.js';
import { planL3, validateL3Draft, buildL3Record, traceL3 } from '../../src/views/l3.js';

test('I23 L3 预算：40 条候选 → 批次 ≤10、假 judge 调用 ≤20、落库可溯源', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i23-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i23' });

    // 40 条「值得进 L3」的记录：40 个互不相同的 slot（decision/pref/gotcha 轮转，
    // 值各不相同 → write-gate 全部 created，不会互相 supersede/noop）
    const kinds = ['decision', 'pref', 'gotcha'];
    for (let i = 0; i < 40; i++) {
      const res = await svc.write({
        text: `项目约定 ${i}：候选规则第 ${i} 条`,
        kind: kinds[i % 3],
        subject: `rule-${i}`, predicate: 'l3-candidate', value: `rule-${i}-v`,
        source: { agent: 'test' },
      });
      assert.equal(res.action, 'created', `第 ${i} 条应 created，实际 ${res.action}`);
    }
    const before = await svc.exportRecords({ status: 'all', limit: 200 });
    assert.equal(before.records.length, 40);

    // L2 块信息 + policy（l3 段缺省走默认：batchSize=10, maxCallsPerRun=20）
    const policy = loadPolicy();
    const blocks = buildL2(before.records, { scope: 'repo:eval-i23', policy }).blocks;
    const now = new Date('2026-11-07T00:00:00Z');

    // —— 1) 预算硬上限 ——
    const plan = planL3(before.records, blocks, { policy, now });
    assert.ok(plan.candidates.length <= 10, `candidates ${plan.candidates.length} ≤ batchSize 10`);
    assert.ok(plan.callsEstimate <= 20, `callsEstimate ${plan.callsEstimate} ≤ maxCallsPerRun 20`);
    assert.ok(plan.skipped >= 30, `40 组只取 10，skipped 应 ≥30，实际 ${plan.skipped}`);
    // 候选优先级：decision 组在 pref/gotcha/fact 前（权重降序）
    const weight = (k) => policy.kinds[k]?.weight ?? 0;
    const candWeight = plan.candidates.map((c) => Math.max(...c.kinds.map(weight)));
    for (let i = 1; i < candWeight.length; i++) {
      assert.ok(candWeight[i - 1] >= candWeight[i], '候选应按 kind 权重降序');
    }

    // —— 2) 假 judge：每调用一次计数，跑满一轮 ——
    let judgeCalls = 0;
    const drafts = [];
    for (const cand of plan.candidates) {
      judgeCalls++; // 假 judge：一个候选恰好一次 LLM 调用（Memobase 式固定上界）
      const draft = {
        text: `画像候选（${cand.kinds.join('/')}，${cand.recordIds.length} 条证据）：${cand.text.slice(0, 100)}`,
        kind: cand.kinds.includes('decision') ? 'decision' : 'pref',
        confidence: 0.85,
        sourceRefs: [...cand.recordIds],
      };
      const v = validateL3Draft(draft);
      assert.deepEqual(v, { ok: true }, `候选 ${cand.key} 的草稿应通过校验: ${JSON.stringify(v)}`);
      drafts.push(draft);
    }
    assert.ok(judgeCalls <= (policy.l3?.maxCallsPerRun ?? 20), `真实调用 ${judgeCalls} ≤ 上限 20`);

    // —— 3) 落库：真相层多 1 行，sourceRefs 可 trace 回原始记录 ——
    const built = buildL3Record(drafts[0], { now, policy });
    const res = await svc.write(built);
    assert.equal(res.action, 'created');
    const after = await svc.exportRecords({ status: 'all', limit: 200 });
    assert.equal(after.records.length, before.records.length + 1, '真相层应恰好多 1 行');
    const stored = after.records.find((r) => r.tags.includes('L3'));
    assert.ok(stored, '落库记录应带 tags:["L3",…]');

    const t = traceL3(built, before.records);
    assert.deepEqual(t.sourceRefs, drafts[0].sourceRefs);
    assert.deepEqual(t.missing, [], '每条 sourceRef 都应命中原始记录');
    assert.deepEqual(t.stale, [], '原始记录均 active，无 stale');

    // 二次 plan：已覆盖的记录被跳过（skipped 计数），不再重复进候选。
    // 注意：当前 svc.write → createRecord 会丢弃 input.sourceRefs（记录构造白名单），
    // 落库行只有 tags:['L3']。Lead 接线（curateApply 通道 / write 透传）落地前，
    // 这里用「落库行 + buildL3Record 的 sourceRefs」模拟接线后的持久化形状。
    const persistedL3 = { ...stored, sourceRefs: built.sourceRefs };
    const plan2 = planL3([...after.records.filter((r) => !r.tags.includes('L3')), persistedL3], blocks, { policy, now });
    const flat2 = plan2.candidates.flatMap((c) => c.recordIds);
    for (const id of drafts[0].sourceRefs) {
      assert.ok(!flat2.includes(id), `已覆盖记录 ${id} 不应再次成为候选`);
    }
  } finally {
    await svc?.close?.();
    rmSync(memoHome, { recursive: true, force: true });
  }
});
