import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';

// I12（裁决 26）：中文真人改写的候选发现 + Agent 裁决闭合。
// 背景（§3.5 实测）：中文改写里，共享名词的（部署脚本/上线脚本）containment 已能到 0.55–0.67；
// 但内容词全换的（生产环境禁止直连数据库 / 线上环境不允许直接连接数据库）containment = 0，
// 只有汉字二元组 Dice 能到 0.26。两条路都必须能把它们交到 Agent 面前，且无关中文事实不能虚报。
const CANONICAL = [
  '数据库连接池上限是 20',
  '数据库连接池最大 20 个连接',
  '生产环境禁止直连数据库',
  '线上环境不允许直接连接数据库',
];
const PARAPHRASE_PAIRS = [
  ['部署脚本在 scripts/deploy.sh', '上线脚本位于 scripts/deploy.sh'],
  ['缓存命中率低于 60% 要报警', '缓存命中率不足 60% 时触发告警'],
  ['发布窗口限定工作日晚上', '发版只能在工作日夜间进行'],
];
const UNRELATED = [
  '前端的构建产物放在 dist 目录',
  '日志按天切割并保留 14 天',
  '告警统一走飞书机器人',
  '压测目标 QPS 定在 500',
];

async function writeAll(svc, texts) {
  const ids = [];
  for (const text of texts) {
    const res = await svc.write({ text, source: { agent: 'test' } });
    assert.ok(res && typeof res.action === 'string', `写入必返回 action：${text}`);
    ids.push(res.record.id);
  }
  return ids;
}

test('I12 中文改写：containment 与 CJK Dice 双路召回 → Agent 裁决 → 非破坏收敛', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i12' });

    // 1. 写入门控不误杀：4 条同义 + 6 条配对 + 4 条无关，全部 created
    const canonicalIds = await writeAll(svc, CANONICAL);
    const pairIds = await writeAll(svc, PARAPHRASE_PAIRS.flat());
    await writeAll(svc, UNRELATED);
    assert.equal((await svc.stats()).active, CANONICAL.length + pairIds.length + UNRELATED.length);

    // 2. 扫描：同义 4 条必须成簇，且簇内给出逐对依据（含 basis/strength）
    const scan = await svc.dedupeScan({});
    assert.ok(scan.diceThreshold > 0, 'dedupeScan 必须暴露 diceThreshold（裁决 26）');
    const textOf = new Map();
    for (const c of scan.clusters) for (const it of c.items) textOf.set(it.id, it.text);
    const canonicalCluster = scan.clusters.find(
      (c) => c.items.filter((it) => CANONICAL.includes(it.text)).length >= 4,
    );
    assert.ok(
      canonicalCluster,
      `4 条同义中文改写必须成簇，实际簇=${JSON.stringify(scan.clusters.map((c) => c.items.map((i) => i.text)))}`,
    );
    assert.ok(Array.isArray(canonicalCluster.pairs) && canonicalCluster.pairs.length >= 1, '簇必须带逐对依据 pairs');
    for (const p of canonicalCluster.pairs) {
      assert.ok(textOf.has(p.aId) && textOf.has(p.bId), 'pairs 的 id 必须属于本簇 items');
      assert.ok(['containment', 'dice'].includes(p.basis), `basis 取值非法：${p.basis}`);
      assert.ok(['strong', 'weak'].includes(p.strength), `strength 取值非法：${p.strength}`);
    }
    // 关键回归：containment = 0、只靠 Dice 连上的那一对必须出现在 pairs 里
    const prodIds = canonicalIds.slice(2);
    const diceOnly = canonicalCluster.pairs.find(
      (p) => prodIds.includes(p.aId) && prodIds.includes(p.bId) && p.containment === 0 && p.dice > 0,
    );
    assert.ok(diceOnly, '裁决 26：containment=0 的中文改写对必须由 CJK Dice 召回（否则该路度量失效）');

    // 3. 无关中文事实不得进任何簇（宁可漏，不可虚报整簇）
    for (const c of scan.clusters) {
      const unrelatedHit = c.items.filter((it) => UNRELATED.includes(it.text));
      assert.equal(unrelatedHit.length, 0, `无关事实不得进候选簇，实际混入：${JSON.stringify(unrelatedHit.map((i) => i.text))}`);
    }

    // 4. Agent 裁决（ids 形状，适用于 dedupeScan 产物没有 batchId 的场景）→ 同簇 merge
    const winner = { id: canonicalCluster.items[0].id };
    const decisions = canonicalCluster.items
      .filter((it) => it.id !== winner.id)
      .map((it) => ({ ids: [winner.id, it.id], decision: 'merge', note: 'I12: same fact (semantic near-duplicate)' }));
    const applied = await svc.curateApply({ decisions });
    assert.ok(applied.applied.every((r) => r.applied), `merge 必须全部落盘，实际 ${JSON.stringify(applied)}`);

    // 5. 收敛 + 非破坏：active 收敛到 1（本簇），原始 14 行真相层全留，败者 superseded 且不可被 search 默认返回
    const total = CANONICAL.length + PARAPHRASE_PAIRS.length * 2 + UNRELATED.length; // 14
    const stats = await svc.stats();
    assert.equal(stats.active, total - 3, `merge 3 条败者后 active 应为 ${total - 3}，实际 ${stats.active}`);
    assert.equal(applied.applied.length, 3, '应裁决 3 对');
    for (const id of canonicalIds) {
      const rec = await svc.get(id);
      assert.ok(rec, `真相层必须保留 ${id}（merge 非破坏）`);
    }
    const loserIds = canonicalCluster.items.filter((it) => it.id !== winner.id).map((it) => it.id);
    for (const id of loserIds) {
      const rec = await svc.get(id);
      assert.equal(rec.status, 'superseded', `败者 ${id} 应 superseded，实际 ${rec.status}`);
    }

    // 6. 再扫一次：本簇不应再出现（Agent 裁决后候选清零）
    const rescan = await svc.dedupeScan({});
    const stillThere = rescan.clusters.find(
      (c) => c.items.filter((it) => CANONICAL.includes(it.text)).length >= 2,
    );
    assert.equal(stillThere, undefined, `裁决后同义簇必须清零，实际 ${JSON.stringify(stillThere?.items?.map((i) => i.text))}`);
  } finally {
    if (svc) await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});
