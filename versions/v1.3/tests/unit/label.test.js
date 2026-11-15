// tests/unit/label.test.js — 标题字段与 label 派生（裁决 59 / issue #61）
// 为什么单独一个文件：label 是「人看到的唯一那行字」，它的退化（取正文前 60 字）在真实库里
// 表现为 51% 节点撞名，但普通功能测试完全看不出来，所以这里把契约钉死。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, validateRecord, normalizeTitle, MAX_TITLE } from '../../src/core/record.js';
import { makeLabel } from '../../src/web/handlers.js';

const SRC = { agent: 'test' };

test('normalizeTitle：折成单行、去空白、超长截断', () => {
  assert.equal(normalizeTitle('  服务端口  '), '服务端口');
  assert.equal(normalizeTitle('数据库\n连接池'), '数据库 连接池');
  assert.equal(normalizeTitle(undefined), '');
  assert.equal(normalizeTitle(''), '');
  const long = '标'.repeat(MAX_TITLE + 5);
  const got = normalizeTitle(long);
  assert.equal(got.length, MAX_TITLE);
  assert.ok(got.endsWith('…'));
});

test('createRecord：title 只在非空时写入，空串不落键', () => {
  const withTitle = createRecord({ text: '端口 8080', title: ' 服务端口 ', source: SRC });
  assert.equal(withTitle.title, '服务端口');
  const without = createRecord({ text: '端口 8080', source: SRC });
  assert.equal('title' in without, false, '没有标题就不该有 title 键（空串与缺失要能区分）');
  const blank = createRecord({ text: '端口 8080', title: '   ', source: SRC });
  assert.equal('title' in blank, false);
});

test('validateRecord：title 单行 / 非空 / 已归一化 / ≤40', () => {
  const base = createRecord({ text: 'x', title: '正常标题', source: SRC });
  assert.equal(validateRecord(base).ok, true);

  const cases = [
    [{ ...base, title: '' }, 'empty'],
    [{ ...base, title: 'a\nb' }, 'single-line'],
    [{ ...base, title: ' 前后有空格 ' }, 'whitespace'],
    [{ ...base, title: '标'.repeat(MAX_TITLE + 1) }, 'exceeds'],
    [{ ...base, title: 42 }, 'string'],
  ];
  for (const [rec, keyword] of cases) {
    const v = validateRecord(rec);
    assert.equal(v.ok, false, `应拒绝：${keyword}`);
    assert.ok(v.errors.some((e) => e.includes('title') && e.includes(keyword)), `错误信息应含 ${keyword}: ${v.errors}`);
  }
});

test('makeLabel：title > subject > 首句，且 predicate 不再占标签', () => {
  assert.equal(makeLabel({ title: '服务端口', subject: 'svc', predicate: 'port' }), '服务端口');
  assert.equal(makeLabel({ subject: 'svc', predicate: 'port' }), 'svc');
  assert.equal(makeLabel({ subject: 'svc_name', predicate: 'port' }), 'svc name');
  assert.equal(makeLabel({ subject: 'text', predicate: 'text', text: '结论：先跑门禁' }), '结论：先跑门禁');
  // 长 subject 也必须收进 24 字符
  const long = makeLabel({ subject: 'Mac mini A4x Business Review 2026-11-06 停摆', predicate: 'x' });
  assert.ok(long.length <= 24, `label 应 ≤24 字符，实际 ${long.length}: ${long}`);
});
