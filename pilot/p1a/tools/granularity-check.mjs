// granularity-check.mjs —— 命题粒度规则 granularity@v1 的可执行校验
// 规格：docs/design/v2.0/06-annotation-spec.md §1.1
// 边界：只做规则判定与校准集校验；不评分、不改参考集、不写真相层。
import { readFileSync } from 'node:fs';

export const RULESET_VERSION = 'granularity@v1';

// 归一化：全半角统一 → 去首尾空白与句末标点 → 折叠空白 → 小写（ASCII）
export function normalizeText(input) {
  let s = String(input ?? '').normalize('NFKC').trim();
  s = s.replace(/[。！？!?.]+$/u, '');
  s = s.replace(/\s+/gu, ' ');
  return s.toLowerCase();
}

// 数字与单位标准化：30 秒 / 30s / 30 s → 30s；3 倍 → 3倍
const UNIT_MAP = [
  [/秒|sec(ond)?s?/gi, 's'],
  [/毫秒|ms/gi, 'ms'],
  [/分钟|min(ute)?s?/gi, 'min'],
  [/小时|hour?s?/gi, 'h'],
  [/倍/gu, '倍'],
];
export function normalizeValue(value) {
  let v = normalizeText(value).replace(/\s+/gu, '');
  for (const [re, unit] of UNIT_MAP) v = v.replace(re, unit);
  return v;
}

// 同义动词归一（I1 判定前的必要一步）
const VERB_SYNONYMS = [
  [/改成|改为|变更|切换到|switch to|change to/giu, 'change'],
  [/不支持|不支持了|no longer supports?/giu, 'unsupported'],
];
export function normalizePredicate(predicate) {
  let p = normalizeText(predicate);
  for (const [re, canon] of VERB_SYNONYMS) p = p.replace(re, canon);
  return p;
}

const PROCESS_NARRATION_RE = /^(我先|那我先|我来|让我|我这就|稍等|我看一下|我去确认|i'?ll |let me )/iu;
const CHITCHAT_RE = /^(谢谢|多谢|好的|收到|明白了|辛苦了|thanks|thank you|ok|okay|got it)[!！。.\s]*$/iu;
const STABLE_INFO_RE = /(\d|=|是|为|有|支持|部署|端口|超时|版本|结论|返回|degraded|healthy)/iu;

// A3：承载可复用稳定信息，不是过程叙述/寒暄
export function isAclaim(text) {
  const s = normalizeText(text);
  if (!s) return false;
  if (CHITCHAT_RE.test(s)) return false;
  if (PROCESS_NARRATION_RE.test(s)) return false;
  return STABLE_INFO_RE.test(s);
}

const S1_RE = /(并且|而且|同时|以及|和|与|also|and)\s*[^，,。;；]{0,20}(是|为|有|=|改成|改为|切换到|is|are|was|were|deploys?)/iu;
const S2_CLAUSE_RE = /[，,；;]/u;
const PREDICATE_MARK_RE = /(是|为|有|在|=|改成|改为|部署|返回|支持|is|are|was|were|deploys?|returns?|supports?)/iu;
const S3_LIST_RE = /[、]/u;
const S4_RE = /(如果|假如|假设|若|\bif\b|\bwhen\b)/iu;
const S5_RE = /(他说|她说|文档(里)?(写|说)|据说|根据文档|according to|\bsaid\b|\bdocs? say)/iu;
const S6_RE = /(比.{0,12}(快|慢|好|差)|\bfaster\b|\bslower\b|\bbetter\b than)/iu;

// 拆分提示：返回命中的规则编号（S1–S6）；S4–S6 属"整体一条"的形态，不产生拆分
export function splitHints(text) {
  const s = normalizeText(text);
  const hits = [];
  if (!s) return hits;

  // S4/S5/S6 先判：它们把句子定性为「整体一条」的特殊形态
  if (S4_RE.test(s)) hits.push('S4');
  if (S5_RE.test(s)) hits.push('S5');
  if (S6_RE.test(s)) hits.push('S6');
  if (hits.length) return hits;

  const clauses = s.split(/[，,；;]/u).filter((c) => c.trim());
  const predicateClauses = clauses.filter((c) => PREDICATE_MARK_RE.test(c));
  if (S1_RE.test(s) && predicateClauses.length >= 2) hits.push('S1');
  else if (clauses.length >= 2 && predicateClauses.length >= 2) hits.push('S2');
  if (S3_LIST_RE.test(s) && /(\d|s\b|倍)/iu.test(s)) hits.push('S3');
  return hits;
}

// U1–U3：整体即一条（不因内部标点/连字符误判为复合）
export function isUnsplittable(text) {
  const s = normalizeText(text);
  return /[a-z0-9]+-[a-z0-9-]+/iu.test(s) || /\d+\s*(s|ms|min|h|倍)\b/iu.test(s) || /(不支持|no longer supports?|unsupported)/iu.test(s);
}

// A1/A2：单句且不命中 S1–S3 拆分规则 ⇒ 原子
export function isAtomic(text) {
  const s = normalizeText(text);
  if (!s) return false;
  const terminalInside = /[。；;]/u.test(s);
  if (terminalInside) return false;
  const hintSet = new Set(splitHints(s));
  if (hintSet.has('S1') || hintSet.has('S2') || hintSet.has('S3')) return false;
  return true;
}

// 判定键：scope+subject+predicate+value（缺字段时按可得字段）
export function judgementKey(claim = {}) {
  const a = claim.assertion ?? {};
  return [
    normalizeText(claim.scope ?? ''),
    normalizeText(a.subject ?? a.about ?? ''),
    normalizePredicate(a.predicate ?? ''),
    normalizeValue(a.value ?? ''),
  ];
}

// I1/I2/I3：同一条 / 不同条 / 子集（不同粒度）
export function sameClaim(a, b) {
  const ka = judgementKey(a);
  const kb = judgementKey(b);
  const keyEqual = ka.length === kb.length && ka.every((v, i) => v === kb[i]);
  const speechA = normalizeText(a.assertion?.speechAct ?? '');
  const speechB = normalizeText(b.assertion?.speechAct ?? '');
  const negA = a.assertion?.negated === true;
  const negB = b.assertion?.negated === true;

  if (keyEqual) {
    if (speechA === speechB && negA === negB) return 'same'; // I1
    return 'different'; // I2
  }
  // I3：任一侧判定键存在空位，且非空位一侧是空位一侧的超集 → 不同粒度
  const nonEmptyA = ka.filter(Boolean).length;
  const nonEmptyB = kb.filter(Boolean).length;
  const subset = ka.every((v, i) => !v || v === kb[i]) || kb.every((v, i) => !v || v === ka[i]);
  if (subset && nonEmptyA !== nonEmptyB) return 'subsumed';
  return 'different';
}

// 逐条诊断（给校验器/标注复核用）
export function checkClaimGranularity(claim, { maxChars = 100 } = {}) {
  const problems = [];
  const text = claim?.claim ?? '';
  if (!text) problems.push('empty-claim');
  if ([...String(text)].length > maxChars) problems.push('claim-too-long');
  if (!isAclaim(text)) problems.push('not-a-claim-a3');
  if (!isAtomic(text)) problems.push(`must-split:${splitHints(text).filter((h) => ['S1', 'S2', 'S3'].includes(h)).join('+') || 'multi-sentence'}`);
  return problems;
}

// 校准集校验：每行 {calibrationId, language, text, expectedClaims, hits, verdict}
export function evaluateCalibration(records) {
  const problems = [];
  for (const [i, r] of records.entries()) {
    const tag = r.calibrationId ?? `#${i}`;
    const hints = splitHints(r.text);
    const atom = isAtomic(r.text);
    const ac = isAclaim(r.text);

    const expectedHits = [...new Set(r.hits ?? [])].sort();
    const actualHits = [...new Set(hints)].sort();
    if (expectedHits.join(',') !== actualHits.join(',')) {
      problems.push(`${tag}: 规则命中不符（期望 ${expectedHits.join('+') || '无'}，实际 ${actualHits.join('+') || '无'}）`);
    }
    if (typeof r.expectedClaims === 'number') {
      const actualCount = atom && ac ? 1 : countExpected(hints, ac);
      if (actualCount !== r.expectedClaims) {
        problems.push(`${tag}: 拆分数不符（期望 ${r.expectedClaims}，实际 ${actualCount}）`);
      }
    }
    if (r.verdict === 'must-split' && atom) problems.push(`${tag}: 期望 must-split，被判原子`);
    if (r.verdict === 'valid-atomic' && !atom) problems.push(`${tag}: 期望 valid-atomic，被判需拆`);
    if (r.verdict === 'not-a-claim' && ac) problems.push(`${tag}: 期望 not-a-claim，被判可记`);
    if (r.verdict === 'valid-atomic' && !ac) problems.push(`${tag}: 期望可记，被判不可记`);
  }
  return problems;
}

// 期望条数：命中 S1/S2/S3 视为需拆（按分句/列举估算），S4–S6 与不可拆形态视为 1
function countExpected(hints, isClaim) {
  if (!isClaim) return 0;
  if (hints.some((h) => ['S1', 'S2', 'S3'].includes(h))) return 2;
  return 1;
}

function loadJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node granularity-check.mjs <calibration.jsonl>');
    process.exit(2);
  }
  const records = loadJsonl(file);
  const problems = evaluateCalibration(records);
  if (problems.length) {
    for (const p of problems) console.error(`❌ ${p}`);
    console.error(`\n校准集校验失败：${problems.length} 项（规则集 ${RULESET_VERSION}）`);
    process.exit(1);
  }
  console.log(`✅ 粒度校准集 ${records.length} 条全部通过（规则集 ${RULESET_VERSION}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
