/**
 * edit-view 单测（W7 / B1）——纯函数 + 渲染安全静态检查。
 * 覆盖：canSubmit / formIsDirty / buildSupersedePayload / buildWritePayload /
 * readOnlyFromSummary / renderEditForm 与 renderRecordList 的转义，
 * 以及源码级「禁 innerHTML / 禁 eval」静态检查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  canSubmit, formIsDirty, buildSupersedePayload, buildWritePayload,
  readOnlyFromSummary, renderEditForm, renderRecordList,
} from '../../ui/edit-view.js';

const SRC = await readFile(fileURLToPath(new URL('../../ui/edit-view.js', import.meta.url)), 'utf8');

const RECORD = {
  id: '01ABCDEFGHJKMNPQRSTVWXZ',
  kind: 'fact',
  title: '标题',
  subject: 'repo',
  predicate: 'uses',
  value: 'node',
  text: '正文内容',
  validFrom: '2026-11-14T01:02:03.000Z',
};

test('canSubmit：只读不可提交；可写但无脏变更也不可提交', () => {
  assert.equal(canSubmit({ readonly: true, dirty: true }), false);
  assert.equal(canSubmit({ readonly: false, dirty: false }), false);
  assert.equal(canSubmit({ readonly: false, dirty: true }), true);
});

test('formIsDirty：编辑比字段差异；新建任一字段非空即 dirty', () => {
  const clean = { kind: RECORD.kind, title: RECORD.title, subject: RECORD.subject, predicate: RECORD.predicate, value: RECORD.value, text: RECORD.text };
  assert.equal(formIsDirty(clean, RECORD), false);
  assert.equal(formIsDirty({ ...clean, text: '改过' }, RECORD), true);
  assert.equal(formIsDirty({}, RECORD), true);
  assert.equal(formIsDirty({}, null), false);
  assert.equal(formIsDirty({ title: ' ' }, null), false); // 纯空白不算
  assert.equal(formIsDirty({ title: '新' }, null), true);
});

test('buildSupersedePayload：带 oldId + ifMatch；显式 ifMatch 优先', () => {
  const form = { title: 't', subject: 's', predicate: 'p', value: 'v', text: 'x' };
  const p = buildSupersedePayload({ record: RECORD, form });
  assert.equal(p.oldId, RECORD.id);
  assert.equal(p.ifMatch, RECORD.validFrom);
  assert.deepEqual(
    [p.title, p.subject, p.predicate, p.value, p.text],
    ['t', 's', 'p', 'v', 'x'],
  );
  const p2 = buildSupersedePayload({ record: RECORD, form, ifMatch: '2020-01-01T00:00:00.000Z' });
  assert.equal(p2.ifMatch, '2020-01-01T00:00:00.000Z');
});

test('buildSupersedePayload：缺 id 或缺并发版本号必须拒绝', () => {
  assert.throws(() => buildSupersedePayload({ record: { id: '' }, form: {} }), /E_INVALID_ARG|id is required/);
  const noVersion = { ...RECORD, validFrom: undefined };
  assert.throws(() => buildSupersedePayload({ record: noVersion, form: {} }), /ifMatch/);
});

test('buildWritePayload：新增走 write，不携带 ifMatch/oldId', () => {
  const p = buildWritePayload({ form: { kind: 'gotcha', text: '坑' } });
  assert.deepEqual(p, { kind: 'gotcha', title: '', subject: '', predicate: '', value: '', text: '坑' });
  assert.ok(!('ifMatch' in p) && !('oldId' in p));
});

test('readOnlyFromSummary：缺省一律按只读，显式可写才放行', () => {
  assert.equal(readOnlyFromSummary(undefined), true);
  assert.equal(readOnlyFromSummary({}), true);
  assert.equal(readOnlyFromSummary({ readOnly: true }), true);
  assert.equal(readOnlyFromSummary({ readOnly: false }), false);
  assert.equal(readOnlyFromSummary({ writeEnabled: true }), false);
});

test('renderEditForm：用户输入被转义（script / 引号 / 尖括号）', () => {
  const evil = { ...RECORD, title: '<script>alert(1)</script>', text: '" onmouseover="x()' };
  const html = renderEditForm({ kinds: ['fact', 'pref'], record: evil, readonly: false });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'script 标签必须被转义');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('" onmouseover="x()'), '属性逃逸必须被转义');
  // 空值安全
  assert.ok(renderEditForm({}).includes('<select'));
});

test('renderEditForm：只读模式下提交按钮 disabled 且有 serve --write 提示', () => {
  const html = renderEditForm({ record: RECORD, readonly: true });
  assert.ok(html.includes('disabled'));
  assert.ok(html.includes('memo serve --write'));
  assert.ok(html.includes('保存（supersede）'));
});

test('renderRecordList：正文与 id 均转义，选中态标记', () => {
  const html = renderRecordList({
    items: [{ id: 'a<b', kind: 'fact', text: '<img src=x onerror=alert(1)>' }],
    selectedId: 'a<b',
  });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('data-id="a&lt;b"'));
  assert.ok(html.includes('selected'));
  assert.ok(renderRecordList({ items: [] }).includes('没有匹配的记录'));
});

test('静态检查：源码禁 innerHTML / eval / new Function', () => {
  assert.ok(!/\binnerHTML\b/.test(SRC), 'edit-view.js 不得出现 innerHTML');
  assert.ok(!/\beval\s*\(/.test(SRC), 'edit-view.js 不得出现 eval');
  assert.ok(!/new\s+Function/.test(SRC), 'edit-view.js 不得出现 new Function');
});
