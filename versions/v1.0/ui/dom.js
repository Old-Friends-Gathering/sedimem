/**
 * dom.js —— 极小的 DOM 工具（W7 从 app.js 拆出，Q9 单文件 ≤600 行）。
 * 只用 textContent / createElement，不碰 innerHTML（Q9 明令禁止，防 XSS）。
 */

/** 创建元素并批量填子节点/文本。 */
export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** YYYY-MM-DD（本地时区）。 */
export function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
