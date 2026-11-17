// I55 — 简报确定性：同一账本 + 固定 clock 两次 briefJson 逐字节相同，且过滤规则可解释
// 钉住：
//   1. JSON.stringify(briefJson(...)) 两次完全相等（排序/去重/预算都确定，不依赖 System 时间或 Map 顺序）
//   2. quarantined 段与 createdAt > asOf 的段内容不出现在输出里，excluded 里各有对应计数
//   3. maxChars 很小时 budget.truncated === true，且 budget.maxChars 如实回显

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendSegment } from '../../src/session/ledger.js';
import { briefJson } from '../../src/session/ledger-brief.js';

const TASK_ID = '20261115-1002-i55a';
const AS_OF = '2026-11-15T00:05:00.000Z';
const CLOCK = { now: () => AS_OF, nowMs: () => Date.parse(AS_OF) };
const QUARANTINE_MARK = 'I55-隔离段-不应出现';
const FUTURE_MARK = 'I55-未来段-不应出现';

async function seedFiveSegments(memoHome) {
  for (let i = 0; i < 5; i++) {
    const quarantined = i === 2;
    const future = i === 4;
    await appendSegment({
      memoHome,
      taskId: TASK_ID,
      clock: CLOCK,
      segment: {
        fromSeq: i,
        toSeq: i + 1,
        createdAt: future ? '2026-11-15T01:00:00.000Z' : `2026-11-15T00:00:0${i}.000Z`,
        anchor: { path: `/tmp/i55-anchor-${i}.jsonl`, fromSeq: i, toSeq: i + 1 },
        summary: `段 ${i} 摘要：I55-摘要-${i}`,
        decisions: [quarantined
          ? `${QUARANTINE_MARK}：这条结论来自被隔离的段`
          : future ? `${FUTURE_MARK}：这条结论晚于 asOf` : `I55-决策-${i} 决定采用方案 ${i} 并记录`],
        gotchas: [`I55-卡点-${i} 注意该方案的第 ${i} 个边界`],
        files: [`src/i55-seg-${i}.js`],
        quarantined,
      },
    });
  }
}

test('I55 简报逐字节确定、quarantined/future 被排除、小预算标记 truncated', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i55-'));
  const memoHome = path.join(root, 'home');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await seedFiveSegments(memoHome);

  // 1) 确定性：同一输入 + 同一 clock，两次调用完全相等（含 generatedAt 键序）
  const a = await briefJson({ memoHome, taskId: TASK_ID, asOf: AS_OF, clock: CLOCK });
  const b = await briefJson({ memoHome, taskId: TASK_ID, asOf: AS_OF, clock: CLOCK });
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'briefJson 必须对同一输入逐字节确定');
  assert.deepEqual(b, a);

  // 2) 过滤：quarantined 段与晚于 asOf 的段内容都不出现，excluded 有对应计数
  const rendered = JSON.stringify(a);
  assert.ok(!rendered.includes(QUARANTINE_MARK), `被隔离段的内容不得出现在简报里: ${rendered}`);
  assert.ok(!rendered.includes(FUTURE_MARK), `晚于 asOf 的段内容不得出现在简报里: ${rendered}`);
  assert.deepEqual(a.segments, { total: 5, used: 3, quarantined: 1 });
  const quarantineExcluded = a.excluded.find((x) => x.kind === 'segment' && x.reason === 'quarantined');
  assert.ok(quarantineExcluded, `excluded 应记录隔离段: ${JSON.stringify(a.excluded)}`);
  assert.equal(quarantineExcluded.count, 1);
  const futureExcluded = a.excluded.find((x) => x.kind === 'segment' && x.reason === 'future');
  assert.ok(futureExcluded, `excluded 应记录未来段: ${JSON.stringify(a.excluded)}`);
  assert.equal(futureExcluded.count, 1);
  assert.equal(a.budget.truncated, false);
  assert.equal(a.decisions.length, 3, `只有 3 个可用段有 decisions: ${JSON.stringify(a.decisions)}`);

  // 3) 小预算：一条都放不下 → truncated true，maxChars 如实回显，且仍有 budget/maxChars 计数
  const tight = await briefJson({ memoHome, taskId: TASK_ID, asOf: AS_OF, maxChars: 8, clock: CLOCK });
  assert.equal(tight.budget.maxChars, 8);
  assert.equal(tight.budget.truncated, true, `maxChars=8 必须截断: ${JSON.stringify(tight.budget)}`);
  assert.equal(tight.decisions.length, 0);
  assert.ok(tight.excluded.some((x) => x.kind === 'budget' && x.reason === 'maxChars'),
    `excluded 应记录预算截断: ${JSON.stringify(tight.excluded)}`);
  assert.ok(tight.budget.usedChars <= 8);
});
