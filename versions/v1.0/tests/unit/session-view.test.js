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
  intent: '做会话页',
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
  assert.ok(text.includes('做会话页'));
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
