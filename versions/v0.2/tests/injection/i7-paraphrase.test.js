import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i7-paraphrase.json'), 'utf8'),
);

// §3.3 裁决 22/23/24（Lead 亲测冻结）：这 5 句真人改写词面差异大，
// 词法 containment 抓不住（实测全部 created、active=9）——真同义改写必须靠 Agent 当裁判。
const HUMAN_PARAPHRASES = [
  'The CI deploy pipeline requires Node 22+',
  'Our release pipeline needs node version 22 or later',
  'CI/CD deployment must use Node.js 22 minimum',
  'pipeline: node >= 22 required for deploy',
  'node 22 is the minimum version the deployment pipeline needs',
];

test('I7a 词面近似重复：20 条近似句（无 subject/predicate）→ nearDupBlocked ≥ 15、active ≤ 3、disputed = 0、检索不重复', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i7a' });

    const actions = [];
    for (const text of CASE.paraphrases) {
      const res = await svc.write({ text, source: { agent: 'test' } });
      assert.ok(res && typeof res.action === 'string', '每次写操作必返回 action（hook 静默失败防线）');
      actions.push(res.action);
    }

    // 裁决 14：unstructured 近重复 → noop_same_value（reason=near_duplicate），不得落 disputed
    const created = actions.filter((a) => a === 'created').length;
    const blocked = actions.filter((a) => a === 'noop_same_value' || a === 'noop_duplicate').length;
    assert.ok(blocked >= 15, `词面近似重复应拦截 ≥15 条，实际 ${blocked}（actions=${JSON.stringify(actions)}）`);
    assert.equal(
      blocked + created, CASE.paraphrases.length,
      '每条要么 created 要么被近重复拦截，不得有第三种去向',
    );

    const stats = await svc.stats();
    assert.equal(stats.disputed, 0, `近似句不得产生 disputed（裁决 14），实际 ${stats.disputed}`);
    assert.ok(stats.active <= 3, `I7a active 应 ≤3，实际 ${stats.active}`);

    // 每条 search 不重复：查同义主题文本不重复出现
    const s = await svc.search(CASE.query);
    const texts = s.items.map((it) => it.record.text);
    assert.equal(new Set(texts).size, texts.length, `search 结果不得有重复文本，实际 ${JSON.stringify(texts)}`);
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});

// I7 口径修正说明（诚实化）：旧断言「20 同义句 -> active<=2」被 Lead 亲测证伪（裁决 22 前言）：
// 词面近似 fixture 保留在 I7a；真人改写拆到 I7b，按 §3.3 定位「在线词法只做零误杀的保守去重」记录真实能力。
test('I7b 真人改写（§3.3 的 5 句）：在线词法门控允许 created（lexicalOnly，记录真实能力），dedupeScan(0.45) 必须聚成同一簇', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i7b' });

    const actions = [];
    for (const text of HUMAN_PARAPHRASES) {
      const res = await svc.write({ text, source: { agent: 'test' } });
      assert.ok(res && typeof res.action === 'string', '每次写操作必返回 action');
      actions.push(res.action);
    }
    // lexicalOnly: true —— 记录当前真实能力：真人改写词面差异大，在线词法门控不拦截（裁决 22 前言实测）。
    // 若实现误拦（误杀真人改写），此处红：宁可漏杀不可误杀（裁决 24）。
    for (let i = 0; i < actions.length; i++) {
      assert.equal(
        actions[i], 'created',
        `第 ${i + 1} 句真人改写 "${HUMAN_PARAPHRASES[i]}" 应被在线写入门控允许 created（lexicalOnly，零误杀），实际 ${actions[i]}`,
      );
    }

    // 候选发现：dedupeScan({threshold:0.45}) 必须把 5 句聚成同一簇（size>=4），供 Agent 判定（裁决 22）
    assert.equal(typeof svc.dedupeScan, 'function', '裁决 22：service 必须暴露 dedupeScan({threshold, limit}) 公共 API');
    const scan = await svc.dedupeScan({ threshold: 0.45 });
    assert.ok(scan && Array.isArray(scan.clusters), 'dedupeScan 必须返回 {clusters, scanned, threshold}');
    assert.equal(scan.threshold, 0.45, 'dedupeScan 应回传实际使用的 threshold');
    const texts = new Set(HUMAN_PARAPHRASES);
    const hit = scan.clusters.filter(
      (c) => c.items.filter((it) => texts.has(it.text)).length >= 4,
    );
    assert.ok(
      hit.length >= 1,
      `dedupeScan(0.45) 应把 ≥4 句真人改写聚成同一簇（size>=4），实际 clusters=${JSON.stringify(scan.clusters.map((c) => ({ size: c.items?.length, maxSimilarity: c.maxSimilarity })))}`,
    );
    assert.ok(hit[0].size >= 4, `簇 size 应 ≥4，实际 ${hit[0].size}`);
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('I7 对照组：20 条真正不同的事实必须全部 created（不得误杀）', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i7-control' });
    for (const text of CASE.distinctFacts) {
      const res = await svc.write({ text, source: { agent: 'test' } });
      assert.equal(
        res.action, 'created',
        `不同事实 "${text}" 必须被 created，实际 ${res.action}（近重复判定不得误杀）`,
      );
    }
    const stats = await svc.stats();
    assert.equal(stats.active, CASE.distinctFacts.length, `active 应 = ${CASE.distinctFacts.length}，实际 ${stats.active}`);
    assert.equal(stats.disputed, 0, `对照组不得产生 disputed，实际 ${stats.disputed}`);

    // 每条都能单独检索到
    for (const text of CASE.distinctFacts) {
      const kw = text.replace(/[，。：、/]/g, ' ').split(/\s+/).filter((w) => w.length >= 2)[0];
      const s = await svc.search(kw, { limit: 20 });
      assert.ok(
        s.items.some((it) => it.record.text === text),
        `"${text}" 应可被检索到（关键词 "${kw}"）`,
      );
    }
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
