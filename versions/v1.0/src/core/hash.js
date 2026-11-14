// core/hash.js — 内容哈希（契约：docs/02 §3）
// normalizeText / tokenize 已单点化到 core/text.js（W2），这里 re-export
// 保持既有 import 路径（../core/hash.js）与行为完全不变。
// contentHash 输入顺序：normalizeText(text) + '\u0001' + subject + '\u0001' + predicate + '\u0001' + value

import { createHash } from 'node:crypto';

import { normalizeText } from './text.js';

export { normalizeText, tokenize } from './text.js';

/**
 * 内容哈希：sha256(normalizeText(text) ⊕ subject ⊕ predicate ⊕ value)
 * @returns {'sha256:<64hex>'}
 */
export function contentHash({ text, subject, predicate, value }) {
  const input = [normalizeText(String(text ?? '')), String(subject ?? ''), String(predicate ?? ''), String(value ?? '')].join('\u0001');
  return 'sha256:' + createHash('sha256').update(input, 'utf8').digest('hex');
}
