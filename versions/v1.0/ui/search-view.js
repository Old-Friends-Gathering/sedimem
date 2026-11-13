/**
 * search-view.js —— 搜索页渲染（B3 / 竞品短板 #8，docs/plans/v0.4-competitive-gaps.md D8）。
 *
 * DOM-free 纯函数：输入 {query, items, degraded, limit}，输出 HTML 字符串。
 * 安全约定：**所有插值必须 escapeHtml**——返回的 HTML 由 app.js 整段写入容器，
 * 转义是唯一防线（app.js 不再二次处理，测试断言 script 注入被转义）。
 */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * HTML 转义：& < > " ' 五个字符。所有进入输出的动态值都必须先过这里。
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/**
 * 单条结果 → .hitrow：badge(kind) + 转义后的 text + 小字（score/basis/日期）。
 * 字段防御式读取：缺 basis 就不显示，日期取 createdAt ?? validFrom 截前 10 位。
 * @param {{kind?: string, text?: string, label?: string, score?: number,
 *          basis?: string, createdAt?: string, validFrom?: string}} item
 * @returns {string}
 */
function hitRow(item) {
  const text = String(item?.text ?? item?.label ?? '');
  const kind = String(item?.kind ?? 'fact');
  const score = Number(item?.score);
  const meta = [];
  if (Number.isFinite(score)) meta.push(`score ${score.toFixed(2)}`);
  if (item?.basis) meta.push(escapeHtml(item.basis));
  const date = String(item?.createdAt ?? item?.validFrom ?? '').slice(0, 10);
  if (date) meta.push(escapeHtml(date));
  return [
    '<div class="hitrow">',
    `<span class="badge b-${escapeHtml(kind)}">${escapeHtml(kind)}</span>`,
    `<div class="hit-text">${escapeHtml(text)}</div>`,
    meta.length > 0 ? `<div class="meta">${meta.join(' · ')}</div>` : '',
    '</div>',
  ].join('');
}

/**
 * 渲染搜索结果列表。
 * @param {{query?: string, items?: Array<object>, degraded?: boolean, limit?: number}} args
 * @returns {string} HTML 字符串（所有动态插值已转义）
 * @throws {Error} code=E_INVALID_ARG 当 items 不是数组
 */
export function renderSearchResults({ query = '', items = null, degraded = false, limit = 0 } = {}) {
  if (!Array.isArray(items)) {
    const err = new Error(`renderSearchResults: items must be an array, got ${typeof items}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const q = String(query ?? '');
  const parts = [];
  // 降级提示置顶（语义道不可用不能静默假装，D1 的降级语义在 UI 侧的对应物）
  if (degraded) {
    parts.push('<div class="err">语义道不可用，已降级为词法检索。</div>');
  }
  const total = items.length;
  const shown = Number.isFinite(Number(limit)) && Number(limit) > 0 ? items.slice(0, Number(limit)) : items;
  if (total === 0) {
    parts.push(`<div class="search-empty">没有匹配「${escapeHtml(q)}」的记忆。换个说法试试？</div>`);
    return parts.join('');
  }
  parts.push(`<div class="search-q">「${escapeHtml(q)}」· ${total} 条结果</div>`);
  for (const it of shown) parts.push(hitRow(it));
  if (shown.length < total) {
    parts.push(`<div class="search-more">结果较多，仅显示前 ${shown.length} 条。</div>`);
  }
  return parts.join('');
}
