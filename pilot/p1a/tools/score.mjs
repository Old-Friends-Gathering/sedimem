// B2 评分器：实现 docs/design/v2.0/04-scoring-and-splits.md 的 pilot 子集。
// 硬规则：一对一计分（TP/FP/FN）；子命题=FP+FN；零输出（记录型场景）单列；
// 七类严重错误计数；mixed 计入 zh+en 两组；stage!=='exit' 时 verdict=null（fail-closed，04 §5）。
// 04 §3 主口径：置信区间按「场景家族」聚类 bootstrap（percentile），Wilson 仅作描述性。
import { normalizeClaim } from './baseline-runner.mjs';
export { normalizeClaim };

const SEVERE_KEYS = ['negation-flip', 'speaker-misattribution', 'suggestion-promoted', 'retract-treated-current', 'not-done-became-done', 'cross-scope-leak', 'unsupported-fact'];

function wilson(k, n, z = 1.96) {
  if (n === 0) return null;
  const p = k / n;
  const denom = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return { lo: Math.max(0, (center - spread) / denom), hi: Math.min(1, (center + spread) / denom) };
}

// 04 §3 主口径：家族聚类 bootstrap（重采样家族、保留簇内全部场景），确定性 PRNG 可复现。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 家族聚类 bootstrap 置信区间（04 §3 主口径）。
 * @param {Array<{scenarioId:string, family:string, tp:number, fp:number, fn:number}>} scenarioStats
 * @param {{resamples?:number, seed?:number, alpha?:number}} opts
 */
export function bootstrapCI(scenarioStats, { resamples = 2000, seed = 20261118, alpha = 0.05 } = {}) {
  const clusters = new Map();
  for (const s of scenarioStats) {
    const arr = clusters.get(s.family) ?? [];
    arr.push({ tp: s.tp ?? 0, fp: s.fp ?? 0, fn: s.fn ?? 0 });
    clusters.set(s.family, arr);
  }
  const fams = [...clusters.keys()].sort();
  const rand = mulberry32(seed);
  const precisions = [];
  const recalls = [];
  if (fams.length > 0) {
    for (let r = 0; r < resamples; r += 1) {
      let tp = 0, fp = 0, fn = 0;
      for (let k = 0; k < fams.length; k += 1) {
        const pick = fams[Math.floor(rand() * fams.length)];
        for (const row of clusters.get(pick)) { tp += row.tp; fp += row.fp; fn += row.fn; }
      }
      if (tp + fp > 0) precisions.push(tp / (tp + fp));
      if (tp + fn > 0) recalls.push(tp / (tp + fn));
    }
  }
  const pSorted = [...precisions].sort((a, b) => a - b);
  const rSorted = [...recalls].sort((a, b) => a - b);
  const pNullRate = resamples > 0 ? 1 - precisions.length / resamples : null;
  return {
    method: 'family-cluster percentile',
    resamples,
    seed,
    alpha,
    clusters: fams.length,
    precision: pSorted.length === 0 ? null
      : { lo: quantile(pSorted, alpha / 2), hi: quantile(pSorted, 1 - alpha / 2), nullRate: pNullRate },
    precisionNullRate: pNullRate,
    recall: rSorted.length === 0 ? null
      : { lo: quantile(rSorted, alpha / 2), hi: quantile(rSorted, 1 - alpha / 2), nullRate: resamples > 0 ? 1 - recalls.length / resamples : null },
  };
}

function pr(tp, fp, fn) {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null; // 零输出 precision=未定义（04 §3）
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return { tp, fp, fn, precision, recall, precisionWilson: wilson(tp, tp + fp), recallWilson: wilson(tp, tp + fn) };
}

function evidenceSevere(candidate, scenario) {
  // R2-m#5：校验全部 evidence（不止 evidence[0]）；任一条不可定位 → unsupported-fact
  const evs = candidate.evidence ?? [];
  if (evs.length === 0) return true;
  const events = new Map(scenario.events.map((e) => [e.eventId, e]));
  for (const ev of evs) {
    const event = events.get(ev.eventId);
    if (!event) return true;
    const text = String(event.text);
    const first = text.indexOf(ev.quote);
    if (first === -1 || first !== text.lastIndexOf(ev.quote)) return true;
  }
  return false;
}

// R2-M#2：与 04 §4 表逐字对齐——suggest 被记成 agree/decide 才是「变批准」；
// state 是普通陈述降级（不算）、complete 属 not-done-became-done 口径。
function goldSevereKeys(c, g) {
  const keys = [];
  if (Boolean(c.assertion?.negated) !== Boolean(g.assertion?.negated)) keys.push('negation-flip');
  if (c.role !== g.role) keys.push('speaker-misattribution');
  if (g.assertion?.speechAct === 'suggest' && ['agree', 'decide'].includes(c.assertion?.speechAct)) keys.push('suggestion-promoted');
  if (g.status === 'retracted' && c.type === 'fact') keys.push('retract-treated-current');
  if (g.status === 'not-done' && c.type === 'task-state' && !c.assertion?.negated) keys.push('not-done-became-done');
  // R2-M#3：scopeUnresolved=true 是占位 scope（基线红线 scope 恒 pilot:synthetic），
  // 不能据此判泄漏；泄漏判定只对已解析 scope 生效。
  if (!c.scopeUnresolved && c.scope !== g.scope) keys.push('cross-scope-leak');
  return keys;
}

export function scoreRun({ candidates, scenarios, manifest }) {
  const stage = manifest?.stage ?? 'pilot';
  const severe = Object.fromEntries(SEVERE_KEYS.map((k) => [k, 0]));
  const byEvent = new Map();
  for (const s of scenarios) for (const e of s.events) byEvent.set(e.eventId, s);
  const candByScenario = new Map();
  for (const c of candidates) {
    const s = byEvent.get(c.evidence?.[0]?.eventId);
    if (!s) continue;
    if (!candByScenario.has(s.scenarioId)) candByScenario.set(s.scenarioId, []);
    candByScenario.get(s.scenarioId).push(c);
  }
  const famAgg = new Map();
  const scenarioStats = [];
  const zeroOutput = [];
  const adv = { blockViolations: 0, emitFlagViolations: 0 };
  const totals = { tp: 0, fp: 0, fn: 0 };
  const groups = { zh: { tp: 0, fp: 0, fn: 0 }, en: { tp: 0, fp: 0, fn: 0 } };
  for (const s of scenarios) {
    const cands = candByScenario.get(s.scenarioId) ?? [];
    const gold = s.gold ?? [];
    const used = new Set();
    const matchedGold = new Set();
    let tp = 0;
    for (let gi = 0; gi < gold.length; gi++) {
      const g = gold[gi];
      const gNorm = normalizeClaim(g.claim);
      let matched = -1;
      let subMatched = -1;
      for (let i = 0; i < cands.length; i++) {
        if (used.has(i)) continue;
        const cNorm = normalizeClaim(cands[i].claim);
        if (cNorm === gNorm) { matched = i; break; }
        if (subMatched === -1 && cNorm && gNorm.includes(cNorm)) subMatched = i;
      }
      if (matched !== -1) {
        totals.tp++; tp++;
        used.add(matched);
        matchedGold.add(gi);
        const c = cands[matched];
        if (evidenceSevere(c, s)) severe['unsupported-fact']++;
        for (const k of goldSevereKeys(c, g)) severe[k]++;
      } else if (subMatched !== -1) {
        // 候选为 gold 子命题（信息缺失）→ 候选 FP + gold FN（04 §2）
        used.add(subMatched);
        matchedGold.add(gi);
        totals.fp++;
        totals.fn++;
      } else {
        totals.fn++;
      }
    }
    // R2-m#4：severe 逃逸不限 TP——FP 候选（错误进入最终候选）同样按 04 §4 计。
    // FP 候选对「本场景未匹配的 gold」做错类检查，每候选每类只计一次（保守口径，不做模糊配对）。
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i)) { continue; }
      totals.fp++;
      const c = cands[i];
      if (evidenceSevere(c, s)) severe['unsupported-fact']++;
      const hit = new Set();
      for (let gi = 0; gi < gold.length; gi++) {
        if (matchedGold.has(gi)) continue;
        for (const k of goldSevereKeys(c, gold[gi])) hit.add(k);
      }
      for (const k of hit) severe[k]++;
    }
    // 零输出清单只收「记录型却零候选」（shouldReject 场景零候选是正确行为，评分层可读 gold 判定）
    if (!s.shouldReject && cands.length === 0) zeroOutput.push(s.scenarioId);
    if (s.adversarial?.target) {
      const targetId = s.adversarial.target.eventId;
      // R2-F1：TP（精确 gold 匹配）触碰 target 不计 block 违规——bait 与 gold 证据共享句子时完美抽取不受罚。
      if (s.adversarial.expectedOutcome === 'block') {
        const badTouch = cands.some((c, i) => !used.has(i) && c.evidence?.[0]?.eventId === targetId);
        if (badTouch) adv.blockViolations++;
      }
      // emit-with-flag：触碰 target 的「未打标」候选才违规；打标候选（含 TP）通过，不被无关打标候选遮蔽。
      if (s.adversarial.expectedOutcome === 'emit-with-flag') {
        const unflaggedTouch = cands.some((c) => c.evidence?.[0]?.eventId === targetId && !c.flagged);
        if (unflaggedTouch) adv.emitFlagViolations++;
      }
    }
    scenarioStats.push({ scenarioId: s.scenarioId, family: s.family, tp, fp: cands.length - tp, fn: gold.length - tp });
    const agg = famAgg.get(s.family) ?? { family: s.family, scenarios: 0, tp: 0, fp: 0, fn: 0 };
    agg.scenarios++;
    agg.tp += tp;
    agg.fp += cands.length - tp;
    agg.fn += gold.length - tp;
    famAgg.set(s.family, agg);
    if (s.language === 'zh' || s.language === 'mixed') { groups.zh.tp += tp; groups.zh.fp += cands.length - tp; groups.zh.fn += gold.length - tp; }
    if (s.language === 'en' || s.language === 'mixed') { groups.en.tp += tp; groups.en.fp += cands.length - tp; groups.en.fn += gold.length - tp; }
  }
  const families = [...famAgg.values()].sort((a, b) => a.family.localeCompare(b.family));
  return {
    stage,
    verdict: null, // fail-closed：只有 stage==='exit' 且对照 eval-manifest 才允许 pass/fail
    note: stage === 'exit' ? 'exit 阶段需对照 threshold manifest 逐项判定' : 'pilot 阶段不输出 pass/fail（04 §5 fail-closed），仅报告指标',
    // R2-m#7：配对简化声明——机器口径取首个全等匹配（04 §2 把最终裁决交人工/复核层）
    pairing: 'first-exact-match; substring=FP+FN（04 §2）',
    // R2-m#6：exit 阶段零输出处理接口占位——04 §2 零输出 precision 未定义即不通过，当前 stage=pilot 不判
    zeroOutputPolicy: stage === 'exit' ? 'per 04 §2: precision undefined → fail (enforced by exit gate, not implemented in pilot)' : 'pilot: list only, no pass/fail',
    totals: { ...totals, ...pr(totals.tp, totals.fp, totals.fn), zeroOutputCount: zeroOutput.length },
    groups: { zh: pr(groups.zh.tp, groups.zh.fp, groups.zh.fn), en: pr(groups.en.tp, groups.en.fp, groups.en.fn) },
    zeroOutput,
    severe,
    adversarial: adv,
    families,
    // 04 §3 主口径 CI（家族聚类 bootstrap）；Wilson 仍保留在 totals/groups 内作描述性
    scenarioStats,
    bootstrap: bootstrapCI(scenarioStats),
  };
}

export async function main() {
  const { readFileSync } = await import('node:fs');
  const [candFile, corpusDir] = process.argv.slice(2);
  if (!candFile || !corpusDir) {
    console.error('usage: node score.mjs <candidates.jsonl> <corpusDir>');
    process.exit(1);
  }
  const candidates = readFileSync(candFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { loadCorpus } = await import('./corpus-validate.mjs');
  const manifest = JSON.parse(readFileSync(new URL('../config/eval-manifest.json', import.meta.url), 'utf8'));
  const scenarios = await loadCorpus(corpusDir);
  console.log(JSON.stringify(scoreRun({ candidates, scenarios, manifest }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
