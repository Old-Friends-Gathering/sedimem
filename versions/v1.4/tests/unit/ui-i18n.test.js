import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLang, tr } from '../../ui/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('resolveLang: ?lang=en wins, then stored, then navigator', () => {
  assert.equal(resolveLang('?lang=en', 'zh', 'zh-CN'), 'en');
  assert.equal(resolveLang('?lang=zh', 'en', 'en-US'), 'zh');
  assert.equal(resolveLang('', 'en', 'zh-CN'), 'en');
  assert.equal(resolveLang('', '', 'en-US'), 'en');
  assert.equal(resolveLang('', '', 'zh-CN'), 'zh');
});

test('tr: fixed labels and title patterns', () => {
  assert.equal(tr('今日', 'en'), 'Today');
  assert.equal(tr('2026-11-17 的变化', 'en'), 'Changes · 2026-11-17');
  assert.equal(tr('任务库（2）', 'en'), 'Task stores (2)');
  assert.equal(tr(' · 2 条记录 · 2026-11-17', 'en'), ' · 2 records · 2026-11-17');
  assert.equal(tr('本地 127.0.0.1:7788', 'en'), 'local 127.0.0.1:7788');
});

test('tr: user data is left alone', () => {
  const text = 'Prefer append-only JSONL; never rewrite history.';
  assert.equal(tr(text, 'en'), text);
  assert.equal(tr('今日', 'zh'), '今日');
  assert.equal(tr('', 'en'), '');
});

test('English README and site use English images and link the project site', async () => {
  const site = 'https://old-friends-gathering.github.io/sedimem/';
  for (const rel of ['README.md', 'README.en.md']) {
    const body = await fsp.readFile(path.join(ROOT, rel), 'utf8');
    assert.ok(body.includes(site), `${rel} 缺少项目站链接`);
  }
  const files = ['README.en.md', 'docs/en/index.html'];
  for (const rel of files) {
    const body = await fsp.readFile(path.join(ROOT, rel), 'utf8');
    const refs = [...body.matchAll(/(?:shots|assets)\/([\w./-]+\.(?:png|svg))/g)].map((m) => m[1]);
    const chineseOnly = refs.filter((name) => /^(ui-|diagrams\/)/.test(name) && !/-en\./.test(name));
    assert.deepEqual(chineseOnly, [], `${rel} 引用了非英文图: ${chineseOnly.join(', ')}`);
  }
});
