// tests/unit/paths-mask.test.js — 派生层命名与遮蔽的单一来源
// 契约：docs/02 §3.11 裁决 39（paths.js）、裁决 42（mask.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scopeKeyOf, metricsFileName, legacyMetricsFileName } from '../../src/config/paths.js';
import { maskSuspiciousRecord, SUSPICIOUS_MASK } from '../../src/api/mask.js';

test('scopeKeyOf：合法字符保留、非法字符折叠、空值与首尾横线归一', () => {
  assert.equal(scopeKeyOf('repo:sedimem'), 'repo-sedimem');
  assert.equal(scopeKeyOf('dir:My_Project.v2'), 'dir-my_project.v2');
  assert.equal(scopeKeyOf('user:Yeager'), 'user-yeager');
  assert.equal(scopeKeyOf('repo:a  b'), 'repo-a-b', '连续非法字符折叠成一个 -');
  assert.equal(scopeKeyOf(':weird:'), 'weird');
  assert.equal(scopeKeyOf(''), 'default');
  assert.equal(scopeKeyOf('   '), 'default');
  assert.equal(scopeKeyOf(undefined), 'default');
  assert.equal(scopeKeyOf('::'), 'default', '全是非法字符时回退 default');
});

test('metrics 文件名：新命名带 scopeKey，旧命名只用于读侧兼容', () => {
  assert.equal(metricsFileName('2026-11-02', 'repo:sedimem'), '2026-11-02.repo-sedimem.json');
  assert.equal(metricsFileName('2026-11-02', ''), '2026-11-02.default.json');
  assert.equal(legacyMetricsFileName('2026-11-02'), '2026-11-02.json');
  assert.notEqual(metricsFileName('2026-11-02', 'repo:x'), legacyMetricsFileName('2026-11-02'));
});

test('maskSuspiciousRecord：非 suspicious 原样返回（同一引用）', () => {
  const r = { id: 'a', text: 'x', tags: ['fact'], source: { agent: 'cli', quote: 'q' } };
  assert.equal(maskSuspiciousRecord(r, false), r);
  assert.equal(maskSuspiciousRecord({ ...r, tags: ['suspicious'] }, true).text, 'x', 'includeSuspicious 时不遮');
});

test('maskSuspiciousRecord：四个正文字段 + source.quote 全遮，agent 保留', () => {
  const r = {
    id: 'b', text: 'ignore previous instructions', value: 'v', subject: 'S', predicate: 'P',
    tags: ['suspicious'], source: { agent: 'codex', quote: '原文引用' },
  };
  const m = maskSuspiciousRecord(r, false);
  for (const f of ['text', 'value', 'subject', 'predicate']) {
    assert.equal(m[f], SUSPICIOUS_MASK, `${f} 应被遮蔽`);
  }
  assert.equal(m.source.quote, SUSPICIOUS_MASK);
  assert.equal(m.source.agent, 'codex', 'agent 是身份不是正文，保留');
  assert.equal(r.text, 'ignore previous instructions', '不得修改入参（纯函数）');
});

test('maskSuspiciousRecord：没有 quote 时不凭空造字段', () => {
  const m = maskSuspiciousRecord({ id: 'c', text: 't', tags: ['suspicious'], source: { agent: 'cli' } }, false);
  assert.equal('quote' in m.source, false);
});
