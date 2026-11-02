// core/hash.js — 文本归一化 / 内容哈希 / 分词（契约：docs/02 §3）
// contentHash 输入顺序：normalizeText(text) + '\u0001' + subject + '\u0001' + predicate + '\u0001' + value

import { createHash } from 'node:crypto';

/** 全角（U+FF01–U+FF5E）→ 半角，全角空格 U+3000 → 空格 */
function toHalfWidth(s) {
  return s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
          .replace(/\u3000/g, ' ');
}

/**
 * 归一化：小写、全角→半角、去多余空白、去标点（保留数字与中英文）。
 * @param {string} s
 * @returns {string}
 */
export function normalizeText(s) {
  if (typeof s !== 'string') {
    const err = new Error(`normalizeText: expect string, got ${typeof s}`);
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  return toHalfWidth(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')  // 标点 → 空格（保留字母/数字/空白）
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 内容哈希：sha256(normalizeText(text) ⊕ subject ⊕ predicate ⊕ value)
 * @returns {'sha256:<64hex>'}
 */
export function contentHash({ text, subject, predicate, value }) {
  const input = [normalizeText(String(text ?? '')), String(subject ?? ''), String(predicate ?? ''), String(value ?? '')].join('\u0001');
  return 'sha256:' + createHash('sha256').update(input, 'utf8').digest('hex');
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of',
  'and', 'or', 'in', 'on', 'for', 'with', 'at', 'by', 'it', 'its', 'this', 'that',
  'these', 'those', 'as', 'from', 'not', 'no', 'nor', 'but', 'if', 'then', 'than',
  'so', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
  'should', 'may', 'might', 'must', 'shall', 'i', 'you', 'he', 'she', 'we', 'they',
  'me', 'him', 'her', 'us', 'them', 'my', 'your', 'our', 'their', 'what', 'which',
  'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'too', 'very',
  's', 't', 'just', 'now', 'there', 'here', 'about', 'into', 'over', 'under',
]);

/**
 * 分词：中文 2-gram 滑窗 + 英文 [a-z0-9]+ 切词，去停用词，返回去重数组（保序）。
 * @param {string} s
 * @returns {string[]}
 */
export function tokenize(s) {
  const norm = normalizeText(s);
  const tokens = [];
  const seen = new Set();
  const push = (t) => {
    if (t && !seen.has(t)) { seen.add(t); tokens.push(t); }
  };
  // 先抽 CJK 段做 2-gram
  const cjkRuns = norm.match(/\p{Script=Han}+/gu) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) { push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) push(run.slice(i, i + 2));
  }
  // 英文/数字词
  const words = norm.match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    if (!STOPWORDS.has(w)) push(w);
  }
  return tokens;
}
