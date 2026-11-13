// capture/extract.js — 半自动捕获：从会话文本/文件抽取候选事实（D3，任务 B2）
// 确定性启发式、零 LLM：只做「候选发现」，入库必须经队列人工/Agent 确认（accept 走 V1–V5 门禁）。

import { normalizeText } from '../core/hash.js';

/** 引导词：命中即视为「显式要求记住」的句子 */
const CUE_WORDS = ['记住', '记一下', '以后', '约定', '决定', '必须', '禁止', '不要'];
/**
 * 引导词里表达「规范性约定」的词 → decision；其余（记住/记一下/以后）只是
 * 「请记下来」，抽取成 fact 更贴近事实面，等后续被引用时再升级为 decision。
 * 这条划分写进 docs/02 裁决 62（分工：fact 描述世界，decision 约束行为）。
 */
const CUE_DECISION_WORDS = ['约定', '决定', '必须', '禁止', '不要'];
/** 显式前缀 → kind（问题： 的 bug 在 accept 时回落 gotcha，policy kinds 无 bug） */
const PREFIX_KINDS = [
  ['结论：', 'fact'],
  ['注意：', 'gotcha'],
  ['坑：', 'gotcha'],
  ['问题：', 'bug'],
];
/** URL 行（http/https/ftp 开头，或行内几乎全是链接） */
const URL_RE = /^\s*(https?:\/\/|ftp:\/\/)\S*\s*$/;
/** 纯标点/空白行（含全角标点与 markdown 修饰符） */
const PUNCT_RE = /^[\s\p{P}\p{S}\p{Cf}]+$/u;
/** 邮件签名：分隔线 -- / 常见落款开头 */
const SIGNATURE_RE = /^\s*(--\s*$|—{2,}\s*$|(best\s+regards|regards|thanks|sent\s+from|发自我的|此致|敬上)[,，.!！]?\s*$)/i;
/** 列表项：`- ` / `* ` / `1. ` / `1、` */
const LIST_RE = /^\s*(?:[-*]\s+|\d+[.、)]\s+)/;

/**
 * 行内前缀判定（全角冒号优先，兼容半角）。
 * @param {string} line
 * @returns {{kind: string, reason: string}|null}
 */
function matchPrefix(line) {
  for (const [prefix, kind] of PREFIX_KINDS) {
    const half = prefix.replace('：', ':');
    if (line.startsWith(prefix)) return { kind, reason: `前缀 ${prefix}` };
    if (half !== prefix && line.toLowerCase().startsWith(half)) {
      return { kind, reason: `前缀 ${half}` };
    }
  }
  return null;
}

/**
 * 引导词判定：命中 CUE_WORDS → 含 不要/禁止 记 decision，否则 fact。
 * @param {string} line
 * @returns {{kind: string, reason: string}|null}
 */
function matchCue(line) {
  for (const w of CUE_WORDS) {
    if (line.includes(w)) {
      const decision = CUE_DECISION_WORDS.some((d) => line.includes(d));
      return { kind: decision ? 'decision' : 'fact', reason: `引导词 ${w}` };
    }
  }
  return null;
}

/**
 * 从文本抽取候选记忆（确定性启发式，D3）。
 * 规则（按优先级）：
 *   1. 前缀 结论：/注意：/坑：/问题： → fact/gotcha/gotcha/bug；
 *   2. 引导词 记住/记一下/以后/约定/决定/必须/禁止/不要 → decision（含 不要/禁止）否则 fact；
 *   3. 列表项（`- ` 或数字点开头）且长度 >= 8 → fact。
 * 跳过：三反引号代码块内的行、URL 行、纯标点行、超长行（> maxLineChars）、邮件签名行。
 * 去重：normalizeText 后同文本只保留首条。
 * @param {string} text 原始文本
 * @param {{maxLineChars?: number, maxItems?: number}} [opts]
 * @returns {{text: string, kind: string, reason: string}[]}
 */
export function extractCandidates(text, { maxLineChars = 400, maxItems = 50 } = {}) {
  if (typeof text !== 'string') {
    const err = new Error('extractCandidates: text must be a string');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const out = [];
  const seen = new Set();
  let inCodeBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    if (line === '') continue;
    if (URL_RE.test(line)) continue;
    if (PUNCT_RE.test(line)) continue;
    if (SIGNATURE_RE.test(line)) continue;
    if (line.length > maxLineChars) continue;

    let hit = matchPrefix(line);
    if (!hit) hit = matchCue(line);
    if (!hit && LIST_RE.test(line) && line.length >= 8) {
      hit = { kind: 'fact', reason: '列表项' };
    }
    if (!hit) continue;

    const norm = normalizeText(line);
    if (norm === '' || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ text: line, kind: hit.kind, reason: hit.reason });
    if (out.length >= maxItems) break;
  }
  return out;
}
