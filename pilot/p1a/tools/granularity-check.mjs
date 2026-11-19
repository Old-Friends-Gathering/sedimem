// granularity-check.mjs —— 命题粒度规则 granularity@v1 的可执行校验
// 规格：docs/design/v2.0/06-annotation-spec.md §1.1
// 边界：只做规则判定与校准集校验；不评分、不改参考集、不写真相层。
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const RULESET_VERSION = 'granularity@v1';

// 归一化：全半角统一 → 去首尾空白与句末标点 → 折叠空白 → 小写（ASCII）
export function normalizeText(input) {
  let s = String(input ?? '').normalize('NFKC').trim();
  s = s.replace(/[。！？!?.]+$/u, '');
  s = s.replace(/\s+/gu, ' ');
  return s.toLowerCase();
}

// 数字与单位标准化：30 秒 / 30s / 30 s → 30s
const UNIT_MAP = [
  [/秒|sec(ond)?s?/gi, 's'],
  [/毫秒|ms/gi, 'ms'],
  [/分钟|min(ute)?s?/gi, 'min'],
  [/小时|hour?s?/gi, 'h'],
];
export function normalizeValue(value) {
  let v = normalizeText(value).replace(/\s+/gu, '');
  for (const [re, unit] of UNIT_MAP) v = v.replace(re, unit);
  return v;
}

// 同义动词归一（I1 判定前的必要一步）
const VERB_SYNONYMS = [
  [/改成|改为|变更|切换到|switch to|change to/giu, 'change'],
];
export function normalizePredicate(predicate) {
  let p = normalizeText(predicate);
  for (const [re, canon] of VERB_SYNONYMS) p = p.replace(re, canon);
  return p;
}

// —— A3 可记性 ——
const PROCESS_NARRATION_RE = /^(我先|那我先|我来|让我|我这就|稍等|我看一下|我去确认|i'?ll |let me )/iu;
const CHITCHAT_RE = /^(谢谢|多谢|好的|收到|明白了|辛苦了|thanks|thank you|ok|okay|got it)[!！。.\s]*$/iu;
// 稳定信息：取值样态（数字/凭证式标识）或 属性-状态断言（是/为/有/支持/返回…）或状态词表
const VALUE_TOKEN_LIST = [
  'http', 'https', 'tcp', 'udp', 'grpc', 'true', 'false', 'on', 'off',
  'degraded', 'healthy', 'enabled', 'disabled', 'drained', 'active', 'pending',
  '成功', '失败', '开放', '关闭', '启用', '停用', '就绪', '不可用',
];
const STABLE_INFO_RE = new RegExp(
  `(\\d|=|是|为|有|支持|部署|端口|超时|版本|结论|返回|报|状态|结果|必须|应该|要求|规范|流程|策略|不得|压测|发布|${VALUE_TOKEN_LIST.join('|')})`,
  'iu',
);
const PREDICATE_MARK_RE = /(是|为|有|在|=|改成|改为|部署|返回|支持|开放|失败|重试|保留|升级|回滚|停止|恢复|提升|降低|已|都|\b(is|are|was|were|supports?|returns?|deploys?|finished|completed|failed|started)\b)/iu;

export function isAclaim(text) {
  const s = normalizeText(text);
  if (!s) return false;
  if (CHITCHAT_RE.test(s)) return false;
  if (PROCESS_NARRATION_RE.test(s)) return false;
  return STABLE_INFO_RE.test(s);
}

// —— 形态标记（S4/S5/S6）：只标注形态，不豁免复合检查（审核 F2）——
const S4_RE = /(如果|假如|假设|若|\bif\b|\bwhen\b)/iu;
const S5_RE = /(他说|她说|文档(里)?(写|说)|据说|根据文档|according to|\bsaid\b|\bdocs? say)/iu;
const S6_RE = /(比.{0,12}(快|慢|好|差)|\bfaster\b|\bslower\b|\bbetter than)/iu;
const IDENTITY_RE = /(同一个|相同|一致|一样|同一 |same |identical)/iu;

const CONJ_RE = /(并且|而且|同时|以及|和|与|also|and)/iu;
const CLAUSE_SPLIT_RE = /[，,；;]/u;
const LIST_SPLIT_RE = /[、]/u;

function hasValueToken(seg) {
  const s = seg.trim();
  if (!s) return false;
  if (/\d/u.test(s)) return true;
  const low = s.toLowerCase();
  return VALUE_TOKEN_LIST.some((t) => low.includes(t));
}

// 拆分提示：返回命中的规则编号（S1/S1b/S2/S3/S6b 判需拆；S4/S5/S6 只标形态）
export function splitHints(text) {
  const s = normalizeText(text);
  const hits = [];
  if (!s) return hits;

  // 形态标记（不 return：主句内部仍可能是复合）
  if (S4_RE.test(s)) hits.push('S4');
  if (S5_RE.test(s)) hits.push('S5');
  if (S6_RE.test(s)) hits.push('S6');

  const clauses = s.split(CLAUSE_SPLIT_RE).filter((c) => c.trim());
  const predicateClauses = clauses.filter((c) => PREDICATE_MARK_RE.test(c));

  // 规则互斥优先级（审核 F2/F3）：先判 S2（多主谓分句），命中后不再重复记 S1/S1b
  const s2Hit = clauses.length >= 2 && predicateClauses.length >= 2;
  if (s2Hit) hits.push('S2');

  // S1：并列连词连接两个含谓词的分句（单分句时才是本规则，避免与 S2 重复记账）
  let s1Hit = false;
  if (!s2Hit && CONJ_RE.test(s)) {
    const parts = s.split(CONJ_RE).filter((p) => p.trim());
    if (parts.length >= 3 && parts.filter((p) => PREDICATE_MARK_RE.test(p)).length >= 2) {
      hits.push('S1');
      s1Hit = true;
    }
  }

  // S1b：并列连词连接两个取值样态成分、共享同一谓语（"8080 和 8081 都已开放"）
  // 同位/同一性判断句式（"A 和 B 是同一个服务"）不算并列事实
  if (!s2Hit && !s1Hit && CONJ_RE.test(s) && !IDENTITY_RE.test(s)) {
    const parts = s.split(CONJ_RE).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      const valueParts = parts.filter((p) => hasValueToken(p) || VALUE_TOKEN_LIST.some((t) => p.includes(t)));
      if (valueParts.length >= 2 && PREDICATE_MARK_RE.test(s)) hits.push('S1b');
    }
  }

  // S3：顿号列举 ≥2 个取值项（不限数值：支持 http、https 也算）
  if (LIST_SPLIT_RE.test(s)) {
    const items = s.split(LIST_SPLIT_RE).map((i) => i.trim()).filter(Boolean);
    if (items.length >= 2) {
      const valueItems = items.filter((i) => hasValueToken(i) || VALUE_TOKEN_LIST.some((t) => i.includes(t)));
      // 首项常带主语前缀（"支持 http"），只要 ≥2 项可判真假即拆
      if (valueItems.length >= 2 || (valueItems.length >= 1 && items.length >= 2 && PREDICATE_MARK_RE.test(s))) {
        hits.push('S3');
      }
    }
  }

  // S6b：多个比较结构（"A 比 B 快 3 倍，也比 C 快"）——每个比较是一条
  if (hits.includes('S6') && (s.match(/比/gu) ?? []).length >= 2) hits.push('S6b');

  return hits;
}

// U1–U3：整体即一条（不因内部连字符/数值单位/否定误判为复合）
export function isUnsplittable(text) {
  const s = normalizeText(text);
  return (
    /[a-z0-9]+-[a-z0-9-]+/iu.test(s) ||
    /\d+\s*(s|ms|min|h)\b/iu.test(s) ||
    /(不支持|no longer supports?|unsupported)/iu.test(s)
  );
}

// A1/A2：命中 S1/S1b/S2/S3/S6b ⇒ 非原子；S4/S5/S6 形态本身不豁免
export function isAtomic(text) {
  const s = normalizeText(text);
  if (!s) return false;
  if (/[。；;]/u.test(s)) return false;
  const hits = new Set(splitHints(s));
  for (const mustSplit of ['S1', 'S1b', 'S2', 'S3', 'S6b']) if (hits.has(mustSplit)) return false;
  return true;
}

// 期望拆分数：按命中规则与文本形态实算（审核 F9：不再硬编码 2）
export function countSplitParts(text) {
  const s = normalizeText(text);
  const hits = splitHints(s);
  if (!hits.some((h) => ['S1', 'S1b', 'S2', 'S3', 'S6b'].includes(h))) return isAclaim(s) ? 1 : 0;
  if (hits.includes('S6b')) return (s.match(/比/gu) ?? []).length;
  if (hits.includes('S3')) {
    const items = s.split(LIST_SPLIT_RE).map((i) => i.trim()).filter(Boolean);
    return Math.max(2, items.length);
  }
  const clauses = s.split(CLAUSE_SPLIT_RE).map((c) => c.trim()).filter((c) => PREDICATE_MARK_RE.test(c));
  if (clauses.length >= 2) return clauses.length;
  return 2;
}

// 判定键：缺失字段用 null（≠ 显式空串），审核 F5
export function judgementKey(claim = {}) {
  const a = claim.assertion ?? {};
  const pick = (v) => (v === undefined || v === null ? null : normalizeText(v));
  return {
    scope: pick(claim.scope),
    subject: pick(a.subject ?? a.about),
    predicate: a.predicate === undefined || a.predicate === null ? null : normalizePredicate(a.predicate),
    value: a.value === undefined || a.value === null ? null : normalizeValue(a.value),
  };
}

// I1/I2/I3：同一条 / 不同条 / 子集（不同粒度）
export function sameClaim(a, b) {
  const ka = judgementKey(a);
  const kb = judgementKey(b);
  const keys = ['scope', 'subject', 'predicate', 'value'];
  const speechA = normalizeText(a.assertion?.speechAct ?? '');
  const speechB = normalizeText(b.assertion?.speechAct ?? '');
  const negA = a.assertion?.negated === true;
  const negB = b.assertion?.negated === true;

  const allEqual = keys.every((k) => ka[k] === kb[k]);
  if (allEqual) {
    if (speechA === speechB && negA === negB) return 'same'; // I1
    return 'different'; // I2
  }

  // I3：一侧字段缺失（null）且另一侧有值 ⇒ 不同粒度；显式空串（''）不是缺失，按不同条（I2）
  const subsetA = keys.every((k) => ka[k] === null || ka[k] === kb[k]);
  const subsetB = keys.every((k) => kb[k] === null || kb[k] === ka[k]);
  const nullsA = keys.filter((k) => ka[k] === null).length;
  const nullsB = keys.filter((k) => kb[k] === null).length;
  if ((subsetA || subsetB) && nullsA !== nullsB) return 'subsumed';
  return 'different'; // I2：含显式空值差异等
}

// 单条诊断
export function checkClaimGranularity(claim, { maxChars = 100 } = {}) {
  const problems = [];
  const text = claim?.claim ?? '';
  if (!text) problems.push('empty-claim');
  if ([...String(text)].length > maxChars) problems.push('claim-too-long');
  if (!isAclaim(text)) problems.push('not-a-claim-a3');
  const hits = splitHints(text);
  const mustSplit = hits.filter((h) => ['S1', 'S1b', 'S2', 'S3', 'S6b'].includes(h));
  if (mustSplit.length || /[。；;]/u.test(normalizeText(text))) {
    problems.push(`must-split:${mustSplit.join('+') || 'multi-sentence'}`);
  }
  return problems;
}

// 样本指纹：防止校准样本被静默替换（审核 F9）
export function sampleFingerprint(text) {
  return createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 8);
}

// 校准集校验：每行 {calibrationId, language, text, expectedClaims, hits, verdict, textHash?}
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
      problems.push(
        `${tag}: 规则命中不符（期望 ${expectedHits.join('+') || '无'}，实际 ${actualHits.join('+') || '无'}）`,
      );
    }
    if (typeof r.expectedClaims === 'number') {
      const actualCount = countSplitParts(r.text);
      if (actualCount !== r.expectedClaims) {
        problems.push(`${tag}: 拆分数不符（期望 ${r.expectedClaims}，实际 ${actualCount}）`);
      }
    }
    if (r.textHash && sampleFingerprint(r.text) !== r.textHash) {
      problems.push(`${tag}: 样本指纹不符（text 被替换但未升版本）`);
    }
    if (r.verdict === 'must-split' && atom) problems.push(`${tag}: 期望 must-split，被判原子`);
    if (r.verdict === 'valid-atomic' && !atom) problems.push(`${tag}: 期望 valid-atomic，被判需拆`);
    if (r.verdict === 'not-a-claim' && ac) problems.push(`${tag}: 期望 not-a-claim，被判可记`);
    if (r.verdict === 'valid-atomic' && !ac) problems.push(`${tag}: 期望可记，被判不可记`);
  }
  return problems;
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
