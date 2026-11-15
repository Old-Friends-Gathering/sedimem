import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';

// 裁决 22：dedupeScan({threshold=0.45, limit=50}) —— 只读分簇（slot 分组 + 组内两两 containment 并查集）
const NODE_PARAPHRASES = [
  'The CI deploy pipeline requires Node 22+',
  'Our release pipeline needs node version 22 or later',
  'CI/CD deployment must use Node.js 22 minimum',
  'pipeline: node >= 22 required for deploy',
  'node 22 is the minimum version the deployment pipeline needs',
];
const REDIS_PARAPHRASES = [
  'The cache backend is Redis',
  'Caching is backed by Redis',
  'Redis serves as the cache store',
];
const UNRELATED = [
  '数据库端口是 5432',
  '构建命令为 pnpm run build',
  '会议室在 3 楼 B 区',
  '默认分支名是 main',
  '接口超时设置为 30 秒',
];

async function fresh(over = {}) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:unit-dedupe', ...over });
  return { svc, memoHome };
}

async function writeAll(svc, texts) {
  for (const text of texts) {
    const res = await svc.write({ text, source: { agent: 'test' } });
    assert.equal(res.action, 'created', `fixture 写入应 created：${text}`);
  }
}

describe('service.dedupeScan（裁决 22）', () => {
  test('空库 → 0 簇', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const scan = await svc.dedupeScan({});
      assert.ok(scan && Array.isArray(scan.clusters), '必须返回 {clusters, scanned, threshold}');
      assert.equal(scan.clusters.length, 0, '空库应 0 簇');
      assert.equal(scan.scanned, 0, '空库 scanned 应 0');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('5 句真人改写（unstructured）→ 1 簇，size ≥ 4，items 带必要字段', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await writeAll(svc, NODE_PARAPHRASES);
      const scan = await svc.dedupeScan({ threshold: 0.45 });
      assert.equal(scan.threshold, 0.45, '回传 threshold');
      const hit = scan.clusters.filter(
        (c) => c.items.some((it) => NODE_PARAPHRASES.includes(it.text)),
      );
      assert.equal(hit.length, 1, `5 句同义改写应聚成恰好 1 簇，实际 ${hit.length}`);
      assert.ok(hit[0].size >= 4, `簇 size 应 ≥4，实际 ${hit[0].size}`);
      assert.ok(typeof hit[0].maxSimilarity === 'number' && hit[0].maxSimilarity >= 0.45, 'maxSimilarity 应 ≥ threshold');
      for (const it of hit[0].items) {
        for (const f of ['id', 'text', 'kind', 'status']) {
          assert.ok(it[f] !== undefined, `items 字段缺失：${f}`);
        }
      }
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('不相关事实 → 0 簇（不得虚报候选）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await writeAll(svc, UNRELATED);
      const scan = await svc.dedupeScan({ threshold: 0.45 });
      assert.equal(scan.clusters.length, 0, `不相关事实应 0 簇，实际 ${JSON.stringify(scan.clusters.map((c) => c.items?.map((i) => i.text)))}`);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('确定性：同参数两次调用输出全等', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await writeAll(svc, [...NODE_PARAPHRASES, ...REDIS_PARAPHRASES]);
      const a = await svc.dedupeScan({ threshold: 0.45 });
      const b = await svc.dedupeScan({ threshold: 0.45 });
      assert.deepEqual(b, a, 'dedupeScan 必须是只读纯函数式：两次输出应全等');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('limit 生效：多簇场景下限制返回条数且保序（maxSimilarity 降序）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await writeAll(svc, [...NODE_PARAPHRASES, ...REDIS_PARAPHRASES]);
      const full = await svc.dedupeScan({ threshold: 0.45 });
      assert.ok(full.clusters.length >= 2, `fixture 应产生 ≥2 簇，实际 ${full.clusters.length}`);
      for (let i = 1; i < full.clusters.length; i++) {
        assert.ok(full.clusters[i - 1].maxSimilarity >= full.clusters[i].maxSimilarity, '簇应按 maxSimilarity 降序');
      }
      const capped = await svc.dedupeScan({ threshold: 0.45, limit: 1 });
      assert.equal(capped.clusters.length, 1, 'limit=1 应只返回 1 簇');
      assert.deepEqual(capped.clusters[0], full.clusters[0], 'limit 截断应保留 top1（保序）');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('unstructured 与结构化 slot 都能分簇', async () => {
    const { svc, memoHome } = await fresh();
    try {
      // unstructured：不给 subject/predicate（text/text slot）
      await writeAll(svc, NODE_PARAPHRASES);
      // 结构化：同 subject/predicate、value 措辞不同（裁决 15 场景）。
      // 写入门控侧：value 不等且词面相似度 <0.85 → disputed（同 slot 冲突）；
      // dedupeScan 侧：不筛 status（active+disputed 都进簇），仍应按 slot+相似度聚簇。
      const slotTexts = ['Redis primary cache', 'cache store uses Redis replicas', 'Redis backs the cache layer'];
      for (const v of slotTexts) {
        const res = await svc.write({
          text: v,
          subject: 'infra.cache',
          predicate: 'backend',
          value: v,
          source: { agent: 'test' },
        });
        assert.ok(
          res.action === 'created' || res.action === 'disputed',
          `结构化 fixture 写入应 created 或 disputed（同 slot 换措辞），实际 ${res.action}`,
        );
      }
      const scan = await svc.dedupeScan({ threshold: 0.45 });
      const nodeCluster = scan.clusters.find((c) => c.items.some((it) => NODE_PARAPHRASES.includes(it.text)));
      const slotCluster = scan.clusters.find((c) => c.items.some((it) => slotTexts.includes(it.text)));
      assert.ok(nodeCluster && nodeCluster.size >= 4, `unstructured 组应成簇，实际 ${JSON.stringify(scan.clusters.map((c) => c.items?.length))}`);
      assert.ok(slotCluster && slotCluster.size >= 2, `结构化 slot（infra.cache/backend）应成簇，实际 ${JSON.stringify(scan.clusters.map((c) => c.items?.length))}`);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('只读：dedupeScan 不得改变任何记录或 stats', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await writeAll(svc, NODE_PARAPHRASES);
      const before = await svc.stats();
      await svc.dedupeScan({ threshold: 0.45 });
      await svc.dedupeScan({ threshold: 0.9, limit: 2 });
      const after = await svc.stats();
      assert.deepEqual(after, before, 'dedupeScan 是只读 API（裁决 22），不得改数据');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});

describe('裁决 26：CJK 二元组 Dice 候选度量', () => {
  test('signatureSimilarity：中文改写召回、无关不虚报、非中文返回 0', async () => {
    const { signatureSimilarity, charBigrams } = await import('../../src/hygiene/conflict.js');
    // 共享名词的改写：containment 也能到 0.55+，Dice 亦高
    assert.ok(signatureSimilarity('部署脚本在 scripts/deploy.sh', '上线脚本位于 scripts/deploy.sh') > 0.15);
    // 内容词全换：containment = 0，只有 Dice 能到 0.15+
    const a = '生产环境禁止直连数据库';
    const b = '线上环境不允许直接连接数据库';
    assert.ok(signatureSimilarity(a, b) >= 0.15, `containment=0 的中文改写必须被 Dice 召回，实际 ${signatureSimilarity(a, b)}`);
    // 无关中文事实不得虚报
    assert.ok(signatureSimilarity('数据库连接池上限是 20', '发布窗口限定工作日晚上') < 0.15);
    // 纯英文 → 0（英文交给 containment；全字符 Dice 会把无关英文对推到 0.2+，实测 13.68% 误聚）
    assert.equal(signatureSimilarity('The cache backend is Redis', 'Deploy uses Kubernetes'), 0);
    assert.equal(signatureSimilarity('', ''), 0);
    // 单字汉字段也能成 gram（不抛错、不返回空集）
    assert.equal(charBigrams('池').size, 1);
  });

  test('dedupeScan 输出带 pairs 逐对依据（basis/strength/metrics/diceThreshold）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await writeAll(svc, ['生产环境禁止直连数据库', '线上环境不允许直接连接数据库']);
      const scan = await svc.dedupeScan({});
      assert.ok(scan.diceThreshold > 0, 'scan 结果必须回显 diceThreshold');
      const c = scan.clusters.find((x) => x.size >= 2);
      assert.ok(c, 'containment=0 的中文改写对必须成簇（否则 Dice 路失效）');
      assert.ok(Array.isArray(c.pairs) && c.pairs.length >= 1, '簇必须带 pairs');
      const p = c.pairs[0];
      assert.equal(typeof p.aId, 'string');
      assert.equal(typeof p.bId, 'string');
      assert.equal(p.containment, 0);
      assert.ok(p.dice >= 0.15);
      assert.equal(p.basis, 'dice');
      assert.ok(['strong', 'weak'].includes(p.strength));
      assert.ok(c.metrics && typeof c.metrics.maxDice === 'number', '簇必须带 metrics');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('diceThreshold 可关：设为极大值时中文改写不再成簇（度量可插拔）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await writeAll(svc, ['生产环境禁止直连数据库', '线上环境不允许直接连接数据库']);
      const scan = await svc.dedupeScan({ diceThreshold: 1 });
      assert.equal(scan.clusters.length, 0, 'Dice 阈值调到 1 后 containment=0 的对不应成簇');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
