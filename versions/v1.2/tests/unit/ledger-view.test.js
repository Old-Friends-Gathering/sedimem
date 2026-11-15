/**
 * ledger-view 单测（v1.2 B3）——任务账本三段的纯函数契约 + 源码安全检查。
 *
 * 覆盖 lead 要求的五项：空账本提示、段行数量、quarantined 标记、
 * brief 文本块渲染（pre.md）、只读禁用（捕获/归档）。
 * 另外守住 Q9：ledger-view.js 与 session-view.js 都不准出现 innerHTML/eval，
 * 且 session-view.js 不得超过 520 行（超出就必须继续拆分文件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  BRIEF_BLOCK_CLASS,
  BRIEF_BLOCK_TAG,
  EXPAND_NO_SELECT,
  LEDGER_EMPTY_BIG,
  LEDGER_EMPTY_HINT,
  READ_ONLY_HINT,
  buildBriefText,
  buildSegmentRow,
  buildSegmentRows,
  buildSummaryBadges,
  coveredLabel,
  emptyLedgerState,
  expandCommand,
  fmtBriefChars,
  fmtClock,
  modeBadge,
  normalizeBrief,
  normalizeContext,
  normalizeSegments,
  segmentRange,
  taskIdFromScope,
  truncateSummary,
  writeState,
} from '../../ui/ledger-view.js';

const SRC = await readFile(fileURLToPath(new URL('../../ui/ledger-view.js', import.meta.url)), 'utf8');
const SESSION_SRC = await readFile(fileURLToPath(new URL('../../ui/session-view.js', import.meta.url)), 'utf8');

const SEG = {
  id: 'seg-a1',
  taskId: '20261114-2221-6a5b',
  fromSeq: 1,
  toSeq: 122,
  createdAt: '2026-11-15T01:10:00.000Z',
  mode: 'rules',
  summary: '第一段摘要：核对任务页与账本契约',
  decisions: [{ text: '新增 4 个账本接口，不改旧 /api/tasks 语义' }],
  gotchas: [{ text: 'task-context.segments 是数字而不是数组' }],
  nextSteps: [{ text: '前端联调 task-segments' }],
  quarantined: false,
};

/* ---------------- ① 摘要徽标 ---------------- */

test('摘要徽标：段数 / 覆盖 / 简报字符 / 上次捕获（本地 HH:MM）', () => {
  const ctx = normalizeContext({
    task: '20261114-2221-6a5b',
    segments: 3,
    covered: [[1, 122], [122, 471]],
    briefChars: 2200,
    lastCapturedAt: '2026-11-15T09:53:00',
  });
  assert.equal(ctx.segments, 3);
  const badges = buildSummaryBadges(ctx);
  assert.deepEqual(badges.map((b) => b.key), ['segments', 'covered', 'brief', 'captured']);
  assert.equal(badges[0].label, '3 段');
  assert.equal(badges[1].label, '覆盖 1–470');
  assert.equal(badges[2].label, '简报 2.2K');
  assert.equal(badges[3].label, '上次捕获 09:53');
});

test('摘要徽标：空/畸形 context 不抛异常且给出占位', () => {
  const badges = buildSummaryBadges(null);
  assert.equal(badges[0].label, '0 段');
  assert.equal(badges[1].label, '未覆盖');
  assert.equal(badges[2].label, '简报 —');
  assert.equal(badges[3].label, '上次捕获 —');
  assert.equal(coveredLabel('oops'), '未覆盖');
  assert.equal(coveredLabel([[5, 'x']]), '未覆盖');
});

test('数字格式：简报字符数与半开区间展示', () => {
  assert.equal(fmtBriefChars(0), '—');
  assert.equal(fmtBriefChars(999), '999');
  assert.equal(fmtBriefChars(1234), '1.2K');
  assert.equal(fmtBriefChars(20000), '20K');
  assert.equal(fmtBriefChars('bad'), '—');
  assert.equal(fmtClock(''), '—');
  assert.equal(fmtClock('not-a-date'), '—');
  assert.equal(segmentRange({ fromSeq: 1, toSeq: 122 }), '1–121');
  assert.equal(segmentRange({ fromSeq: 5, toSeq: 5 }), '—');
});

/* ---------------- ② 段时间线 ---------------- */

test('段行数量：只保留合法段对象，畸形输入不产行', () => {
  assert.equal(buildSegmentRows([SEG, { ...SEG, id: 'seg-b2' }, { ...SEG, id: 'seg-c3' }]).length, 3);
  assert.equal(buildSegmentRows([SEG, null, 'oops', 42]).length, 1);
  assert.equal(buildSegmentRows(null).length, 0);
  assert.equal(buildSegmentRows(undefined).length, 0);
});

test('段行：区间 / rules|llm 徽标 / 60 字摘要截断', () => {
  const row = buildSegmentRow(SEG);
  assert.equal(row.range, '1–121');
  assert.equal(row.mode.label, 'rules');
  assert.equal(row.mode.cls, 'b-accent');
  assert.equal(row.quarantined, false);
  assert.equal(row.quarantineLabel, '');
  assert.ok(row.excerpt.startsWith('第一段摘要'));
  assert.deepEqual(row.decisions, ['新增 4 个账本接口，不改旧 /api/tasks 语义']);

  const long = 'x'.repeat(200);
  const cut = buildSegmentRow({ ...SEG, summary: long }).excerpt;
  assert.equal(Array.from(cut).length, 61, '60 字 + 省略号');
  assert.ok(cut.endsWith('…'));
  assert.equal(truncateSummary('  a\n\t b  '), 'a b', '空白折叠');
  assert.equal(modeBadge('llm').label, 'llm');
  assert.equal(modeBadge('bogus').label, 'rules', '未知 mode 兜底 rules');
});

test('quarantined 标记：true 才有 ⚠ 隔离', () => {
  const q = buildSegmentRow({ ...SEG, quarantined: true });
  assert.equal(q.quarantined, true);
  assert.equal(q.quarantineLabel, '⚠ 隔离');
  assert.equal(buildSegmentRow({ ...SEG, quarantined: false }).quarantineLabel, '');
});

test('空账本提示：无段时返回空态文案，有段时不显示', () => {
  const none = emptyLedgerState([], '');
  assert.equal(none.empty, true);
  assert.equal(none.big, LEDGER_EMPTY_BIG);
  assert.equal(none.hint, LEDGER_EMPTY_HINT);

  const failed = emptyLedgerState([], 'E_NOT_FOUND: 任务不存在');
  assert.equal(failed.empty, true);
  assert.ok(failed.hint.includes('E_NOT_FOUND'), '读取失败要把原因带进提示');

  assert.equal(emptyLedgerState([SEG]).empty, false);
  assert.equal(emptyLedgerState(null).empty, true);
});

/* ---------------- ③ 简报面板 ---------------- */

const BRIEF_WIRE = {
  ok: true,
  task: { id: '20261114-2221-6a5b', title: '任务页账本 UI', state: 'open' },
  summary: '本任务在给任务页补账本三段。',
  decisions: [{ text: '段/简报渲染拆到 ledger-view.js', segmentId: 'seg-a1', fromSeq: 1 }],
  gotchas: [{ text: 'task-context.segments 是数字', segmentId: 'seg-a1', fromSeq: 1 }],
  references: [{ file: 'ui/ledger-view.js', segmentId: 'seg-a1' }],
  nextSteps: [{ text: '联调 capture 后刷新', segmentId: 'seg-a1', fromSeq: 1 }],
  excluded: [{ kind: 'quarantined', reason: 'quarantined', count: 1 }],
  budget: { maxChars: 2200, usedChars: 2189, truncated: true },
  segments: { total: 3, used: 2, quarantined: 1 },
  generatedAt: '2026-11-15T02:00:00.000Z',
};

test('brief 文本块渲染：pre.md 常量 + 与 renderBriefText 同版式', () => {
  assert.equal(BRIEF_BLOCK_TAG, 'pre');
  assert.equal(BRIEF_BLOCK_CLASS, 'md', '简报必须渲染成 <pre class="md">');

  const brief = normalizeBrief(BRIEF_WIRE);
  assert.ok(brief, '顶层展开的 briefJson 应被识别');
  assert.equal(brief.task.title, '任务页账本 UI');
  const text = buildBriefText(brief);
  assert.ok(text.startsWith('任务 20261114-2221-6a5b：任务页账本 UI（open）'));
  assert.ok(text.includes('— 上下文接力 —'));
  assert.ok(text.includes('本任务在给任务页补账本三段。'));
  assert.ok(text.includes('— 决策 —') && text.includes('- 段/简报渲染拆到 ledger-view.js'));
  assert.ok(text.includes('— 卡点 —') && text.includes('- task-context.segments 是数字'));
  assert.ok(text.includes('— 下一步 —') && text.includes('- 联调 capture 后刷新'));
  assert.ok(text.includes('— 关键文件 —') && text.includes('- ui/ledger-view.js'));
  assert.ok(text.includes('（预算 2200 字已截断，已用 2189 字；展开全部请用 expand）'));
});

test('brief 归一化：缺 task 视为非 briefJson，可疑输入不抛异常', () => {
  assert.equal(normalizeBrief(null), null);
  assert.equal(normalizeBrief({ ok: true }), null);
  assert.equal(normalizeBrief({ task: 'string-not-object' }), null);
  const empty = normalizeBrief({ task: { id: 't1' } });
  assert.ok(empty);
  assert.equal(empty.summary, '');
  assert.equal(buildBriefText(empty), '任务 t1（?）', '缺 title/state 也要给出可读文本');
  assert.equal(buildBriefText(null), '');
});

test('展开原文：expand 命令带 task 与当前选中段 id，缺段给提示', () => {
  const cmd = expandCommand('20261114-2221-6a5b', 'seg-a1');
  assert.ok(cmd.includes('memo session expand'));
  assert.ok(cmd.includes('--scope session:20261114-2221-6a5b'));
  assert.ok(cmd.includes('--segment seg-a1'));
  assert.equal(expandCommand('20261114-2221-6a5b', ''), EXPAND_NO_SELECT);
  assert.ok(expandCommand('', 'seg-a1').length > 0);
});

test('scope → taskId：去掉 session: 前缀，非 session 库返回空', () => {
  assert.equal(taskIdFromScope('session:20261114-2221-6a5b'), '20261114-2221-6a5b');
  assert.equal(taskIdFromScope('session:'), '');
  assert.equal(taskIdFromScope('repo:sedimem'), '');
  assert.equal(taskIdFromScope(null), '');
});

test('segments 归一化：非数组返回空数组', () => {
  assert.equal(normalizeSegments({ segments: [SEG] }).length, 1);
  assert.equal(normalizeSegments({ segments: 'oops' }).length, 0);
  assert.equal(normalizeSegments(null).length, 0);
});

/* ---------------- ④ 只读禁用 + 源码安全 ---------------- */

test('只读禁用：writeEnabled=false 时捕获/归档 disabled 并带 READ_ONLY_HINT', () => {
  const ro = writeState(false);
  assert.equal(ro.disabled, true);
  assert.equal(ro.hint, READ_ONLY_HINT);
  assert.ok(ro.hint.length > 0);

  const rw = writeState(true);
  assert.equal(rw.disabled, false);
  assert.equal(rw.hint, '', '可写时不挂只读提示');
  assert.equal(writeState(undefined).disabled, true, '未拿到 writeEnabled 按只读处理');
});

test('源码安全：ledger-view.js 只用 textContent，禁止 innerHTML / eval', () => {
  assert.ok(!SRC.includes('innerHTML'));
  assert.ok(!SRC.includes('insertAdjacentHTML'));
  assert.ok(!SRC.includes('eval('));
  assert.ok(SRC.includes('textContent'));
  assert.ok(SRC.includes('replaceChildren'));
});

test('文件行数：session-view.js ≤ 520 行（超了继续拆 ledger-view.js）', () => {
  assert.ok(SESSION_SRC.split('\n').length <= 520, `session-view.js 当前 ${SESSION_SRC.split('\n').length} 行`);
  assert.ok(SESSION_SRC.includes("from './ledger-view.js'"), '账本代码应从 session-view.js 拆出引入');
});
