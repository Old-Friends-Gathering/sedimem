/**
 * handoff-view 单测（W8）——纯函数契约 + 恶意输入不产出 HTML 标签 + 源码安全检查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildHandoffRow, pickHandoffPath } from '../../ui/handoff-view.js';

const SRC = await readFile(fileURLToPath(new URL('../../ui/handoff-view.js', import.meta.url)), 'utf8');

test('pickHandoffPath：predicate=handoff 时取 value，否则空串', () => {
  assert.equal(pickHandoffPath({ predicate: 'handoff', value: 'docs/handoffs/a.md' }), 'docs/handoffs/a.md');
  assert.equal(pickHandoffPath({ predicate: 'fact', value: 'x' }), '');
  assert.equal(pickHandoffPath({ predicate: 'handoff', value: 42 }), '');
  assert.equal(pickHandoffPath({ predicate: 'handoff' }), '');
  assert.equal(pickHandoffPath(null), '');
  assert.equal(pickHandoffPath('string'), '');
});

test('buildHandoffRow：时间 / 会话 id / 路径三字段', () => {
  const row = buildHandoffRow({
    createdAt: '2026-11-14T04:00:00Z',
    source: { session: 'session:abc' },
    predicate: 'handoff',
    value: 'docs/handoffs/w8.md',
  });
  assert.equal(row.ts, '2026-11-14T04:00:00Z');
  assert.equal(row.sessionId, 'session:abc');
  assert.equal(row.path, 'docs/handoffs/w8.md');
  assert.ok(row.label.includes('session:abc'));
  assert.ok(row.label.includes('docs/handoffs/w8.md'));
});

test('buildHandoffRow：缺字段防御式兜底', () => {
  const row = buildHandoffRow({ predicate: 'handoff', value: '/x/y.md' });
  assert.equal(row.ts, '');
  assert.equal(row.sessionId, '');
  assert.equal(row.path, '/x/y.md');
  assert.equal(buildHandoffRow(null).path, '');
});

test('恶意输入：原样透传纯字符串，不额外产出任何 HTML 标签', () => {
  const evil = {
    predicate: 'handoff',
    value: '<script>alert(1)</script>',
    createdAt: '2026-11-14T04:00:00Z',
    source: { session: '<img src=x>' },
  };
  const row = buildHandoffRow(evil);
  // 函数自身只做字符串拼接（消费方用 textContent），不新增任何结构化标签：
  // label 必须严格等于三个原始字段的 join，不得被包装成 <div>/<td> 等。
  assert.equal(row.label, `${row.ts} · ${row.sessionId} · ${row.path}`);
  assert.ok(!/\<(div|span|table|tr|td|a|pre)\b/i.test(row.label), '不得注入结构标签');
  assert.equal(row.path, '<script>alert(1)</script>', '路径原样返回，由 textContent 消费');
  // 正常字段仍可用
  assert.equal(row.ts, '2026-11-14T04:00:00Z');
});

test('源码安全：handoff-view.js 只用 textContent，禁止 innerHTML / eval', () => {
  assert.ok(!SRC.includes('innerHTML'));
  assert.ok(!SRC.includes('insertAdjacentHTML'));
  assert.ok(!SRC.includes('eval('));
  assert.ok(SRC.includes('textContent'));
});
