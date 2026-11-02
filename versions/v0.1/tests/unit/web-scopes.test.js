// tests/unit/web-scopes.test.js — 分库列表与 ?scope= 覆盖（契约：docs/08-web-ui.md §13，issue #23）
// 关键风险：scope 直接进文件路径（items/<scope>.jsonl），所以 ?scope= 必须过 SCOPE_PATTERN，
// 否则 `?scope=../../etc/passwd` 就是 path traversal。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listScopes } from '../../src/web/scopes.js';
import { createWebServer } from '../../src/web/server.js';

/** 造一个分库文件：n 条最小合法记录 */
function seedScope(memoHome, scope, texts) {
  const dir = join(memoHome, 'items');
  mkdirSync(dir, { recursive: true });
  const lines = texts.map((text, i) => JSON.stringify({
    id: `01M6${String(i).padStart(20, '0')}`,
    kind: 'fact',
    text,
    status: 'active',
    createdAt: new Date().toISOString(),
    validFrom: new Date().toISOString(),
    contentHash: `hash-${i}`,
    source: { agent: 'test' },
  }));
  writeFileSync(join(dir, `${scope}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

describe('web/scopes', () => {
  test('列出所有合法分库，统计条数，标记 current', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-scopes-'));
    try {
      seedScope(home, 'repo:alpha', ['a1', 'a2', 'a3']);
      seedScope(home, 'dir:beta', ['b1']);
      writeFileSync(join(home, 'items', 'not-a-scope.jsonl'), '{}\n', 'utf8'); // 名字不合 SCOPE_PATTERN
      const { scopes } = await listScopes(home, 'repo:alpha');
      assert.deepEqual(scopes.map((s) => s.scope).sort(), ['dir:beta', 'repo:alpha']);
      assert.equal(scopes.find((s) => s.scope === 'repo:alpha').records, 3);
      assert.equal(scopes.find((s) => s.scope === 'repo:alpha').current, true);
      assert.equal(scopes.find((s) => s.scope === 'dir:beta').current, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('当前分库还没有文件时也列出（空库下拉不能消失）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-scopes-empty-'));
    try {
      const { scopes } = await listScopes(home, 'repo:none-yet');
      assert.equal(scopes.length, 1);
      assert.equal(scopes[0].scope, 'repo:none-yet');
      assert.equal(scopes[0].records, 0);
      assert.equal(scopes[0].current, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('web/server ?scope=', () => {
  test('合法 scope 覆盖默认；非法 scope（含穿越）400 且不碰磁盘', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-scope-http-'));
    seedScope(home, 'repo:one', ['one record']);
    seedScope(home, 'repo:two', ['two a', 'two b']);
    let web;
    try {
      web = await createWebServer({ memoHome: home, scope: 'repo:one', includeUi: false, port: 0 });
      const get = async (suffix) => {
        const res = await fetch(new URL(suffix, web.url));
        return { status: res.status, body: await res.json() };
      };

      const def = await get('api/summary');
      assert.equal(def.body.scope, 'repo:one');
      assert.equal(def.body.stats.total, 1);

      const two = await get('api/summary?scope=repo:two');
      assert.equal(two.body.scope, 'repo:two');
      assert.equal(two.body.stats.total, 2);

      const list = await get('api/scopes');
      assert.deepEqual(list.body.scopes.map((s) => s.scope).sort(), ['repo:one', 'repo:two']);

      for (const bad of ['../etc/passwd', '../../etc/passwd', 'nope', 'repo:', 'repo:a/b']) {
        const res = await get(`api/summary?scope=${encodeURIComponent(bad)}`);
        assert.equal(res.status, 400, `${bad} 应被拒绝`);
        assert.equal(res.body.code, 'E_INVALID_ARG');
      }
    } finally {
      if (web) await web.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
