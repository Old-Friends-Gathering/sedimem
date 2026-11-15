// tests/unit/ledger-brief.test.js — B2 任务简报（versions/v1.2/src/session/ledger-brief.js）
// 覆盖（SPEC §5 + lead 验收口径）：
//   - asOf 冻结：quarantined 段与 createdAt > asOf 的段一律不采用，按 kind 聚合进 excluded；
//   - 决策/卡点/引用/下一步只来自合规段，且排序确定（fromSeq 升序，同序 segment.id）；
//   - 同一输入 + 同一 clock 两次调用 JSON.stringify 逐字节相同；
//   - maxChars 很小时 truncated===true，excluded 里有 budget 行，usedChars 不超预算；
//   - 空账本返回全空数组而不是抛错；task.title/state 从 meta.json 读。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendSegment } from '../../src/session/ledger.js';
import { newId } from '../../src/core/ids.js';
import {
  DEFAULT_MAX_CHARS, briefJson, renderBriefText,
} from '../../src/session/ledger-brief.js';

const TASK_ID = '20261115-0944-abcd';
const AS_OF_MS = Date.parse('2026-11-15T12:00:00.000Z');
const AS_OF_ISO = new Date(AS_OF_MS).toISOString();
const BEFORE = new Date(Date.parse('2026-11-15T00:00:00.000Z')).toISOString();
const FUTURE = new Date(Date.parse('2026-11-16T00:00:00.000Z')).toISOString();

/** 固定时钟：简报里不允许出现 Date.now，generatedAt 必须可预测 */
const clock = { nowMs: () => AS_OF_MS, now: () => AS_OF_ISO };

let home;
let anchorPath;
let idCounter = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memo-brief-'));
  anchorPath = join(home, 'anchor.jsonl');
  writeFileSync(anchorPath, '{"seq":1}\n');
  idCounter = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** 合法段 fixture（appendSegment 只校验区间/anchor/summary，其余字段宽容） */
function makeSegment(fromSeq, toSeq, over = {}) {
  idCounter += 1;
  return {
    id: `seg_${newId(AS_OF_MS + idCounter)}`,
    taskId: TASK_ID,
    fromSeq,
    toSeq,
    createdAt: BEFORE,
    source: { kind: 'dsh', path: anchorPath, sessionId: 'sess-1', frames: 1 },
    anchor: { path: anchorPath, fromSeq, toSeq },
    summary: `段 [${fromSeq}, ${toSeq}) 摘要`,
    facts: [],
    decisions: [],
    gotchas: [],
    pendingJobs: [],
    files: [],
    nextSteps: [],
    tokens: null,
    trust: 'T1',
    taint: [],
    quarantined: false,
    mode: 'rules',
    ...over,
  };
}

/** 故意乱序 append（180 先于 100），证明简报自己按 fromSeq 排序而不是依赖文件顺序 */
async function seedShuffledLedger() {
  mkdirSync(join(home, 'sessions', TASK_ID), { recursive: true });
  writeFileSync(
    join(home, 'sessions', TASK_ID, 'meta.json'),
    JSON.stringify({ title: '账本简报测试', closedAt: null }),
  );

  const seg1 = makeSegment(100, 120, {
    summary: '第一段摘要',
    decisions: ['决定采用 A 方案'],
    gotchas: ['注意锁顺序'],
    files: ['src/session/a.js'],
    nextSteps: ['实现 B'],
  });
  const seg2 = makeSegment(120, 140, {
    summary: '第二段摘要',
    decisions: ['改用 B 缓存'],
    files: ['src/session/b.js'],
    nextSteps: ['跑测试'],
  });
  const seg3 = makeSegment(140, 160, {
    summary: '被隔离的段',
    quarantined: true,
    decisions: ['恶意决策'],
    gotchas: ['恶意坑'],
    files: ['src/evil.js'],
    nextSteps: ['恶意下一步'],
  });
  const seg4 = makeSegment(160, 180, {
    createdAt: FUTURE,
    summary: '未来段',
    decisions: ['未来决策'],
    gotchas: ['未来坑'],
    files: ['src/nope.js'],
    nextSteps: ['未来下一步'],
  });
  const seg5 = makeSegment(180, 200, {
    summary: '第五段摘要',
    decisions: ['决定关闭 C'],
    gotchas: ['坑 C'],
    files: ['src/session/a.js'], // 与 seg1 重复：references 按文件去重，保留最早段
    nextSteps: ['收尾'],
  });

  for (const segment of [seg5, seg1, seg3, seg4, seg2]) {
    await appendSegment({ memoHome: home, taskId: TASK_ID, segment, clock });
  }
  return { seg1, seg2, seg3, seg4, seg5 };
}

describe('ledger-brief: asOf 冻结 + quarantine + 确定性', () => {
  test('决策/卡点/引用/下一步只来自合规段，quarantine 与 future 按 kind 聚合', async () => {
    const { seg1, seg2, seg5 } = await seedShuffledLedger();

    const brief = briefJson({ memoHome: home, taskId: TASK_ID, clock });

    // 排序：fromSeq 升序（文件里是乱序 append 的），future/quarantined 段的内容一条都不许出现
    assert.deepEqual(brief.decisions, [
      { text: '决定采用 A 方案', segmentId: seg1.id, fromSeq: 100 },
      { text: '改用 B 缓存', segmentId: seg2.id, fromSeq: 120 },
      { text: '决定关闭 C', segmentId: seg5.id, fromSeq: 180 },
    ]);
    assert.deepEqual(brief.gotchas, [
      { text: '注意锁顺序', segmentId: seg1.id, fromSeq: 100 },
      { text: '坑 C', segmentId: seg5.id, fromSeq: 180 },
    ]);
    assert.deepEqual(brief.nextSteps, [
      { text: '实现 B', segmentId: seg1.id, fromSeq: 100 },
      { text: '跑测试', segmentId: seg2.id, fromSeq: 120 },
      { text: '收尾', segmentId: seg5.id, fromSeq: 180 },
    ]);
    // references：只来自合规段；同一文件取最早段
    assert.deepEqual(brief.references, [
      { file: 'src/session/a.js', segmentId: seg1.id },
      { file: 'src/session/b.js', segmentId: seg2.id },
    ]);

    assert.deepEqual(brief.excluded, [
      { kind: 'segment', reason: 'quarantined', count: 1 },
      { kind: 'segment', reason: 'future', count: 1 },
    ]);
    assert.deepEqual(brief.segments, { total: 5, used: 3, quarantined: 1 });
    assert.equal(brief.budget.truncated, false);
    assert.equal(brief.budget.maxChars, DEFAULT_MAX_CHARS);
    assert.ok(brief.budget.usedChars > 0);

    // summary = 最近 3 段的段摘要（按 fromSeq 顺序）
    assert.equal(brief.summary, '第一段摘要\n第二段摘要\n第五段摘要');

    // 任务元信息
    assert.deepEqual(brief.task, { id: TASK_ID, title: '账本简报测试', state: 'open' });
    assert.equal(brief.generatedAt, AS_OF_ISO, 'generatedAt 来自注入 clock，不是 Date.now');

    // quarantine/future 段里的内容一个字都不能泄漏
    const serialized = JSON.stringify(brief);
    assert.ok(!serialized.includes('恶意'), 'quarantined 段内容不得进入简报');
    assert.ok(!serialized.includes('未来'), 'future 段内容不得进入简报');
    assert.ok(!serialized.includes('src/evil.js'));
    assert.ok(!serialized.includes('src/nope.js'));
  });

  test('同一输入 + 同一 clock 两次调用 JSON.stringify 逐字节相同', async () => {
    await seedShuffledLedger();
    const a = briefJson({ memoHome: home, taskId: TASK_ID, clock });
    const b = briefJson({ memoHome: home, taskId: TASK_ID, clock: { now: () => AS_OF_ISO } });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    // 附带：文本渲染也稳定（CLI/MCP 复用同一个渲染器）
    assert.equal(renderBriefText(a), renderBriefText(b));
    assert.match(renderBriefText(a), /— 决策 —/);
    assert.match(renderBriefText(a), /决定采用 A 方案/);
  });

  test('asOf 显式早于所有段 → 全部归入 future，不采用任何段', async () => {
    await seedShuffledLedger();
    const brief = briefJson({
      memoHome: home, taskId: TASK_ID, asOf: '2026-11-14T00:00:00.000Z', clock,
    });
    assert.deepEqual(brief.decisions, []);
    assert.deepEqual(brief.summary, '');
    assert.deepEqual(brief.segments, { total: 5, used: 0, quarantined: 1 });
    assert.deepEqual(brief.excluded, [
      { kind: 'segment', reason: 'quarantined', count: 1 },
      { kind: 'segment', reason: 'future', count: 4 },
    ]);
  });
});

describe('ledger-brief: 预算', () => {
  test('maxChars 很小时 truncated===true，excluded 有 budget 行，usedChars 不超预算', async () => {
    await seedShuffledLedger();

    const brief = briefJson({ memoHome: home, taskId: TASK_ID, clock, maxChars: 10 });

    assert.equal(brief.budget.truncated, true);
    assert.equal(brief.budget.maxChars, 10);
    assert.equal(brief.budget.usedChars, 9, '只有第一条决策「决定采用 A 方案」= 9 字放得进去');
    assert.ok(brief.budget.usedChars <= brief.budget.maxChars);
    assert.equal(brief.decisions.length, 1);
    assert.deepEqual(brief.gotchas, []);
    assert.deepEqual(brief.nextSteps, []);
    assert.deepEqual(brief.references, []);

    const budgetRows = brief.excluded.filter((r) => r.kind === 'budget');
    assert.deepEqual(budgetRows, [
      { kind: 'budget', reason: 'maxChars', count: 2 }, // decisions 丢 2
      { kind: 'budget', reason: 'maxChars', count: 2 }, // gotchas 丢 2
      { kind: 'budget', reason: 'maxChars', count: 3 }, // nextSteps 丢 3
      { kind: 'budget', reason: 'maxChars', count: 2 }, // references 丢 2
    ]);
    // 段级排除行仍在 budget 行之前
    assert.deepEqual(brief.excluded.slice(0, 2), [
      { kind: 'segment', reason: 'quarantined', count: 1 },
      { kind: 'segment', reason: 'future', count: 1 },
    ]);
  });

  test('maxChars=0：全部内容段为空、预算行覆盖所有条目', async () => {
    await seedShuffledLedger();
    const brief = briefJson({ memoHome: home, taskId: TASK_ID, clock, maxChars: 0 });
    assert.equal(brief.budget.truncated, true);
    assert.equal(brief.budget.usedChars, 0);
    assert.deepEqual(brief.decisions, []);
    assert.deepEqual(brief.gotchas, []);
    assert.deepEqual(brief.nextSteps, []);
    assert.deepEqual(brief.references, []);
  });
});

describe('ledger-brief: 空账本 / 任务元信息', () => {
  test('空账本（任务目录不存在）返回全空数组而不是抛错', () => {
    const emptyTaskId = '20261115-0000-none';
    const brief = briefJson({ memoHome: home, taskId: emptyTaskId, clock });

    assert.deepEqual(brief.task, { id: emptyTaskId, title: null, state: 'open' });
    assert.deepEqual(brief.summary, '');
    assert.deepEqual(brief.decisions, []);
    assert.deepEqual(brief.gotchas, []);
    assert.deepEqual(brief.references, []);
    assert.deepEqual(brief.nextSteps, []);
    assert.deepEqual(brief.excluded, []);
    assert.deepEqual(brief.budget, { maxChars: DEFAULT_MAX_CHARS, usedChars: 0, truncated: false });
    assert.deepEqual(brief.segments, { total: 0, used: 0, quarantined: 0 });
    assert.equal(brief.generatedAt, AS_OF_ISO);
  });

  test('meta.closedAt 存在 → state=closed；meta 无 title → title=null', () => {
    const taskId = '20261115-0000-clsd';
    mkdirSync(join(home, 'sessions', taskId), { recursive: true });
    writeFileSync(
      join(home, 'sessions', taskId, 'meta.json'),
      JSON.stringify({ closedAt: BEFORE }),
    );
    const brief = briefJson({ memoHome: home, taskId, clock });
    assert.equal(brief.task.state, 'closed');
    assert.equal(brief.task.title, null);
  });

  test('参数校验：bad taskId / bad maxChars / bad asOf 抛 E_INVALID_ARG', () => {
    assert.throws(() => briefJson({ memoHome: home, taskId: '', clock }),
      (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => briefJson({ memoHome: home, taskId: TASK_ID, clock, maxChars: -1 }),
      (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => briefJson({ memoHome: home, taskId: TASK_ID, clock, asOf: 'not-a-date' }),
      (e) => e.code === 'E_INVALID_ARG');
  });
});
