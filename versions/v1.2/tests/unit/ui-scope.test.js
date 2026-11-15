import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveScope, hrefFor, SCOPE_PATTERN } from '../../ui/scope.js';

// 契约：W4「UI 分库粘性」。此前 tab 点击写裸 '#/'+route 丢 ?scope=，
// 修法 = scope.js 纯函数 resolveScope（hash > stored > serverDefault > available[0]）
// + 所有内部跳转走 hrefFor。合法性形状与 src/mcp/scope-state.js 的 SCOPE_PATTERN 同源。

const AVAIL = ['repo:demo', 'dir:work', 'global:all'];

describe('ui/scope.js：resolveScope 三路合成', () => {
  test('hash 合法且在 available → hash 优先（不被 stored/serverDefault 抢走）', () => {
    const r = resolveScope({
      hashScope: 'dir:work',
      storedScope: 'repo:demo',
      serverDefault: 'repo:demo',
      available: AVAIL,
    });
    assert.deepEqual(r, { scope: 'dir:work', source: 'hash' });
  });

  test('hash 为空时 stored 回退生效', () => {
    const r = resolveScope({ hashScope: '', storedScope: 'global:all', serverDefault: 'repo:demo', available: AVAIL });
    assert.deepEqual(r, { scope: 'global:all', source: 'stored' });
  });

  test('hash 非法（不过 SCOPE_PATTERN）→ 回落 serverDefault，fallbackReason=invalid', () => {
    const r = resolveScope({ hashScope: 'BAD SCOPE', storedScope: '', serverDefault: 'repo:demo', available: AVAIL });
    assert.deepEqual(r, { scope: 'repo:demo', source: 'default', fallbackReason: 'invalid' });
  });

  test('形状合法但不在 available → 回落首个，fallbackReason=not-found', () => {
    const r = resolveScope({ hashScope: 'repo:gone', storedScope: 'dir:gone', serverDefault: '', available: AVAIL });
    assert.deepEqual(r, { scope: 'repo:demo', source: 'default', fallbackReason: 'not-found' });
  });

  test('hash/stored 皆空且无 serverDefault → available 首个，fallbackReason=missing', () => {
    const r = resolveScope({ hashScope: '', storedScope: '', serverDefault: '', available: AVAIL });
    assert.deepEqual(r, { scope: 'repo:demo', source: 'default', fallbackReason: 'missing' });
  });

  test('空白裁剪：前后空白的 hash 裁掉后按合法值处理', () => {
    const r = resolveScope({ hashScope: '  dir:work  ', storedScope: '', serverDefault: '', available: AVAIL });
    assert.deepEqual(r, { scope: 'dir:work', source: 'hash' });
  });

  test('available 拉取失败（空列表）时 hash 仅按形状放行，不至于失去 scope', () => {
    const r = resolveScope({ hashScope: 'repo:any', storedScope: '', serverDefault: '', available: [] });
    assert.deepEqual(r, { scope: 'repo:any', source: 'hash' });
  });

  test('stored 非法但 serverDefault 可用 → default + invalid', () => {
    const r = resolveScope({ hashScope: '', storedScope: 'repo:UPPER', serverDefault: 'global:all', available: AVAIL });
    assert.deepEqual(r, { scope: 'global:all', source: 'default', fallbackReason: 'invalid' });
  });
});

describe('ui/scope.js：hrefFor 内部跳转链接', () => {
  test('route + scope → 携带 encodeURIComponent 后的 query', () => {
    assert.equal(hrefFor('graph', { scope: 'repo:demo' }), '#/graph?scope=repo%3Ademo');
  });

  test('保留搜索词并拼在 scope 之后；空值参数自动省略', () => {
    assert.equal(
      hrefFor('search', { scope: 'dir:work', q: '记忆 系统', extra: '' }),
      '#/search?scope=dir%3Awork&q=%E8%AE%B0%E5%BF%86%20%E7%B3%BB%E7%BB%9F',
    );
  });

  test('无参数退回裸路由（首次进入 today 且 scope 未定时）', () => {
    assert.equal(hrefFor('today', { scope: '' }), '#/today');
  });
});

describe('ui/scope.js：SCOPE_PATTERN 与后端同源', () => {
  test('接受 repo:/dir:/user:/global: 前缀；拒绝大写/中文/未知前缀/超长', () => {
    assert.ok(SCOPE_PATTERN.test('repo:demo-project'));
    assert.ok(SCOPE_PATTERN.test('dir:a.b_c-1'));
    for (const s of ['repo:UPPER', 'dir:名字', 'tmp:abc', 'repo:', 'repo:' + 'a'.repeat(65)]) {
      assert.equal(SCOPE_PATTERN.test(s), false, `应拒绝 ${s}`);
    }
  });
});
