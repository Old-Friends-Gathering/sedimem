// render/tier0.js — Tier-0 注入目录（v0.3 C 路，issue #51）。
// 为什么单独一层：dsh-auto-memory 的实测教训是「纯优先级注入必然塌成单层吃光预算」，
// 所以默认注入的是一个 ≤800 字符的「一条一行」目录（标题·结论·日期·id 截断），
// Agent 需要原文时再按 id 用 memory_get 下钻——渐进披露，证据链靠 id 保留。
// 纯函数、零依赖（node: 内置也不用）：同输入必同输出，方便 eval 与视图重建。

import { detectSuspicious } from '../hygiene/suspicious.js';
import { loadPolicy } from '../config/policy.js';

const DEFAULT_TIER0_CHARS = 800;
// 模式必须显式传入：detectSuspicious 的第二参是必填的 patterns，
// 漏传等于「一条规则都没有」——对抗审核①就是这么绕过 I5 的（value 没扫 + 规则没传）。
const POISON_PATTERNS = loadPolicy()?.suspiciousPatterns ?? [];

/**
 * 未过期判定：validTo 为空，或晚于 nowMs（"未过期"含软失效时间未到者）。
 * @param {import('../core/record.js').MemoryRecord} r
 * @param {number} nowMs
 */
function isLive(r, nowMs) {
  if (r.status !== 'active') return false;
  if (r.expiredAt) return false;
  if (r.validTo == null) return true;
  const t = Date.parse(r.validTo);
  return Number.isFinite(t) ? t > nowMs : true;
}

/** now 入参归一为毫秒：number 直接用；string 走 Date.parse；缺省系统时间。 */
function nowMsOf(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string') {
    const t = Date.parse(now);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

/**
 * 这条记录是否应当整行跳过（投毒防线，对抗审核①实测：value 从来没人扫，
 * 于是 `memo brief` 干净、`memo brief --tier0` 却把 value 原文喂进 prompt）。
 * 判据与 brief 的扁平路径一致：tags 命中 suspicious，或任一正文字段命中检测器。
 */
function isPoisoned(r) {
  if (Array.isArray(r.tags) && r.tags.includes('suspicious')) return true;
  const joined = [r.subject, r.predicate, r.value, r.text]
    .filter((x) => typeof x === 'string' && x !== '')
    .join(' ');
  return detectSuspicious(joined, POISON_PATTERNS).suspicious === true;
}

/** 一条一行：结构化走 subject/predicate = value；unstructured 用 text 前 40 字。 */
function entryLine(r) {
  const date = String(r.createdAt ?? '').slice(0, 10) || 'unknown';
  // 完整 ULID：这一行的作用就是「让 Agent 能拿 id 去 memory_get 反查原文」（证据链），
  // 截断会让 id 无法使用，宁可每行多花 ~20 字符（预算里已经算进去）。
  const idMark = String(r.id ?? '');
  const s = String(r.subject ?? 'text');
  const p = String(r.predicate ?? 'text');
  let head;
  if (s === 'text' && p === 'text') {
    head = String(r.text ?? '').slice(0, 40);
  } else {
    head = `${s}/${p} = ${String(r.value ?? '')}`;
  }
  return `[${r.kind}] ${head} (id ${idMark}, ${date})`;
}

/**
 * 渲染 Tier-0 目录。
 * 排序：hits 降序 → createdAt 降序 → id 升序（确定性 tie-break）。
 * 字符上限 policy.brief?.tier0Chars ?? 800，按字符数（含换行）计；
 * 超限逐行累加直到放不下，truncated = 放不下的条数；末尾「…还有 N 条」
 * 本身也计入上限，放不下就不加。
 * @param {import('../core/record.js').MemoryRecord[]} records
 * @param {{policy?: object, now?: number|string}} [opts]
 * @returns {{text: string, lines: string[], chars: number, truncated: number}}
 */
export function renderTier0(records, { policy, now } = {}) {
  if (!Array.isArray(records)) {
    const err = new Error('renderTier0: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const limit = policy?.brief?.tier0Chars ?? DEFAULT_TIER0_CHARS;
  const nowMs = nowMsOf(now);

  // 投毒记录整行剔除：Tier-0 是**注入**路径（进 prompt），不能像 search 那样「默认遮蔽但可显式取」。
  // 这条与 I5「suspicious 绝不进 brief」是同一个不变量，只是换了个渲染器。
  const live = records.filter((r) => r && isLive(r, nowMs) && !isPoisoned(r));
  if (live.length === 0) {
    return { text: '', lines: [], chars: 0, truncated: 0 };
  }

  const ordered = [...live].sort((a, b) => {
    if ((b.hits ?? 0) !== (a.hits ?? 0)) return (b.hits ?? 0) - (a.hits ?? 0);
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });

  const lines = [];
  let used = 0; // 已累计字符数（含行间换行）
  let truncated = 0;
  for (const r of ordered) {
    const line = entryLine(r);
    const add = lines.length === 0 ? line.length : line.length + 1;
    if (used + add > limit) {
      truncated = ordered.length - lines.length;
      break;
    }
    lines.push(line);
    used += add;
  }

  // 截断标记行本身也算进上限：放不下就不加（truncated 计数不变）。
  if (truncated > 0) {
    const mark = `…还有 ${truncated} 条`;
    if (used + mark.length + 1 <= limit) {
      lines.push(mark);
      used += mark.length + 1;
    }
  }

  return { text: lines.join('\n'), lines, chars: used, truncated };
}
