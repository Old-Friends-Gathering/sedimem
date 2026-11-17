// hygiene/suspicious.js — 投毒检测（I5 强化版）。
// 归一化只用于匹配，绝不改存储原文。
// 导出：isSuspicious(text, patterns, opts?) / detectSuspicious(text, patterns, opts?)
//   -> { suspicious: boolean, matched: string[], reason: string }
// 三条启发式（可用 POLICY.suspiciousHeuristics 逐条关闭，缺省全 true）：
//   encoded    —— 整段或 ≥40 连续 token 的 base64 串，解码成功且解码结果含 CJK 或命中 patterns
//   spaced_cjk —— 原文含 ≥3 个「单个 CJK 字符 + 空格」序列，且折叠后命中 patterns（防拆字绕过）
//   pinyin     —— 按空格切分 ≥5 token 且 ≥80% 属拼音音节集合，且文本长度 ≥20（宁多标，读路径已隔离：裁决 16）

// 异体字折叠表、零宽/CJK 空格正则与匹配用归一化已单点化到 core/text.js（W2）。
// 「单个 CJK 字符 + 空白」序列（拆字检测用，作用于归一化前的原文）
const SPACED_CJK_RE = /[\u4e00-\u9fff]\s+/g;
const ENCODED_TOKEN_RE = /^[A-Za-z0-9+/=_-]{40,}$/;

// —— 拼音音节集合（声母 × 韵母的常用组合，约 410 个）——
const INITIALS = ['b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'zh', 'ch', 'sh', 'r', 'z', 'c', 's', 'y', 'w', ''];
const FINALS = ['a', 'o', 'e', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'er',
  'i', 'ia', 'io', 'ie', 'iao', 'iu', 'ian', 'in', 'iang', 'ing', 'iong',
  'u', 'ua', 'uo', 'uai', 'ui', 'uan', 'un', 'uang', 'ong',
  'ü', 'üe', 'üan', 'ün'];
const PINYIN_SYLLABLES = new Set();
for (const i of INITIALS) {
  for (const f of FINALS) {
    PINYIN_SYLLABLES.add(i + f);
  }
}
PINYIN_SYLLABLES.add('ê'); PINYIN_SYLLABLES.add('ei'); PINYIN_SYLLABLES.add('n'); PINYIN_SYLLABLES.add('ng'); PINYIN_SYLLABLES.add('hm'); PINYIN_SYLLABLES.add('hng');


import { normalizeForMatch, containsCjk } from '../core/text.js';

// 既有模块契约：外部（tests 等）仍从本文件 import normalizeForMatch。
export { normalizeForMatch };

/** patterns 子串匹配（对归一化文本；pattern 自身也做归一化，命中忽略大小写/全角差异） */
function matchPatterns(normalized, patterns) {
  const matched = [];
  for (const p of patterns ?? []) {
    const ps = String(p ?? '');
    if (ps === '') continue;
    if (normalized.includes(normalizeForMatch(ps)) || normalized.includes(ps.toLowerCase())) {
      matched.push(ps);
    }
  }
  return matched;
}

/** base64 / base64url 解码（失败返回 null）。解码结果必须含可打印内容才视为成功。 */
function tryDecodeBase64(token) {
  let t = token.replace(/=+$/, '');
  if (t.length < 8) return null;
  t = t.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 === 0 ? '' : '='.repeat(4 - (t.length % 4));
  let buf;
  try {
    buf = Buffer.from(t + pad, 'base64');
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  const decoded = buf.toString('utf8');
  // 解码产物须大体可打印（含 CJK/字母/数字/常用标点空白），排除随机二进制假阳性
  if (!/^[\u0009\u000a\u000d\u0020-\u007e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u00c0-\u024f]*$/.test(decoded)) return null;
  return decoded;
}

/**
 * 启发式 encoded：整段或 ≥40 的连续 token 命中 base64 字符集，且解码成功且
 * 解码结果含 CJK 或（归一化后）命中 patterns。
 */
function heuristicEncoded(text, normalizedPatternsHit, patterns) {
  const whole = String(text ?? '').trim();
  const candidates = whole.split(/\s+/).filter((t) => ENCODED_TOKEN_RE.test(t));
  // 整段本身即 base64 串（≥16 字符，无空白分隔的短编码也算）；或含 ≥40 连续 token
  if (candidates.length === 0 && !/^[A-Za-z0-9+/=_-]{16,}$/.test(whole)) return false;
  const pool = candidates.length > 0 ? candidates : [whole];
  for (const tok of pool) {
    const decoded = tryDecodeBase64(tok);
    if (decoded === null) continue;
    if (containsCjk(decoded)) return true;
    const dn = normalizeForMatch(decoded);
    if (matchPatterns(dn, patterns).length > 0) return true;
  }
  return false;
}

/**
 * 启发式 spaced_cjk：原文（归一化前）含 ≥3 个「单个 CJK 字符 + 空白」序列，
 * 且空白折叠后命中 patterns。
 */
function heuristicSpacedCjk(text, patterns) {
  const raw = String(text ?? '');
  const spaced = raw.match(SPACED_CJK_RE) ?? [];
  if (spaced.length < 3) return false;
  return matchPatterns(normalizeForMatch(raw), patterns).length > 0;
}

/**
 * 启发式 pinyin：按空格切分 token 数 ≥5 且 ≥80% 属拼音音节集合，且文本长度 ≥20。
 * 简化裁决：宁可多标（读路径已隔离，裁决 16）。
 */
function heuristicPinyin(text) {
  const raw = String(text ?? '');
  if (raw.length < 20) return false;
  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 5) return false;
  const hit = tokens.filter((t) => PINYIN_SYLLABLES.has(t)).length;
  return hit / tokens.length >= 0.8;
}

/**
 * 投毒检测主入口。
 * @param {string} text 待检文本（存储原文，不做修改）
 * @param {string[]} patterns 可疑模式串（POLICY.suspiciousPatterns）
 * @param {{heuristics?: {encoded?: boolean, spaced_cjk?: boolean, pinyin?: boolean}}} [opts]
 * @returns {{suspicious: boolean, matched: string[], reason: string}}
 */
export function detectSuspicious(text, patterns, opts = {}) {
  const h = { encoded: true, spaced_cjk: true, pinyin: true, ...(opts.heuristics ?? {}) };
  const raw = String(text ?? '');
  const normalized = normalizeForMatch(raw);
  const matched = matchPatterns(normalized, patterns);
  if (matched.length > 0) {
    return { suspicious: true, matched, reason: `pattern:${matched[0]}` };
  }
  if (h.encoded && heuristicEncoded(raw, false, patterns)) {
    return { suspicious: true, matched, reason: 'heuristic:encoded' };
  }
  if (h.spaced_cjk && heuristicSpacedCjk(raw, patterns)) {
    return { suspicious: true, matched, reason: 'heuristic:spaced_cjk' };
  }
  if (h.pinyin && heuristicPinyin(raw)) {
    return { suspicious: true, matched, reason: 'heuristic:pinyin' };
  }
  return { suspicious: false, matched: [], reason: '' };
}

/** 便捷布尔版。 */
export function isSuspicious(text, patterns, opts) {
  return detectSuspicious(text, patterns, opts).suspicious;
}
