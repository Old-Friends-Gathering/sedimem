// 聊天纠正 7 类 matcher（B7.5）——只做归类与目标定位，不写真相层。
// 规格：docs/design/v2.0/09-extraction-pipeline.md §7「纠正 matcher（B7.5 落地）」
// 判定顺序固定：retraction → correction → quote → assistant-claim → tool-failure → cross-scope → disputed → null
// 匹配键：先 scope+subject+predicate；缺 predicate 退化为 scope+about+归一文本并标 matcher='degraded'。

export const CORRECTION_KINDS = Object.freeze([
  'correction',
  'retraction',
  'quote',
  'assistant-claim',
  'cross-scope',
  'tool-failure',
  'disputed',
]);

const RETRACTION_RE = /(先别改|别改|不用改|仍然用|仍用|保持原值|撤销|作废|撤回|ignore that|never mind|revert)/iu;
const CORRECTION_RE = /(说错了|纠正|应为|应该是|改成|改为|而不是|不是.{0,12}而是|correct to|should be|rather than)/iu;
const QUOTE_RE = /(文档(里|中)?说|引用|代码示例|示例里|per the doc|the doc says|quoted from|according to the doc)/iu;
const ASSISTANT_CLAIM_RE = /(我已经|我已|助手|assistant).{0,12}(完成|部署|修好|done|finished)/iu;
const TOOL_FAILURE_RE = /(exit code [1-9]|退出码 [1-9]|执行失败|命令失败|failed with|non-zero exit)/iu;
const DISPUTED_RE = /(不知道哪个对|无法判定|两个来源冲突|互相矛盾|conflicting|cannot determine)/iu;

const DIGITS_RE = /\d+(?:\.\d+)?/gu;
const CROSS_PROJECT_RE = /(另一个项目|其他项目|别的项目|另一个仓库|other project)/iu;

function numbersIn(text) {
  return [...String(text ?? '').match(DIGITS_RE) ?? []];
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/gu, '').replace(/[。；;！!?？]+$/u, '');
}

function subjectOf(record) {
  return record.assertion?.subject ?? record.about ?? null;
}

function bigrams(text) {
  const t = normalize(text);
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function overlapScore(a, b) {
  let n = 0;
  for (const g of a) if (b.has(g)) n += 1;
  return n;
}

export const TARGET_MIN_SCORE = 2;

function pickTarget(truth, { text, scope }) {
  const tb = bigrams(text);
  const nums = numbersIn(text);
  const sameScope = (truth ?? []).filter((t) => t.scope === scope);

  // 精确：有 predicate 的记录按 claim 二元组重合 + 值数字命中打分
  let best = null;
  let bestScore = 0;
  for (const t of sameScope) {
    if (!t.assertion?.predicate) continue;
    const score =
      overlapScore(tb, bigrams(t.claim ?? '')) +
      (numbersIn(t.assertion?.value).some((n) => nums.includes(n)) ? 2 : 0);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  // 阈值 ≥2：单一 bigram 偶然重合不足以决定覆盖目标
  if (best && bestScore >= TARGET_MIN_SCORE) return { target: best, matcher: 'exact' };

  // 退化：缺 predicate 时按 scope + 文本重合
  let degradedHit = null;
  let degradedScore = 0;
  for (const t of sameScope) {
    const score = overlapScore(tb, bigrams(t.claim ?? ''));
    if (score > degradedScore) {
      degradedHit = t;
      degradedScore = score;
    }
  }
  if (degradedHit && degradedScore >= TARGET_MIN_SCORE) return { target: degradedHit, matcher: 'degraded' };
  return { target: null, matcher: 'exact' };
}

/**
 * matchCorrection({ text, truth, scope, role }) →
 *   { kind, targetRecordId, newValue, matcher, reason }
 * kind ∈ CORRECTION_KINDS ∪ {null}
 */
// M4：newValue 只在更正标记之后的窗口内取数，并剔除被否定/被对照的值与旧值本身
export const CORRECTION_WINDOW = 40;

/** 找出更正标记的位置（取最靠后一个，接近真实修订表述） */
function markerIndex(t) {
  const re = /改成|改为|应为|应该改为|纠正为|correct(?:ed)?\s+to|should\s+be|change\s+to/giu;
  let idx = -1;
  for (const m of t.matchAll(re)) idx = m.index;
  return idx;
}

/**
 * 在标记窗口内取新值：先排除旧值与「而不是/not」之后的数字。
 * @param {string} t 文本
 * @param {string|null} existingValue 既有值
 * @returns {string|null}
 */
// 注意：该正则用于 .test()，**禁止**加 g/y 标志（lastIndex 残留会让结果随调用次数翻转）
const KEEP_RE = /保持|不变|仍用|继续用|维持|still|keep\s+(?:it\s+)?(?:at|as)/iu;

/**
 * 文本是否声明「既有的这个值保持不变」（示例：「端口保持 8080」「8080 不变」）。
 * @param {string} t 文本
 * @param {string} v 既有值
 * @returns {boolean}
 */
export function isKept(t, v) {
  const s = String(t ?? '');
  const target = String(v ?? '');
  if (!s || !target) return false;
  const idx = s.indexOf(target);
  if (idx < 0) return false;
  const before = s.slice(Math.max(0, idx - 12), idx);
  const after = s.slice(idx + target.length, idx + target.length + 8);
  return KEEP_RE.test(before) || KEEP_RE.test(after);
}

export function pickNewValue(t, existingValue) {
  const idx = markerIndex(t);
  const windowText = idx >= 0 ? t.slice(idx, idx + CORRECTION_WINDOW) : t;
  const negated = new Set();
  const negRe = /而不是|不是|而非|not|instead\s+of/giu;
  for (const m of windowText.matchAll(negRe)) {
    const tail = windowText.slice(m.index + m[0].length, m.index + m[0].length + CORRECTION_WINDOW);
    for (const n of numbersIn(tail)) negated.add(n);
  }
  const inWindow = numbersIn(windowText).filter((n) => n !== existingValue && !negated.has(n));
  if (inWindow.length) return inWindow[0];
  // 窗口内无可用值时退化到全文（仍排除旧值与被否定值）
  const fallback = numbersIn(t).filter((n) => n !== existingValue && !negated.has(n));
  return fallback[0] ?? null;
}

export function matchCorrection({ text, truth = [], scope = null, role = 'user' } = {}) {
  const t = String(text ?? '');
  if (!t.trim()) return { kind: null, targetRecordId: null, newValue: null, matcher: 'exact', reason: '空文本' };

  const { target, matcher } = pickTarget(truth, { text: t, scope });
  // m3：目标须有足够置信（打分 ≥2），否则视为无目标（避免 supersede 同名错记录）
  const targetRecordId = target?.recordId ?? null;
  const existingValue = target?.assertion?.value != null ? String(target.assertion.value) : null;
  // N3 补：文本声明「保持/不变/仍用 <既有值>」时不得覆盖该记录（无人值守 fail-closed，交人工复核）
  if (existingValue && isKept(t, existingValue)) {
    if (RETRACTION_RE.test(t)) {
      return { kind: 'retraction', targetRecordId, newValue: null, matcher, confidence: 0.9, reason: '撤回式：既有值保持不变' };
    }
    // 非撤回式但显式保持 → 不覆盖、不产候选（交人工复核）
    return { kind: null, targetRecordId: null, newValue: null, matcher: 'exact', confidence: 0.5, reason: '既有值被显式保持' };
  }
  const newValue = pickNewValue(t, existingValue);

  // m5：确定性置信度（exact 依赖 predicate/值精确命中，degraded 走 text+about 退化）
  const confidence = matcher === 'exact' ? 0.9 : 0.6;
  const base = { targetRecordId, newValue, matcher, confidence };

  // 1) retraction：撤回式且没有可用的新值
  if (RETRACTION_RE.test(t) && newValue === null) {
    return { ...base, kind: 'retraction', reason: '撤回式且无新值' };
  }
  // 1b) cross-scope 守卫（先于类判定）：跨项目表述一律不得覆盖本 scope 记录
  if (CROSS_PROJECT_RE.test(t)) {
    return { ...base, kind: 'cross-scope', newValue: null, reason: '出现跨项目表述' };
  }
  // 2) correction：更正式且新值可解析
  if (CORRECTION_RE.test(t) && newValue !== null) {
    return { ...base, kind: 'correction', reason: '更正式且新值可解析' };
  }
  // 3) quote：引用他人/文档/示例
  if (QUOTE_RE.test(t)) {
    return { ...base, kind: 'quote', newValue: null, reason: '引用位置' };
  }
  // 4) assistant-claim：助手自称完成（角色必须是 assistant）
  if (role === 'assistant' && ASSISTANT_CLAIM_RE.test(t)) {
    return { ...base, kind: 'assistant-claim', newValue: null, reason: '助手自称完成' };
  }
  // 5) tool-failure：工具失败/退出码非 0
  if (TOOL_FAILURE_RE.test(t)) {
    return { ...base, kind: 'tool-failure', newValue: null, reason: '工具执行失败' };
  }
  // 6) disputed：两来源冲突且不可判定
  if (DISPUTED_RE.test(t)) {
    return { ...base, kind: 'disputed', newValue: null, reason: '两来源冲突不可判定' };
  }
  return { ...base, kind: null, reason: '不是纠正' };
}
