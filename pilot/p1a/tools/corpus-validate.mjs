// corpus-validate.mjs —— pilot 语料校验器
// 规格：docs/design/v2.0/06-annotation-spec.md §1、04-scoring-and-splits.md §2、pilot/p1a/config/eval-manifest.json
// 证据 span 由 quote 在事件文本中唯一定位派生（Unicode 码点 offset，02 文件口径），hash = sha256(event text)。
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export const TYPE_CLOSED_SET = ['fact', 'decision', 'preference', 'gotcha', 'task-state', 'hypothesis'];
export const SPEECH_ACT_SET = ['state', 'suggest', 'agree', 'decide', 'complete', 'retract'];
export const STATUS_SET = ['active', 'retracted', 'conditional', 'suggestion-only', 'not-done'];
export const LANGUAGE_SET = ['zh', 'en', 'mixed'];
export const ROLE_SET = ['user', 'assistant', 'tool', 'unknown'];
export const NON_RECORDABLE_REASONS = ['chitchat', 'pure-echo', 'no-proposition', 'operation-ack'];

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// —— 单句命题检查（复合命题禁止，06 §1）——
export function checkSingleSentence(claim) {
  const s = String(claim).trim();
  if (!s) return false;
  const inner = s.slice(0, -1); // 去掉句尾一个终结符
  if (/[。；；？！?!;]/.test(inner)) return false;
  if (/\.[.!?]|!\?|\?!/.test(inner)) return false;
  // 英文句点后跟空格+大写/数字开头的新句视为复合（缩写 i.e./e.g. 排除）
  const inner2 = s.slice(0, Math.max(0, s.length - 1)).replace(/\b(e\.g|i\.e|etc|vs|approx|fig|no)\./gi, '');
  if (/[a-zA-Z0-9)]\. [A-Z0-9(]/.test(inner2)) return false;
  // 小数点/版本号（digit.digit）不是句末终结符
  const sansDecimal = s.replace(/\d\.\d/g, 'DD');
  return /^[.!?。？！]$/.test(sansDecimal.slice(-1)) || !/[.!?。？！]/.test(sansDecimal);
}

// —— PII 启发式（红线：全合成脱敏，v2.0-p1 §4）——
export function detectPii(text) {
  const hits = [];
  if (/[a-zA-Z0-9._%+-]+@(?!example\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) hits.push('email');
  if (/1[3-9]\d{9}/.test(text)) hits.push('cn-phone');
  if (/\b\d{17}[\dXx]\b/.test(text)) hits.push('cn-id');
  if (/\b\d{16,19}\b/.test(text)) hits.push('card-number');
  return hits;
}

// —— 证据 span 解析：quote 必须在指定事件文本中出现且仅一次 ——
export function resolveEvidenceSpans(scenario) {
  const out = [];
  const events = new Map(scenario.events.map((e) => [e.eventId, e]));
  for (const g of scenario.gold || []) {
    for (const ev of g.evidence || []) {
      const event = events.get(ev.eventId);
      if (!event) continue;
      const text = event.text;
      const first = text.indexOf(ev.quote);
      if (first === -1) continue;
      const last = text.lastIndexOf(ev.quote);
      if (first !== last) continue; // 非唯一定位
      out.push({ goldId: g.goldId, eventId: ev.eventId, span: { start: first, end: first + ev.quote.length }, hash: sha256(text) });
    }
  }
  return out;
}

function assertCond(errs, cond, msg) {
  if (!cond) errs.push(msg);
}

// —— 单场景校验 ——
export function validateScenario(s, { manifest } = {}) {
  const errs = [];
  const severes = manifest?.thresholds?.severeErrorEscape?.classes || [];
  const adversarialClasses = manifest?.thresholds?.adversarialClasses || [];

  assertCond(errs, typeof s.scenarioId === 'string' && /^S\d{3,}$/.test(s.scenarioId), `${s.scenarioId}: scenarioId 必须是 S+3 位以上数字`);
  assertCond(errs, typeof s.family === 'string' && s.family.length > 0, `${s.scenarioId}: family 必填`);
  assertCond(errs, LANGUAGE_SET.includes(s.language), `${s.scenarioId}: language 闭集 ${LANGUAGE_SET.join('/')}`);
  assertCond(errs, s.source && s.source.kind === 'dsh-transcript' && Number.isInteger(s.source.sourceEpoch), `${s.scenarioId}: source.kind=dsh-transcript + sourceEpoch 必填`);
  assertCond(errs, Array.isArray(s.events) && s.events.length >= 2, `${s.scenarioId}: events ≥2`);
  for (const e of s.events || []) {
    assertCond(errs, typeof e.eventId === 'string' && e.eventId.startsWith(`${s.scenarioId}-`), `${s.scenarioId}: eventId 必须以场景 ID 前缀（跨场景唯一）`);
    assertCond(errs, ROLE_SET.includes(e.role), `${s.scenarioId}/${e.eventId}: role 闭集`);
    assertCond(errs, typeof e.text === 'string' && e.text.length > 0, `${s.scenarioId}/${e.eventId}: text 必填`);
    assertCond(errs, typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts)), `${s.scenarioId}/${e.eventId}: ts ISO 时间`);
    for (const p of detectPii(e.text)) errs.push(`${s.scenarioId}/${e.eventId}: PII 检出 ${p}（语料必须合成脱敏）`);
  }

  const eventIds = new Set((s.events || []).map((e) => e.eventId));
  const gold = s.gold || [];
  const isNonRecordable = !!s.shouldReject;
  if (isNonRecordable) {
    assertCond(errs, gold.length === 0, `${s.scenarioId}: 无可记场景与 gold 互斥（06 §1）`);
    assertCond(errs, s.shouldReject && NON_RECORDABLE_REASONS.includes(s.shouldReject.reason), `${s.scenarioId}: shouldReject.reason 闭集 ${NON_RECORDABLE_REASONS.join('/')}`);
    assertCond(errs, !s.adversarial, `${s.scenarioId}: 无可记场景不携带 adversarial`);
  } else {
    assertCond(errs, gold.length >= 1, `${s.scenarioId}: 非无可记场景必须有 ≥1 条 gold 或 shouldReject`);
  }

  const goldIds = new Set();
  for (const g of gold) {
    const tag = `${s.scenarioId}/${g.goldId || '?'}`;
    assertCond(errs, typeof g.goldId === 'string' && !goldIds.has(g.goldId), `${tag}: goldId 必填且场景内唯一`);
    goldIds.add(g.goldId);
    assertCond(errs, typeof g.claim === 'string' && g.claim.length > 0, `${tag}: claim 必填`);
    assertCond(errs, checkSingleSentence(g.claim), `${tag}: 复合命题禁止（一句一条）`);
    assertCond(errs, ROLE_SET.includes(g.role), `${tag}: role 闭集`);
    assertCond(errs, TYPE_CLOSED_SET.includes(g.type), `${tag}: type 闭集 6 类`);
    assertCond(errs, STATUS_SET.includes(g.status), `${tag}: status 闭集`);
    assertCond(errs, g.assertion && SPEECH_ACT_SET.includes(g.assertion.speechAct), `${tag}: assertion.speechAct 闭集`);
    assertCond(errs, g.assertion && typeof g.assertion.negated === 'boolean', `${tag}: assertion.negated 布尔`);
    assertCond(errs, g.assertion && ('about' in g.assertion), `${tag}: assertion.about 必填（可为 null）`);
    assertCond(errs, g.assertion && ('condition' in g.assertion), `${tag}: assertion.condition 必填（可为 null）`);
    assertCond(errs, g.time && typeof g.time.observedAt === 'string' && !Number.isNaN(Date.parse(g.time.observedAt)), `${tag}: time.observedAt ISO`);
    assertCond(errs, g.time && ('assertedValidFrom' in g.time) && ('assertedValidTo' in g.time), `${tag}: time.assertedValidFrom/To 必填（未知 null，禁止猜）`);
    assertCond(errs, Array.isArray(g.evidence) && g.evidence.length >= 1, `${tag}: evidence ≥1（空证据 = failed evidence-unsupported，不得进 gold）`);
    for (const ev of g.evidence || []) {
      const event = (s.events || []).find((x) => x.eventId === ev.eventId);
      assertCond(errs, !!event, `${tag}: evidence 引用不存在的事件 ${ev.eventId}`);
      if (event) {
        const n = event.text.split(ev.quote).length - 1;
        assertCond(errs, n === 1, `${tag}: quote 在 ${ev.eventId} 中出现 ${n} 次（必须恰好 1 次）`);
        for (const p of detectPii(ev.quote)) errs.push(`${tag}: quote PII 检出 ${p}`);
      }
    }
    assertCond(errs, !('expectedOutcome' in g), `${tag}: 正场景 gold 不携带 expectedOutcome（06 §1）`);
  }

  if (s.adversarial) {
    assertCond(errs, adversarialClasses.includes(s.adversarial.class), `${s.scenarioId}: adversarial.class 闭集（10 类）`);
    assertCond(errs, s.adversarial.target && eventIds.has(s.adversarial.target.eventId), `${s.scenarioId}: adversarial.target.eventId 必须在本场景 events 内`);
    if (s.adversarial.target?.quote) {
      const event = (s.events || []).find((x) => x.eventId === s.adversarial.target.eventId);
      const n = event ? event.text.split(s.adversarial.target.quote).length - 1 : 0;
      assertCond(errs, n === 1, `${s.scenarioId}: adversarial.target.quote 必须恰好出现 1 次`);
    }
    assertCond(errs, ['block', 'emit-with-flag'].includes(s.adversarial.expectedOutcome), `${s.scenarioId}: expectedOutcome ∈ block|emit-with-flag`);
    assertCond(errs, severes.includes(s.adversarial.expectedErrorClass), `${s.scenarioId}: expectedErrorClass 必须在七类严重错误闭集内`);
    assertCond(errs, gold.length >= 1, `${s.scenarioId}: 对抗场景仍需 ≥1 条 gold（应被抽取的真命题）；被拦截内容不得进 gold`);
  }
  return errs;
}

// —— 语料级校验（跨场景唯一性等）——
export function validateCorpus(scenarios, { manifest } = {}) {
  const errs = [];
  const seenIds = new Set();
  const seenEvents = new Set();
  for (const s of scenarios) {
    if (seenIds.has(s.scenarioId)) errs.push(`${s.scenarioId}: scenarioId 重复`);
    seenIds.add(s.scenarioId);
    for (const e of s.events || []) {
      if (seenEvents.has(e.eventId)) errs.push(`${s.scenarioId}/${e.eventId}: eventId 跨场景重复`);
      seenEvents.add(e.eventId);
    }
    errs.push(...validateScenario(s, { manifest }));
  }
  return errs;
}

// —— 配额检查（数值全部读 eval-manifest.json，不硬编码）——
export function checkQuotas(scenarios, manifest) {
  const fails = [];
  const t = manifest.thresholds;
  const stage = manifest.stage;
  const val = (o) => (stage === 'pilot' && 'pilot' in o ? o.pilot : o.exitLevel);
  const scopeVal = (o) => (stage === 'pilot' ? (o.pilotScope || 'full') : (o.exitScope || 'test'));

  const total = scenarios.length;
  if (total < val(t.corpus.minScenariosTotal)) fails.push(`场景总数 ${total} < ${val(t.corpus.minScenariosTotal)}（${stage}）`);
  const goldCount = scenarios.reduce((n, s) => n + (s.gold || []).length, 0);
  if (goldCount < val(t.corpus.minGoldClaims)) fails.push(`gold claims ${goldCount} < ${val(t.corpus.minGoldClaims)}（${stage}）`);
  const nonRec = scenarios.filter((s) => s.shouldReject).length;
  if (nonRec < val(t.corpus.minNonRecordable)) fails.push(`无可记场景 ${nonRec} < ${val(t.corpus.minNonRecordable)}（${stage}）`);

  // 语言配额（pilot 作用于全集 scope）
  for (const [key, lang] of [['minTestZh', 'zh'], ['minTestEn', 'en']]) {
    const q = t.corpus[key];
    const inScope = scopeVal(q) === 'full' ? total : scenarios.filter((s) => s.split === 'test').length;
    const n = scenarios.filter((s) => s.language === lang).length;
    if (stage === 'pilot' && n < q.pilot) fails.push(`${lang} 场景 ${n} < ${q.pilot}（pilot scope=${scopeVal(q)}）`);
    else if (stage !== 'pilot' && scopeVal(q) === 'test' && scenarios.filter((s) => s.split === 'test' && s.language === lang).length < q.exitLevel) fails.push(`test ${lang} 场景 < ${q.exitLevel}`);
    void inScope;
  }
  const mixed = t.corpus.minMixedLanguage;
  if (stage === 'pilot' && mixed.pilot) {
    const n = scenarios.filter((s) => s.language === 'mixed').length;
    if (n < mixed.pilot) fails.push(`mixed 场景 ${n} < ${mixed.pilot}`);
  }

  // 对抗配额（pilot 作用于全集；exit 作用于 test 集）
  const adv = t.corpus.minAdversarialPerClass;
  const advPool = stage === 'pilot' || scopeVal(adv) === 'full' ? scenarios : scenarios.filter((s) => s.split === 'test');
  const need = stage === 'pilot' ? adv.pilot : adv.exitLevel;
  const counts = {};
  for (const s of advPool) if (s.adversarial) counts[s.adversarial.class] = (counts[s.adversarial.class] || 0) + 1;
  for (const cls of t.adversarialClasses) {
    if ((counts[cls] || 0) < need) fails.push(`对抗 ${cls} ${(counts[cls] || 0)} < ${need}（${stage} scope=${scopeVal(adv)}）`);
  }

  // 家族聚类（bootstrap unit=scenario-family，04 §2）：家族数 ≥3、每家族 ≥2
  const fams = {};
  for (const s of scenarios) fams[s.family] = (fams[s.family] || 0) + 1;
  if (Object.keys(fams).length < 3) fails.push(`家族数 ${Object.keys(fams).length} < 3`);
  for (const [f, n] of Object.entries(fams)) if (n < 2) fails.push(`家族 ${f} 仅 ${n} 场景（<2，家族聚类不可用）`);
  return fails;
}

// —— pack 配额预估（token 计数归 ADR-101，此处仅字符级估算）——
export function computePackQuota(scenarios) {
  let totalChars = 0;
  for (const s of scenarios) {
    totalChars += (s.events || []).reduce((n, e) => n + e.text.length, 0);
    totalChars += (s.gold || []).reduce((n, g) => n + g.claim.length, 0);
  }
  return { totalChars, estimatedTokens: Math.round(totalChars * 0.6) }; // 粗估：ADR-101 接受前禁止当精确值
}

// —— CLI：node corpus-validate.mjs <corpusDir> <manifestPath> ——
export async function loadCorpus(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const scenarios = [];
  for (const f of files) {
    const text = await readFile(`${dir}/${f}`, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      const t = line.trim();
      if (!t || t.startsWith('//')) continue;
      try {
        scenarios.push(JSON.parse(t));
      } catch (e) {
        throw new Error(`${f}:${i + 1} JSON 解析失败: ${e.message}`);
      }
    }
  }
  return scenarios;
}

export async function main() {
  const [dir, manifestPath] = process.argv.slice(2);
  if (!dir || !manifestPath) {
    console.error('用法: node corpus-validate.mjs <corpusDir> <eval-manifest.json>');
    process.exit(2);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const scenarios = await loadCorpus(dir);
  const errs = validateCorpus(scenarios, { manifest });
  const quotaFails = errs.length === 0 ? checkQuotas(scenarios, manifest) : [];
  const quota = computePackQuota(scenarios);
  const byLang = {};
  const byClass = {};
  for (const s of scenarios) {
    byLang[s.language] = (byLang[s.language] || 0) + 1;
    if (s.adversarial) byClass[s.adversarial.class] = (byClass[s.adversarial.class] || 0) + 1;
  }
  console.log(JSON.stringify({ scenarios: scenarios.length, gold: scenarios.reduce((n, s) => n + (s.gold || []).length, 0), byLang, byClass, quota, errors: errs, quotaFails }, null, 2));
  if (errs.length || quotaFails.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
