import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';

// I11（裁决 23）：Agent 当裁判的闭环——语义去重的自我迭代主通道。
// 6 条真人同义改写（§3.3 实测：词法门控不拦，全部 created）→ dedupeScan 发现候选簇 →
// Agent 构造 decisions（同簇 merge）→ curateApply 落盘（非破坏）→
// active ≤2、败者 superseded 带 merged 痕迹、真相层保留全部原始行、search 不重复、brief 无待裁决候选。
const PARAPHRASES = [
  'The CI deploy pipeline requires Node 22+',
  'Our release pipeline needs node version 22 or later',
  'CI/CD deployment must use Node.js 22 minimum',
  'pipeline: node >= 22 required for deploy',
  'node 22 is the minimum version the deployment pipeline needs',
  'Deploying through CI requires at least version 22 of Node',
];

test('I11 Agent 裁判闭环：6 条同义改写 → dedupeScan → curateApply(merge) → 收敛且非破坏', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i11' });

    // 1. 写入 6 条同义改写（词法门控按零误杀原则放行）
    const ids = [];
    for (const text of PARAPHRASES) {
      const res = await svc.write({ text, source: { agent: 'test' } });
      assert.ok(res && typeof res.action === 'string', '每次写操作必返回 action');
      ids.push(res.record.id);
    }
    assert.equal((await svc.stats()).active, PARAPHRASES.length, '词法门控不误杀：6 条应全部 active');

    // 2. dedupeScan 发现候选簇（裁决 22：只读）
    assert.equal(typeof svc.dedupeScan, 'function', '裁决 22：service 必须暴露 dedupeScan');
    const scan = await svc.dedupeScan({ threshold: 0.45 });
    assert.ok(scan && Array.isArray(scan.clusters), 'dedupeScan 必须返回 {clusters, scanned, threshold}');
    const texts = new Set(PARAPHRASES);
    const cluster = scan.clusters.find((c) => c.items.filter((it) => texts.has(it.text)).length >= 4);
    assert.ok(cluster, `dedupeScan(0.45) 应发现 ≥4 条同义改写簇，实际 ${JSON.stringify(scan.clusters.map((c) => c.items?.length))}`);

    // 3. Agent 判定：同簇逐对 merge（胜者 = 簇内第一条）→ curateApply 落盘（非破坏）
    const items = cluster.items.filter((it) => ids.includes(it.id));
    const winner = items[0];
    const pairs = items.slice(1).map((loser) => ({
      a: { id: winner.id },
      b: { id: loser.id },
      reason: 'dedupe cluster: agent judged same fact (semantic near-duplicate)',
    }));
    const batch = await svc.queue.exportBatch(pairs, { limit: pairs.length });
    const decisions = pairs.map((_, i) => ({ pairIndex: i, decision: 'merge', note: 'I11 agent judge: same fact' }));
    const applied = await svc.curateApply({ batchId: batch.batchId, decisions });
    assert.ok(
      applied.applied.every((r) => r.applied),
      `全部 merge 决策必须成功落盘，实际 ${JSON.stringify(applied)}`,
    );

    // 4. 收敛断言：active ≤ 2，其余 superseded 且簇内留有 merged 痕迹（裁决 23：败者 superseded + tag merged）
    const stats = await svc.stats();
    assert.ok(stats.active <= 2, `merge 后 active 应 ≤2，实际 ${stats.active}`);
    const clusterRecs = (await Promise.all(items.map((it) => svc.get(it.id)))).filter(Boolean);
    const losers = clusterRecs.filter((r) => r.id !== winner.id);
    assert.equal(losers.length, items.length - 1, '败者记录必须仍可 get（非破坏）');
    for (const l of losers) {
      assert.equal(l.status, 'superseded', `败者 ${l.id} 应 superseded，实际 ${l.status}`);
    }
    assert.ok(
      clusterRecs.some((r) => Array.isArray(r.tags) && r.tags.includes('merged')),
      '裁决 23：merge 落盘后簇内必须留有 merged tag（胜者或败者至少其一）',
    );

    // 5. 真相层非破坏：全部 6 条原始记录都还在（superseded ≠ 删除）
    for (const id of ids) {
      const rec = await svc.get(id);
      assert.ok(rec, `真相层必须保留原始行 ${id}（merge 非破坏）`);
    }

    // 6. search 不重复：同一主题检索，active 视图文本唯一
    const s = await svc.search('node 22 deploy');
    const stexts = s.items.map((it) => it.record.text);
    assert.equal(new Set(stexts).size, stexts.length, `search 结果不得有重复文本，实际 ${JSON.stringify(stexts)}`);
    const activeTexts = stexts.filter((t) => texts.has(t));
    assert.ok(activeTexts.length <= 2, `search 的 active 同义句应 ≤2，实际 ${activeTexts.length}`);

    // 7. brief 不再出现待裁决候选（裁决 23：brief 末节待裁决计数应归零/消失）
    const brief = await svc.brief({});
    const m = String(brief).match(/待裁决去重候选[^\d]*(\d+)/);
    assert.ok(
      !m || Number(m[1]) === 0,
      `merge 后 brief 不得再报待裁决去重候选，实际 brief 末节：${String(brief).split('\n').slice(-5).join(' | ')}`,
    );
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
