// core/text.js — 三族文本函数的单点实现（W2 单点化，行为零变化）。
// 逻辑「原样搬」自：src/core/hash.js（normalizeText/tokenize）、
//   src/hygiene/suspicious.js（normalizeForMatch/异体字表/CJK 判定）、
//   src/hygiene/conflict.js（charBigrams/signatureSimilarity/containment）。
// hash.js / suspicious.js / conflict.js 只做 re-export，不再留第二份实现。

// ─── 归一化（内容哈希口径，源自 core/hash.js）──────────────────────────

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

// ─── 匹配用归一化（投毒检测口径，源自 hygiene/suspicious.js）────────────

// —— 异体字折叠表（常见 30 组，归一化时一并折叠）——
const VARIANT_GROUPS = [
  ['略', '畧'], ['请', '請'], ['执', '執'], ['令', '令'], ['务', '務'],
  ['级', '級'], ['记', '記'], ['录', '錄'], ['删', '刪'], ['输', '輸'],
  ['密码', '密碼'], ['钥', '鑰'], ['钥', '钥'], ['证', '證'], ['书', '書'],
  ['读', '讀'], ['写', '寫'], ['传', '傳'], ['输', '輸'], ['递', '遞'],
  ['环', '環'], ['境', '境'], ['变', '變'], ['量', '量'], ['设', '設'],
  ['置', '置'], ['覆', '覆'], ['盖', '蓋'], ['盖', '盖'], ['锁', '鎖'],
  ['忽', '忽'], ['略', '略'], ['所', '所'], ['有', '有'], ['指', '指'],
];
/** 单字符异体折叠映射（异体 → 规范体）。多字符组按整串替换处理。 */
const VARIANT_CHAR_MAP = new Map();
const VARIANT_MULTI = [];
for (const [std, ...variants] of VARIANT_GROUPS) {
  for (const v of variants) {
    if (v.length === 1) VARIANT_CHAR_MAP.set(v, std);
    else VARIANT_MULTI.push([v, std]);
  }
}

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060]/g;
const CJK_BETWEEN_SPACES_RE = /(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g;

/**
 * 匹配用归一化（不改存储原文）：
 * NFKC（全角→半角）→ 删零宽字符 → 异体字折叠 → CJK 之间空白折叠 → 小写。
 * @param {string} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  let s = String(text ?? '');
  s = s.normalize('NFKC');
  s = s.replace(ZERO_WIDTH_RE, '');
  for (const [v, std] of VARIANT_MULTI) s = s.split(v).join(std);
  if (VARIANT_CHAR_MAP.size) {
    s = s.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, (ch) => VARIANT_CHAR_MAP.get(ch) ?? ch);
  }
  s = s.replace(CJK_BETWEEN_SPACES_RE, '');
  return s.toLowerCase();
}

/** 是否含 CJK（汉字 U+4E00–U+9FFF）。 */
export function containsCjk(s) {
  return /[\u4e00-\u9fff]/.test(String(s ?? ''));
}

// ─── 分词（源自 core/hash.js）─────────────────────────────────────────

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

// ─── 相似度（源自 hygiene/conflict.js，裁决 14/15/26）──────────────────

/**
 * containment（裁决 14/15）：token 集合 |A∩B| / min(|A|,|B|)。
 * 选 containment 而非 Jaccard：同一事实的不同长度措辞，短句应被长句吸收。
 * 空文本（无 token）→ 0，避免空集误判全匹配。
 * @param {string} aText
 * @param {string} bText
 * @returns {number} [0, 1]
 */
export function containment(aText, bText) {
  const a = new Set(tokenize(String(aText ?? '')));
  const b = new Set(tokenize(String(bText ?? '')));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

/**
 * 汉字二元组集合（裁决 26）：只用 normalizeText 后的 Han 连续段切 2-gram。
 * 为什么不用全字符：拉丁短句里 "th"/"he"/"ing" 这类碎片会把无关英文对推到 0.2+。
 * @param {string} s
 * @returns {Set<string>} 无汉字 → 空集合
 */
export function charBigrams(s) {
  const norm = normalizeText(String(s ?? ''));
  const grams = new Set();
  for (const run of norm.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) { grams.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) grams.add(run.slice(i, i + 2));
  }
  return grams;
}

/**
 * 对称相似度（裁决 26）：汉字二元组 Dice = 2|A∩B| / (|A|+|B|)。
 * 任一侧不含汉字 → 返回 0（交给 containment）。
 * @param {string} aText
 * @param {string} bText
 * @returns {number} [0, 1]
 */
export function signatureSimilarity(aText, bText) {
  const a = charBigrams(aText);
  const b = charBigrams(bText);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}
