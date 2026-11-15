/**
 * import-view 单测（W7 / B2）——契约纯函数 + 渲染转义 + 静态安全检查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  SOURCES, importQuery, renderImportPreview, renderImportApplied,
} from '../../ui/import-view.js';

const SRC = await readFile(fileURLToPath(new URL('../../ui/import-view.js', import.meta.url)), 'utf8');

test('SOURCES：恰好五个来源且 src 唯一', () => {
  assert.equal(SOURCES.length, 5);
  assert.equal(new Set(SOURCES.map((s) => s.src)).size, 5);
});

test('importQuery：预览 dryRun=1，写入 apply=1', () => {
  assert.equal(importQuery({}), 'dryRun=1');
  assert.equal(importQuery({ apply: false }), 'dryRun=1');
  assert.equal(importQuery({ apply: true }), 'apply=1');
});

test('renderImportPreview：表格含来源/条数/kind 分布/样例，且全部转义', () => {
  const r = {
    ok: true, src: 'markdown', path: '/tmp/x.md', dryRun: true,
    parsed: 3, byKind: { fact: 2, gotcha: 1 },
    samples: [
      { kind: 'fact', text: '正常事实' },
      '<script>alert(1)</script>',
    ],
  };
  const html = renderImportPreview({ result: r });
  assert.ok(html.includes('markdown'));
  assert.ok(html.includes('3'));
  assert.ok(html.includes('fact:2 · gotcha:1'));
  assert.ok(!html.includes('<script>alert(1)</script>'), '样例正文必须转义');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderImportPreview：kind 值也转义；缺 samples 不炸', () => {
  const html = renderImportPreview({ result: { src: 'csv', parsed: 0, byKind: {}, samples: [{ kind: 'fa<img>ct', text: 'x' }] } });
  assert.ok(!html.includes('fa<img>ct'));
  assert.ok(renderImportPreview({ result: { src: 'csv', parsed: 0, byKind: {} } }).includes('csv'));
});

test('renderImportPreview：缺 parsed 直接拒绝（后端契约兜底）', () => {
  assert.throws(() => renderImportPreview({ result: { src: 'csv' } }), /parsed/);
  assert.throws(() => renderImportPreview({}), /parsed/);
});

test('renderImportApplied：输出 written/skipped 计数', () => {
  const text = renderImportApplied({ written: 5, skipped: 2 });
  assert.ok(text.includes('written 5'));
  assert.ok(text.includes('skipped 2'));
});

test('静态检查：源码禁 innerHTML / eval / new Function', () => {
  assert.ok(!/\binnerHTML\b/.test(SRC), 'import-view.js 不得出现 innerHTML');
  assert.ok(!/\beval\s*\(/.test(SRC));
  assert.ok(!/new\s+Function/.test(SRC));
});
