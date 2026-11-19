// R4 异议生成器（B7.4）——独立于决策矩阵的「第二遍核对」，只提异议、不当裁判。
// 规格：docs/design/v2.0/09-extraction-pipeline.md §5「R4 异议生成器（B7.4 落地）」
// 纪律：
//   - 不读决策矩阵中间状态，不接收调用方布尔开关（生产入口由管线自己生成）；
//   - 输出 { objection: {kind, resolvable, reason, targetRecordId} | null }；
//   - 判定顺序固定：scope-alias → temporal-drift → quote-value-mismatch → value-conflict。

// 更正式标记（M2：裸「不是」不算，必须是否定式更正「不是…而是/应…」或显式改写词）
const CORRECTION_MARKERS = ['改成', '改为', '应为', '应该是', '纠正', '而应', 'instead', 'correct to', 'should be', 'rather than'];
const NOT_BUT_RE = /不是[^。；;\n]{0,20}(而是|应|改成|改为)/u;

const DIGITS_RE = /\d+(?:\.\d+)?/gu;

// m2：数字归一再比较（v2.0 → 2，30.0 → 30），避免同值不同写法误报
function normalizeNumber(raw) {
  const t = String(raw).replace(/^[vV]/u, '');
  if (/^\d+(?:\.\d+)?$/u.test(t)) return String(Number(t));
  return t;
}

function numbersIn(text) {
  const raw = String(text ?? '');
  const out = new Set();
  for (const m of raw.match(DIGITS_RE) ?? []) out.add(normalizeNumber(m));
  for (const m of raw.match(/[vV]\d+(?:\.\d+)?/gu) ?? []) out.add(normalizeNumber(m));
  return out;
}

function hasCorrectionMarker(text) {
  const t = String(text ?? '').toLowerCase();
  return CORRECTION_MARKERS.some((m) => t.includes(m.toLowerCase())) || NOT_BUT_RE.test(String(text ?? ''));
}

function sameKeyValue(a, b) {
  return String(a ?? '') === String(b ?? '');
}

function findConflict(truth, claim) {
  const a = claim.assertion ?? {};
  if (!a.subject || !a.predicate) return null;
  return (
    (truth ?? []).find(
      (t) =>
        t.scope === claim.scope &&
        t.assertion?.subject === a.subject &&
        t.assertion?.predicate === a.predicate &&
        !sameKeyValue(t.assertion?.value, a.value),
    ) ?? null
  );
}

/**
 * generateObjection({ claim, truth, sourceScope }) → { objection, ignoredCallerObjection? }
 * claim = { claim, scope, assertion:{subject,predicate,value,assertedValidFrom}, evidence:[{eventId,quote,ts}] }
 */
export function generateObjection({ claim, truth = [], sourceScope = null, objection = undefined } = {}) {
  const out = { objection: null };
  if (objection !== undefined) out.ignoredCallerObjection = true; // 生产入口不得注入
  if (!claim || typeof claim !== 'object') return out;

  const a = claim.assertion ?? {};
  const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
  const texts = [claim.claim ?? '', ...evidence.map((e) => e.quote ?? '')];
  const evidenceText = evidence.map((e) => e.quote ?? '').join(' ');

  // 1) scope-alias：与来源绑定 scope 不同但主体同名 → 不可消解
  if (sourceScope && claim.scope && claim.scope !== sourceScope) {
    out.objection = {
      kind: 'scope-alias',
      resolvable: false,
      reason: `候选 scope="${claim.scope}" 与来源绑定 scope="${sourceScope}" 不同`,
      targetRecordId: null,
    };
    return out;
  }

  // 2) temporal-drift：证据事件时间早于业务生效起点 → 不可消解
  const from = a.assertedValidFrom;
  if (from) {
    const fromMs = Date.parse(from);
    const drifted = evidence.some((e) => {
      const tsMs = Date.parse(e.ts ?? '');
      return Number.isFinite(tsMs) && Number.isFinite(fromMs) && tsMs < fromMs;
    });
    if (drifted) {
      out.objection = {
        kind: 'temporal-drift',
        resolvable: false,
        reason: '证据事件时间早于 assertedValidFrom',
        targetRecordId: null,
      };
      return out;
    }
  }

  // 3) quote-value-mismatch：引文字面值不含 assertion.value → 需要更正信息才能消解
  if (evidenceText && a.value != null && String(a.value).trim() !== '') {
    const quoted = numbersIn(evidenceText);
    const declared = numbersIn(String(a.value));
    const missing = [...declared].filter((n) => !quoted.has(n));
    if (quoted.size > 0 && missing.length > 0) {
      const resolvable = hasCorrectionMarker(texts.join(' ')) && missing.length === declared.size;
      out.objection = {
        kind: 'quote-value-mismatch',
        resolvable,
        reason: `引文数值 ${[...quoted].join(',')} 不含声明值 ${a.value}`,
        targetRecordId: null,
      };
      return out;
    }
  }

  // 4) value-conflict：真相层同 scope+subject+predicate 但值不同
  const conflict = findConflict(truth, claim);
  if (conflict) {
    const declared = [...numbersIn(String(a.value))];
    const mentioned = numbersIn(texts.join(' '));
    // M2：可消解要求（a）显式更正标记（b）全部声明数字都在文本出现（不是只中第一个）
    const resolvable = hasCorrectionMarker(texts.join(' ')) && declared.length > 0 && declared.every((n) => mentioned.has(n));
    out.objection = {
      kind: 'value-conflict',
      resolvable,
      reason: `既有记录 ${conflict.recordId} 的值为 ${conflict.assertion?.value}，候选为 ${a.value}`,
      targetRecordId: conflict.recordId ?? null,
    };
    return out;
  }

  return out;
}
