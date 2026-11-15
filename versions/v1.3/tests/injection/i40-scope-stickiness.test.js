// I40 — UI 分库粘性（v0.6 W4）
// 钉三件事：① resolveScope 的四级回退语义；② hrefFor 必须带 scope；③ app.js 里不得再出现裸 `'#/' + route`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveScope, hrefFor } from '../../ui/scope.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = path.join(HERE, '../../ui/app.js');

test('I40 分库粘性：四级回退 + 所有跳转都带 scope', async () => {
  const available = ['repo:a', 'dir:b', 'repo:c'];

  // ① hash 优先
  assert.deepEqual(
    resolveScope({ hashScope: 'dir:b', storedScope: 'repo:a', serverDefault: 'repo:a', available }).scope,
    'dir:b',
  );
  // ② hash 非法/不在 available → 回落 stored
  assert.equal(resolveScope({ hashScope: 'dir:zz', storedScope: 'repo:c', serverDefault: 'repo:a', available }).scope, 'repo:c');
  // ③ stored 也没有 → serverDefault
  assert.equal(resolveScope({ hashScope: '', storedScope: '', serverDefault: 'repo:a', available }).scope, 'repo:a');
  // ④ 全都不在 available → 退第一个并给 fallbackReason
  const fallback = resolveScope({ hashScope: 'nope', storedScope: 'repo:zz', serverDefault: 'repo:yy', available });
  assert.equal(fallback.scope, 'repo:a');
  assert.ok(fallback.fallbackReason, '全回落时应给出 fallbackReason');

  // ② hrefFor 必须带 scope（中文/冒号要 encode）
  const href = hrefFor('graph', { scope: 'repo:a' });
  assert.ok(href.startsWith('#/graph?'), `href 形如 #/graph?scope=…，实际 ${href}`);
  assert.ok(href.includes(encodeURIComponent('repo:a')) || href.includes('repo%3Aa'), 'scope 必须被正确编码进 href');

  // ③ 源码层：禁止裸拼接路由（回归防线）
  const src = await fsp.readFile(APP, 'utf8');
  assert.ok(!/location\.hash\s*=\s*[`'"]\s*#\//.test(src), "app.js 里不得再出现 location.hash = '#/…' 的裸拼接");
  assert.ok(/hrefFor\(/.test(src), 'app.js 应通过 hrefFor 生成内部链接');
});
