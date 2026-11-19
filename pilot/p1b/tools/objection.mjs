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

const ZH_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/**
 * 中文数字串转阿拉伯数字（支持 三十 / 一百二十 / 八千零八十；不支持小数与「亿」级）。
 * @param {string} zh 中文数字串
 * @returns {number|null} 无法解析返回 null
 */
export function zhToNumber(zh) {
  const s = String(zh ?? '');
  if (!s) return null;
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in ZH_DIGITS) {
      digit = ZH_DIGITS[ch];
      seen = true;
      continue;
    }
    const unit = ZH_UNITS[ch];
    if (unit === undefined) return null;
    seen = true;
    if (unit === 10000) {
      section = (section + digit) * unit;
      total += section;
      section = 0;
      digit = 0;
    } else {
      section += (digit || 1) * unit;
      digit = 0;
    }
  }
  return seen ? total + section + digit : null;
}

// m2：数字归一再比较（v2.0 → 2，30.0 → 30），避免同值不同写法误报
function normalizeNumber(raw) {
  const t = String(raw).replace(/^[vV]/u, '');
  if (/^\d+(?:\.\d+)?$/u.test(t)) return String(Number(t));
  return t;
}

const ZH_NUMBER_RE = /[零〇一二两三四五六七八九十百千万]{1,12}/gu;

export function numbersIn(text) {
  const raw = String(text ?? '');
  const out = new Set();
  for (const m of raw.match(DIGITS_RE) ?? []) out.add(normalizeNumber(m));
  for (const m of raw.match(/[vV]\d+(?:\.\d+)?/gu) ?? []) out.add(normalizeNumber(m));
  // N1：中文数字同样计入（「八千零八十」等价 8080），否则中文引文会误判值缺失
  for (const m of raw.match(ZH_NUMBER_RE) ?? []) {
    const n = zhToNumber(m);
    if (n != null) out.add(String(n));
  }
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
      // N7：与 value-conflict 统一——有更正标记且全部声明数字在文本中出现（不再要求「全部缺失」）
      const mentioned = numbersIn(texts.join(' '));
      const resolvable = hasCorrectionMarker(texts.join(' ')) && declared.size > 0 && [...declared].every((n) => mentioned.has(n));
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
