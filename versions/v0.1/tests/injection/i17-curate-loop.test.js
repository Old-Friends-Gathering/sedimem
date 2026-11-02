// tests/injection/i17-curate-loop.test.js — I17：curate 裁决任务包闭环
// 契约：docs/10-curate-auto.md §8 注入用例：
//   prompt 生成任务包（batchId + 落盘 JSON）→ 读包填 decisions（merge）→ 写回 → apply
//   → applied>0、active 收敛（≤3）、真相层行数 ≥6（原行全留）、幂等重放 applied=0/skipped>0、
//   再 dedupeScan 无候选簇。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { curatePrompt, curateApplyFile } from '../../src/cli/curate.js';

// 3 组中文同义改写（每组 2 条；组间主题互不重叠，沿用 I12 已验证可聚类的语料）
const GROUPS = [
  ['部署脚本在 scripts/deploy.sh', '上线脚本位于 scripts/deploy.sh'],
  ['缓存命中率低于 60% 要报警', '缓存命中率不足 60% 时触发告警'],
  ['发布窗口限定工作日晚上', '发版只能在工作日夜间进行'],
];

function countLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
}

test('I17 curate 闭环：prompt → 填 decisions → apply → 收敛 + 幂等 + 再扫描无簇', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i17-'));
  const scope = 'repo:eval-i17';
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope });

    // 1. 造 6 条中文改写
    for (const [a, b] of GROUPS) {
      for (const text of [a, b]) {
        const res = await svc.write({ text, source: { agent: 'qa-i17' } });
        assert.ok(res, `写入必须成功：${text}`);
      }
    }
    assert.equal((await svc.stats()).active, 6, '写入门控不应误杀 6 条改写');

    // 2. curatePrompt 生成任务包
    const prompt = await curatePrompt(svc, { json: true });
    assert.ok(prompt.batchId, `任务包必须带 batchId，实际 ${JSON.stringify(prompt.batchId)}`);
    assert.ok(prompt.written, '有候选时任务包必须落盘');
    const pkgPath = join(memoHome, 'curate', `${prompt.batchId}.json`);
    assert.ok(existsSync(pkgPath), `任务包 JSON 必须存在于 ${pkgPath}`);
    assert.ok(prompt.pairs.length >= GROUPS.length,
      `任务包应至少含 ${GROUPS.length} 对，实际 ${prompt.pairs.length}`);

    // 3. 读包 → 为每对填 merge → 写回 → curateApplyFile
    const pkgText = readFileSync(pkgPath, 'utf8'); // 单次读快照，后面只基于它写回
    const pkg = JSON.parse(pkgText);
    pkg.decisions = pkg.pairs.map((p) => ({
      ids: p.ids,
      decision: 'merge',
      note: 'I17: same fact (semantic near-duplicate)',
    }));
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

    const applied = await curateApplyFile(svc, pkgPath);
    assert.ok(applied.applied > 0, `applied 必须 > 0，实际 ${JSON.stringify(applied)}`);
    assert.equal(applied.applied, pkg.decisions.length, '每对 merge 都应落盘');

    // 4. active 收敛（≤3）且真相层原行全留（行数 ≥ 6）
    const stats = await svc.stats();
    assert.ok(stats.active <= GROUPS.length,
      `merge 后 active 应收敛到 ≤${GROUPS.length}，实际 ${stats.active}`);
    // store 侧文件名用原始 scope（含冒号），见 storage/jsonl-store.js _scopePath
    const truthFile = join(memoHome, 'items', `${scope}.jsonl`);
    const lines = countLines(truthFile);
    assert.ok(lines >= 6, `真相层行数应 ≥6（原 6 行全留），实际 ${lines}`);

    // 5. 幂等：同一文件再 apply → applied=0 且 skipped>0
    const replay = await curateApplyFile(svc, pkgPath);
    assert.equal(replay.applied, 0, `重放必须 applied=0，实际 ${JSON.stringify(replay)}`);
    assert.ok(replay.skipped > 0, `重放必须 skipped>0，实际 ${JSON.stringify(replay)}`);
    assert.equal((await svc.stats()).active, stats.active, '重放不得改变 active 数');

    // 6. 再 dedupeScan：无候选簇（收敛完成，不再虚报）
    const scan = await svc.dedupeScan({});
    assert.equal(scan.clusters.length, 0,
      `收敛后再扫描不应有候选簇，实际 ${JSON.stringify(scan.clusters.map((c) => c.items.map((i) => i.text)))}`);
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
