import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import {
  curatePrompt, curateStatus, curateApplyFile, validateDecisions, pairKeyOf,
} from '../../src/cli/curate.js';

// docs/10-curate-auto.md §8：curate-prompt 五条单测
// 3 组中文改写（每组 2 条）→ dedupeScan 成簇 → 任务包 / apply / status 全链路
const GROUPS = [
  ['生产环境禁止直连数据库', '线上环境不允许直接连接数据库'],
  ['部署脚本在 scripts/deploy.sh', '上线脚本位于 scripts/deploy.sh'],
  ['构建命令为 pnpm run build', '编译命令是 pnpm run build'],
];

async function fresh() {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-curate-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:unit-curate' });
  return { svc, memoHome };
}

async function writeAll(svc, texts) {
  for (const text of texts) {
    const res = await svc.write({ text, source: { agent: 'test' } });
    assert.equal(res.action, 'created', `fixture 写入应 created：${text}`);
  }
}

async function withFixtured(fn) {
  const { svc, memoHome } = await fresh();
  try {
    const texts = GROUPS.flat();
    await writeAll(svc, texts);
    return await fn(svc, memoHome);
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
}

describe('memo curate prompt（docs/10 §8）', () => {
  test('1. 空库 → pairs: []，不写任务包，不抛错', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const out = await curatePrompt(svc, { json: true });
      assert.deepEqual(out.pairs, [], '空库任务包 pairs 应为空数组');
      assert.equal(out.batchId, null, '空库不生成 batchId');
      assert.equal(out.written, false, '空库不写盘');
      assert.ok(!existsSync(join(memoHome, 'curate')), '空库不建 curate 目录');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('2. 有候选 → 任务包 JSON 字段齐全且落盘两份', () => withFixtured(async (svc, memoHome) => {
    const out = await curatePrompt(svc, { json: true });
    assert.ok(out.batchId && out.batchId.startsWith('batch-'), `batchId 形如 batch-<ISO>-<rand>，实际 ${out.batchId}`);
    assert.ok(out.mdPath && existsSync(out.mdPath), '.md 任务包必须落盘');
    assert.ok(out.jsonPath && existsSync(out.jsonPath), '.json 机读副本必须落盘');
    const pkg = JSON.parse(readFileSync(out.jsonPath, 'utf8'));
    assert.equal(pkg.batchId, out.batchId);
    assert.equal(pkg.scope, svc.scope);
    assert.ok(Array.isArray(pkg.decisions) && pkg.decisions.length === 0, 'decisions 初始为空待回填');
    assert.ok(pkg.pairs.length >= 3, `3 组改写应产生 ≥3 对，实际 ${pkg.pairs.length}`);
    for (const p of pkg.pairs) {
      assert.equal(typeof p.ids[0], 'string');
      assert.equal(typeof p.ids[1], 'string');
      assert.ok(['strong', 'weak'].includes(p.strength), `strength 必须 strong|weak，实际 ${p.strength}`);
      assert.ok(typeof p.containment === 'number' && typeof p.dice === 'number');
      assert.ok(p.a && typeof p.a.text === 'string' && p.b && typeof p.b.text === 'string');
    }
    // 任务包 pairs 直接取自 dedupeScan（不二次计算）：ids 必须能在 scan 里找到同对
    const scan = await svc.dedupeScan({});
    const scanKeys = new Set(scan.clusters.flatMap((c) => (c.pairs ?? [])
      .map((p) => [p.aId, p.bId].sort().join(','))));
    for (const p of pkg.pairs) {
      assert.ok(scanKeys.has([...p.ids].sort().join(',')), `pair ${p.ids} 必须来自 dedupeScan`);
    }
  }));
});

describe('memo curate apply 校验与幂等（docs/10 §4/§8）', () => {
  test('3. 未知 batchId / 非法 decision / ids 不符 / 重复 pair 各自被拒，且库未变', () => withFixtured(async (svc, memoHome) => {
    const out = await curatePrompt(svc, { json: true });
    const pkgPath = out.jsonPath;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const pair = pkg.pairs[0];
    const before = await svc.stats();
    

    const cases = [
      { name: '未知 batchId', body: { batchId: 'batch-nope-0000', decisions: [{ ids: pair.ids, decision: 'merge' }] } },
      { name: '非法 decision', body: { batchId: pkg.batchId, decisions: [{ ids: pair.ids, decision: 'yes' }] } },
      { name: 'ids 不符', body: { batchId: pkg.batchId, decisions: [{ ids: ['01AAAAAAAAAAAAAAAAAAAAAAAAAAA', '01BBBBBBBBBBBBBBBBBBBBBBBBBBB'], decision: 'merge' }] } },
      { name: '重复 pair', body: { batchId: pkg.batchId, decisions: [
        { ids: pair.ids, decision: 'merge' },
        { ids: [...pair.ids].reverse(), decision: 'keep_both' },
      ] } },
    ];
    for (const c of cases) {
      const tmp = join(memoHome, `case-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(tmp, JSON.stringify(c.body));
      await assert.rejects(
        () => curateApplyFile(svc, tmp),
        (e) => e.code === 'E_INVALID_ARG' && e.message.length > 0,
        `${c.name} 应被 E_INVALID_ARG 拒绝且带人话原因`,
      );
      rmSync(tmp);
    }
    // 校验失败的文件不是合法 JSON → V1
    const bad = join(memoHome, 'bad.json');
    writeFileSync(bad, '{not json');
    await assert.rejects(() => curateApplyFile(svc, bad), (e) => e.code === 'E_INVALID_ARG');
    rmSync(bad);
    assert.deepEqual(await svc.stats(), before, '任一校验失败：一条都不写，库未变');
  }));

  test('4. 幂等：同一 decisions 应用两次 → 第二次 applied=0', () => withFixtured(async (svc) => {
    const out = await curatePrompt(svc, { json: true });
    const pkg = JSON.parse(readFileSync(out.jsonPath, 'utf8'));
    pkg.decisions = pkg.pairs.map((p) => ({ ids: p.ids, decision: 'merge', note: 'unit' }));
    const decisionsPath = out.jsonPath;
    writeFileSync(decisionsPath, JSON.stringify(pkg));
    const first = await curateApplyFile(svc, decisionsPath);
    assert.equal(first.applied, pkg.decisions.length, '首次全部 applied');
    const second = await curateApplyFile(svc, decisionsPath);
    assert.equal(second.applied, 0, `第二次 applied 应为 0，实际 ${second.applied}`);
    assert.equal(second.skipped, pkg.decisions.length, '第二次全部 skipped');
  }));

  test('5. status：未开始 / 部分 / 完成三种状态', () => withFixtured(async (svc) => {
    const out = await curatePrompt(svc, { json: true });
    const pkg = JSON.parse(readFileSync(out.jsonPath, 'utf8'));

    // 未开始
    let st = await curateStatus(svc);
    let row = st.rows.find((r) => r.batchId === pkg.batchId);
    assert.ok(row, 'status 应列出该批次');
    assert.equal(row.state, '未开始');
    assert.equal(row.decided, 0);

    // 部分：只应用第一对
    pkg.decisions = [{ ids: pkg.pairs[0].ids, decision: 'merge' }];
    writeFileSync(out.jsonPath, JSON.stringify(pkg));
    await curateApplyFile(svc, out.jsonPath);
    st = await curateStatus(svc);
    row = st.rows.find((r) => r.batchId === pkg.batchId);
    assert.equal(row.decided, 1, `部分应用后已裁决应为 1，实际 ${row.decided}`);
    assert.equal(row.state, '进行中');

    // 完成：补齐其余
    pkg.decisions = pkg.pairs.map((p) => ({ ids: p.ids, decision: 'merge' }));
    writeFileSync(out.jsonPath, JSON.stringify(pkg));
    await curateApplyFile(svc, out.jsonPath);
    st = await curateStatus(svc);
    row = st.rows.find((r) => r.batchId === pkg.batchId);
    assert.equal(row.decided, row.total);
    assert.equal(row.state, '已完成');
  }));
});

describe('validateDecisions（纯函数）', () => {
  const pkg = { batchId: 'b', pairs: [{ ids: ['A', 'B'] }, { ids: ['C', 'D'] }] };
  test('合法输入通过', () => {
    assert.equal(validateDecisions(pkg, [{ ids: ['B', 'A'], decision: 'keep_both' }]).ok, true);
  });
  test('非对象 decision / 空 ids / 顺序无关匹配 / 重复均拒绝', () => {
    assert.throws(() => validateDecisions(pkg, [null]), (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => validateDecisions(pkg, [{ ids: ['A'], decision: 'merge' }]), (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => validateDecisions(pkg, [{ ids: ['A', 'X'], decision: 'merge' }]), (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => validateDecisions(pkg, [
      { ids: ['A', 'B'], decision: 'merge' }, { ids: ['B', 'A'], decision: 'keep_both' },
    ]), /重复/);
  });

  test('8. 已裁决的 pair 不再进新批次（prompt 必须收敛）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      // 造一组中文改写，两两近似 → 至少 1 簇
      await svc.write({ text: '真相层是只追加的 JSONL，不允许就地改写', source: { agent: 'test' } });
      await svc.write({ text: '记忆底层是只追加的 JSONL 文件，不能原地修改', source: { agent: 'test' } });
      const pkg1 = await curatePrompt(svc, { json: true });
      assert.ok(pkg1.pairs && pkg1.pairs.length >= 1, '首轮应有候选');
      const target = pkg1.pairs[0];
      const file = join(memoHome, 'curate', `${pkg1.batchId}.json`);
      // 回填并应用
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      parsed.decisions = [{ ids: target.ids, decision: 'keep_both', note: '两条不同维度' }];
      writeFileSync(file, JSON.stringify(parsed));
      await curateApplyFile(svc, file);

      // 第二轮：同一对不应再出现（否则批次无限增长）
      const pkg2 = await curatePrompt(svc, { json: true });
      const again = (pkg2.pairs || []).filter((p) => pairKeyOf(p.ids) === pairKeyOf(target.ids));
      assert.equal(again.length, 0, '已裁决的 pair 不得重发');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
