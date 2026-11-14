/**
 * session-view 单测（W8）——纯函数契约 + 源码安全检查（禁 innerHTML / eval）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { groupByKind, formatCheckpoint, buildSessionRow } from '../../ui/session-view.js';

const SRC = await readFile(fileURLToPath(new URL('../../ui/session-view.js', import.meta.url)), 'utf8');

test('groupByKind：按 kind 分组且保持出现顺序', () => {
  const g = groupByKind([
    { kind: 'fact', id: 'a' },
    { kind: 'state', id: 'b' },
    { kind: 'fact', id: 'c' },
  ]);
  assert.deepEqual(Object.keys(g), ['fact', 'state']);
  assert.equal(g.fact.length, 2);
  assert.equal(g.state[0].id, 'b');
});

test('groupByKind：非数组 / 缺 kind 防御式处理', () => {
  assert.deepEqual(groupByKind(null), {});
  assert.deepEqual(groupByKind('x'), {});
  const g = groupByKind([{ id: 'a' }, { kind: '', id: 'b' }]);
  assert.equal(g.unknown.length, 2);
});

const CHECKPOINT = {
  intent: '做任务页',
  concepts: ['session', 'handoff'],
  files: ['ui/session-view.js'],
  errorsAndFixes: [],
  pendingJobs: [],
  currentState: '已交付',
  nextSteps: ['联调'],
  criticalContext: '只读',
};

test('formatCheckpoint：8 段按固定顺序渲染成纯文本', () => {
  const text = formatCheckpoint({ kind: 'state', checkpoint: CHECKPOINT });
  const order = ['## intent', '## concepts', '## files', '## errorsAndFixes',
    '## pendingJobs', '## currentState', '## nextSteps', '## criticalContext'];
  let last = -1;
  for (const head of order) {
    const i = text.indexOf(head);
    assert.ok(i > last, `段 ${head} 应存在且有序`);
    last = i;
  }
  assert.ok(text.includes('做任务页'));
  assert.ok(text.includes('session\nhandoff'), '数组段逐行展示');
  // 空数组段只留标题，不出现占位内容
  assert.ok(!text.includes('[]'));
});

test('formatCheckpoint：checkpoint 缺失回退 text，非对象/数组防御', () => {
  assert.equal(formatCheckpoint({ kind: 'state', text: '纯文本' }), '纯文本');
  assert.equal(formatCheckpoint({ kind: 'state', checkpoint: 'oops', text: '回退' }), '回退');
  assert.equal(formatCheckpoint({ kind: 'state', checkpoint: [] }), '');
  assert.equal(formatCheckpoint(null), '');
});

test('buildSessionRow：scope + records 计数', () => {
  const row = buildSessionRow('session:abc', { records: 7 });
  assert.equal(row.scope, 'session:abc');
  assert.equal(row.records, 7);
  assert.ok(row.label.includes('session:abc'));
  assert.ok(row.label.includes('7'));
});

test('buildSessionRow：恶意 / 缺失输入不抛异常', () => {
  assert.equal(buildSessionRow('<script>x</script>', null).scope, '<script>x</script>');
  assert.equal(buildSessionRow(null, { records: 'oops' }).records, 0);
});

test('源码安全：session-view.js 只用 textContent，禁止 innerHTML / eval', () => {
  assert.ok(!SRC.includes('innerHTML'));
  assert.ok(!SRC.includes('insertAdjacentHTML'));
  assert.ok(!SRC.includes('eval('));
  assert.ok(SRC.includes('textContent'));
});

test('formatCheckpoint：/api/records 不带 checkpoint 字段时，从 value 的 JSON 还原八段', () => {
  // 真相层只存 value 字符串，投影里没有 checkpoint 对象 —— 任务页必须自己解析，否则只剩一行「checkpoint @ 时间」
  const rec = { kind: 'state', text: 'checkpoint @ 2026-11-14T14:22:30.041Z', value: JSON.stringify(CHECKPOINT) };
  const out = formatCheckpoint(rec);
  assert.match(out, /## intent/);
  assert.match(out, /## nextSteps/);
  assert.match(out, /只读/);
});

test('formatCheckpoint：session meta 也是 JSON，但不得被当成 checkpoint 渲染', () => {
  const meta = { id: '20261114-2221-6a5b', title: '任务标题', status: 'open', parentScope: 'repo:sedimem' };
  const rec = { kind: 'state', text: 'session 20261114-2221-6a5b: 任务标题 开始', value: JSON.stringify(meta) };
  assert.equal(formatCheckpoint(rec), 'session 20261114-2221-6a5b: 任务标题 开始');
});

test('formatCheckpoint：value 不是合法 JSON 时退回 text', () => {
  const rec = { kind: 'state', text: '纯文本 checkpoint', value: '{坏 JSON' };
  assert.equal(formatCheckpoint(rec), '纯文本 checkpoint');
});
