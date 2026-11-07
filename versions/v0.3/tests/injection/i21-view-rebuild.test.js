// tests/injection/i21-view-rebuild.test.js — I21 视图重建字节相同（issue #50）
// 验收（研究文档 §4A）：删掉整个 views/ 目录后用同一真相层重建，L2.jsonl 与
// meta.json 逐字节相同——视图是派生物不是真相（决策 D2）。同时守恒校验：
// sum(block.recordIds.length) === sourceCount，一条记录只进一个块。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { buildL2, writeL2, readL2, viewDir } from '../../src/views/l2.js';
import { loadPolicy } from '../../src/config/policy.js';

test('I21 视图重建：12 条真实记录 → 删 views 目录 → 重建字节相同', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i21-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i21' });
    const writes = [];

    // 同 slot 两条（subject/predicate 显式）：值不可比 → 第二条 disputed，
    // 两条都进真相层，exportRecords(status:'all') 一并取出，slot 块因此有 2 条
    writes.push(svc.write({
      text: 'strata 的依赖策略是零运行时依赖', kind: 'decision',
      subject: 'strata', predicate: 'dependency-policy',
      value: 'zero-runtime-deps', source: { agent: 'test' },
    }));
    writes.push(svc.write({
      text: '依赖策略补充：第三方包一律不引入', kind: 'decision',
      subject: 'strata', predicate: 'dependency-policy',
      value: 'no-third-party-packages', source: { agent: 'test' },
    }));

    // 无 slot 的中文改写两条（subject/predicate 默认 text/text）：
    // 措辞差异足够大（写门槛 containment≥0.85 不命中 → 两条都 created），
    // 但字符二元组 Dice ≥0.15 → clusterNearDuplicates 聚成候选块
    writes.push(svc.write({ text: '项目必须坚持零运行时依赖的实现方式', kind: 'fact', source: { agent: 'test' } }));
    writes.push(svc.write({ text: '本项目必须坚持零运行时依赖，只用内置模块', kind: 'fact', source: { agent: 'test' } }));

    // 其余 8 条：结构化单值事实，覆盖多种 kind
    const slots = [
      ['strata', 'version', '0.3.0'],
      ['strata', 'module-lifecycle', 'fsync-before-rename'],
      ['strata', 'test-runner', 'node-test'],
      ['team', 'release-cadence', 'biweekly'],
      ['build', 'node-major', '22'],
      ['repo', 'license', 'proprietary'],
      ['agent', 'default-model', 'glm'],
      ['docs', 'contract-source', 'docs-02'],
    ];
    for (let i = 0; i < slots.length; i++) {
      const [s, p, v] = slots[i];
      writes.push(svc.write({
        text: `${s}/${p} = ${v}`, kind: i % 2 === 0 ? 'fact' : 'state',
        subject: s, predicate: p, value: v, source: { agent: 'test' },
      }));
    }
    const results = await Promise.all(writes);
    assert.equal(results.length, 12);

    const { records } = await svc.exportRecords({ status: 'all', limit: 100 });
    assert.equal(records.length, 12, `真相层应有 12 条，实际 ${records.length}`);

    const policy = loadPolicy();
    const scope = 'repo:eval-i21';
    const dir = viewDir(memoHome, scope);

    // 第一次构建 + 落盘
    writeL2(memoHome, scope, buildL2(records, { scope, policy }));
    assert.ok(existsSync(join(dir, 'L2.jsonl')));
    const jsonl1 = readFileSync(join(dir, 'L2.jsonl'));
    const meta1 = readFileSync(join(dir, 'meta.json'));

    // 守恒：每条记录恰好出现在一个块里
    const view1 = readL2(memoHome, scope);
    assert.equal(view1.blocks.reduce((n, b) => n + b.recordIds.length, 0), view1.sourceCount);
    assert.equal(view1.sourceCount, 12);
    assert.equal(new Set(view1.blocks.flatMap((b) => b.recordIds)).size, 12);

    // 同 slot 两条 → dependency-policy 这个 slot 块恰有 2 条
    const slotBlock = view1.blocks.find((b) => b.key.startsWith('slot:'));
    assert.ok(slotBlock, '应存在 slot 块');
    // normalizeText 把 '-' 归一成空格 → key 为 slot:strata\u0001dependency policy
    const depBlock = view1.blocks.find((b) => b.key === 'slot:strata\u0001dependency policy');
    assert.ok(depBlock, '应存在 dependency-policy slot 块');
    assert.equal(depBlock.recordIds.length, 2, `同 slot 两条应聚在一个块，实际 ${depBlock.recordIds.length}`);

    // 删整个 views 目录 → 重建 → 字节完全相同
    rmSync(join(memoHome, 'views'), { recursive: true, force: true });
    assert.equal(readL2(memoHome, scope), null);
    writeL2(memoHome, scope, buildL2(records, { scope, policy }));
    const jsonl2 = readFileSync(join(dir, 'L2.jsonl'));
    const meta2 = readFileSync(join(dir, 'meta.json'));
    assert.deepEqual(jsonl2, jsonl1, '重建后 L2.jsonl 必须逐字节相同');
    assert.deepEqual(meta2, meta1, '重建后 meta.json 必须逐字节相同');
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
