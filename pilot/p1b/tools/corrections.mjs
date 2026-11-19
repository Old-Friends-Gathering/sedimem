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
  if (best) return { target: best, matcher: 'exact' };

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
  if (degradedHit) return { target: degradedHit, matcher: 'degraded' };
  return { target: null, matcher: 'exact' };
}

/**
 * matchCorrection({ text, truth, scope, role }) →
 *   { kind, targetRecordId, newValue, matcher, reason }
 * kind ∈ CORRECTION_KINDS ∪ {null}
 */
export function matchCorrection({ text, truth = [], scope = null, role = 'user' } = {}) {
  const t = String(text ?? '');
  if (!t.trim()) return { kind: null, targetRecordId: null, newValue: null, matcher: 'exact', reason: '空文本' };

  const { target, matcher } = pickTarget(truth, { text: t, scope });
  const targetRecordId = target?.recordId ?? null;
  const nums = numbersIn(t);
  const existingValue = target?.assertion?.value != null ? String(target.assertion.value) : null;
  const newValue = nums.find((n) => n !== existingValue) ?? null;

  const base = { targetRecordId, newValue, matcher };

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
