// tests/unit/search-view.test.js —— B3 / D8：搜索页 DOM-free 渲染纯函数
// 覆盖：有结果 / 空结果 / degraded 降级提示 / HTML 转义（text 含 script）/ limit 截断。
// W9：结构换成 .sr-item（.title/.meta/.txt），degraded 用 .note（原 .err/hitrow 断言同步更新）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderSearchResults, escapeHtml } from '../../ui/search-view.js';

const ITEMS = [
  { kind: 'fact', text: '事实甲：Node >= 22\n部署机与 CI 都是 22 以上，低于 22 会缺 node:sqlite', score: 1.234, basis: 'bm25', createdAt: '2026-11-01T08:00:00Z' },
  { kind: 'decision', text: '决定：零第三方依赖', score: 0.87, createdAt: '2026-11-02T09:00:00Z' },
  { kind: 'gotcha', text: '坑：Windows 路径冒号', score: 0.5, basis: 'bm25+vector', validFrom: '2026-11-03T10:00:00Z' },
];

describe('search-view/renderSearchResults', () => {
  test('有结果：每条 .sr-item 含 title + meta(kind badge/score/basis) + txt', () => {
    const html = renderSearchResults({ query: '依赖', items: ITEMS });
    assert.match(html, /「依赖」 · 3 条结果/);
    const rows = html.match(/<div class="sr-item">/g) ?? [];
    assert.equal(rows.length, 3);
    assert.match(html, /<span class="badge">fact<\/span>/);
    assert.match(html, /<div class="title">事实甲：Node &gt;= 22<\/div>/);
    assert.match(html, /score 1\.23/);
    assert.match(html, /bm25\+vector/); // basis badge（b-info 变体）
    assert.match(html, /2026-11-03/); // createdAt 缺失时回退 validFrom
    // 摘要行：正文与标题不同的记录才渲染（短记录不重复一行）
    assert.match(html, /<div class="txt">/);
    const dup = renderSearchResults({ query: 'q', items: [{ kind: 'fact', text: '只有一行' }] });
    assert.doesNotMatch(dup, /<div class="txt">/, '正文等于标题时不应重复渲染');
  });

  test('空结果：给出 .empty 提示（含转义后的查询词）', () => {
    const html = renderSearchResults({ query: '不存在 <q>', items: [] });
    assert.match(html, /class="empty"/);
    assert.match(html, /没有匹配「不存在 &lt;q&gt;」/);
    assert.doesNotMatch(html, /sr-item/);
  });

  test('degraded：顶部 .note 提示语义道不可用已降级', () => {
    const html = renderSearchResults({ query: 'x', items: ITEMS, degraded: true });
    const noteIdx = html.indexOf('class="note"');
    assert.ok(noteIdx > -1, '应有 .note 提示');
    assert.match(html, /语义道不可用，已降级为词法检索/);
    assert.ok(noteIdx < html.indexOf('sr-item'), '.note 应在结果列表之前');
  });

  test('HTML 转义：text 含 script 不会产生可执行标签', () => {
    const html = renderSearchResults({
      query: '<img src=x onerror=alert(1)>',
      items: [{ kind: 'fact', text: '<script>alert(1)</script> & "引号"', score: 1 }],
    });
    assert.ok(!html.includes('<script>'), '输出不得含原始 <script>');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&amp; &quot;引号&quot;/);
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  test('limit：超出只渲染前 limit 条并提示截断', () => {
    const html = renderSearchResults({ query: 'q', items: ITEMS, limit: 2 });
    const rows = html.match(/<div class="sr-item">/g) ?? [];
    assert.equal(rows.length, 2);
    assert.match(html, /仅显示前 2 条/);
    // limit 大于总数 / 未传：不截断、不提示
    const full = renderSearchResults({ query: 'q', items: ITEMS, limit: 30 });
    assert.equal((full.match(/<div class="sr-item">/g) ?? []).length, 3);
    assert.doesNotMatch(full, /仅显示前/);
  });

  test('items 非数组：抛 E_INVALID_ARG', () => {
    assert.throws(() => renderSearchResults({ query: 'x', items: 'nope' }),
      (err) => err.code === 'E_INVALID_ARG');
  });
});
