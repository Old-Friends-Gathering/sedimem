/**
 * search-view.js —— 搜索页渲染（B3 / D8；W9 换新设计系统的结构）。
 *
 * DOM-free 纯函数：输入 {query, items, degraded, limit}，输出 HTML 字符串
 * （app.js 用 DOMParser 解析后挂载，不走 innerHTML）。
 * 安全约定：**所有插值必须 escapeHtml**——转义是唯一防线，测试断言 script 注入被转义。
 * 结构：顶部 degraded .note → 计数行 → .sr 列表，每条 .sr-item（.title / .meta / .txt）。
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

/** 摘要：首行之后的正文截到 ~120 字（.txt 由 CSS 控制行高，两行内可读）。 */
function excerpt(text) {
  const t = String(text ?? '');
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

/** 标题：title > label > 正文首行。 */
function titleOf(item) {
  const firstLine = String(item?.text ?? '').split('\n')[0] ?? '';
  return String(item?.title ?? item?.label ?? firstLine ?? '');
}

/**
 * 单条结果 → .sr-item：.title + .meta（kind badge / score / basis badge）+ .txt 摘要。
 * 字段防御式读取：缺 basis 就不显示 badge，日期取 createdAt ?? validFrom 截前 10 位。
 * @param {{kind?: string, text?: string, label?: string, title?: string, score?: number,
 *          basis?: string, createdAt?: string, validFrom?: string}} item
 * @returns {string}
 */
function srItem(item) {
  const kind = String(item?.kind ?? 'fact');
  const score = Number(item?.score);
  const basis = String(item?.basis ?? '');
  const date = String(item?.createdAt ?? item?.validFrom ?? '').slice(0, 10);
  const meta = [`<span class="badge">${escapeHtml(kind)}</span>`];
  if (Number.isFinite(score)) meta.push(`score ${score.toFixed(2)}`);
  if (basis) meta.push(`<span class="badge ${basis.includes('+') ? 'b-info' : ''}">${escapeHtml(basis)}</span>`);
  if (date) meta.push(escapeHtml(date));
  const title = titleOf(item);
  // 标题取自正文首行时，摘要要从标题之后开始，否则同一句话会显示两遍
  const full = String(item?.text ?? '');
  const rest = full.startsWith(title) ? full.slice(title.length).replace(/^[\s:：·-]+/, '') : full;
  const body = excerpt(rest);
  // 正文与标题相同（短记录）时不再重复一行
  const txt = body && body !== title ? `<div class="txt">${escapeHtml(body)}</div>` : '';
  return [
    '<div class="sr-item">',
    `<div class="title">${escapeHtml(title)}</div>`,
    `<div class="meta">${meta.join('')}</div>`,
    txt,
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
  // 降级提示置顶（语义道不可用不能静默假装）
  if (degraded) {
    parts.push('<div class="note">语义道不可用，已降级为词法检索（bm25）。</div>');
  }
  const total = items.length;
  const shown = Number.isFinite(Number(limit)) && Number(limit) > 0 ? items.slice(0, Number(limit)) : items;
  if (total === 0) {
    parts.push(`<div class="empty"><div class="big">没有匹配「${escapeHtml(q)}」的记忆。</div>换个说法试试？</div>`);
    return parts.join('');
  }
  parts.push(`<div class="dim">「${escapeHtml(q)}」 · ${total} 条结果</div>`);
  parts.push('<div class="sr">');
  for (const it of shown) parts.push(srItem(it));
  parts.push('</div>');
  if (shown.length < total) {
    parts.push(`<div class="dim">结果较多，仅显示前 ${shown.length} 条。</div>`);
  }
  return parts.join('');
}
