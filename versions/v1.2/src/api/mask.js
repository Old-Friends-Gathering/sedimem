// api/mask.js — suspicious 遮蔽的单一实现（契约：docs/02 §3.9 裁决 16、§3.11 裁决 42）
// 只遮 text/value 会被「把 payload 挪进 subject / source.quote」绕过，故四个正文字段一起遮。

export const SUSPICIOUS_MASK = '[suspicious withheld]';

/**
 * 按需遮蔽一条记录。非 suspicious 或显式 includeSuspicious 时原样返回（同一引用，零拷贝）。
 * @param {object} r MemoryRecord
 * @param {boolean} includeSuspicious
 * @returns {object}
 */
export function maskSuspiciousRecord(r, includeSuspicious = false) {
  if (includeSuspicious) return r;
  if (!(Array.isArray(r.tags) && r.tags.includes('suspicious'))) return r;
  return {
    ...r,
    text: SUSPICIOUS_MASK,
    value: SUSPICIOUS_MASK,
    subject: SUSPICIOUS_MASK,
    predicate: SUSPICIOUS_MASK,
    source: r.source && r.source.quote !== undefined
      ? { ...r.source, quote: SUSPICIOUS_MASK }
      : r.source,
  };
}
