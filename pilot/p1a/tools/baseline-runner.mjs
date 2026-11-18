// B2 基线 runner：确定性规则抽取（无 LLM、不读 gold）。
// 定位=地板基线：证明评测管线可算 P/R 与七类严重错误，不代表 P1b 抽取质量。
// 红线：候选状态恒 pending；不写真相层；scope 恒 pilot:synthetic（scopeUnresolved=true）。
import { createHash } from 'node:crypto';
import { makeCandidateId } from './protocol-sim.mjs';

function sha256(s) {
  return 'sha256:' + createHash('sha256').update(s, 'utf8').digest('hex');
}

const ACK_SET = new Set(['好的','好','ok','okk','okkk','okkkk','thanks','thank','you','感谢','收到','明白','understood','noted','perfect','nice','great','嗯','哦','嗯嗯','哦哦','haha','hahaha','correct','已记录','记录','没问题','got','it','done','完成','了解','好嘞']);
function isAckSentence(sentence) {
  if (sentence.length > 24) return false;
  const tokens = sentence.toLowerCase().replace(/[.!！。?？]+$/, '').split(/[\s,，、;；:：]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => ACK_SET.has(t));
}

const NEG_CUES = [/不支持/, /不使用/, /不需要/, /不能/, /不会/, /不再/, /未曾/, /没有/, /别/, /不得/, /\b(not|never|no|cannot|can't|won't|doesn't|isn't|aren't|without)\b/i];
const SUGGEST_CUES = [/(我?建议|推荐|不妨|可以考虑|suggests?|recommend)/i];
const DECIDE_CUES = [/(决定|拍板|定了|decided)/i];
const COND_CUES = [/(如果|假如|若|假设)/, /\b(if|hypothetical|would|could|might)\b/i];

function firstCue(cues, s) {
  for (const re of cues) {
    const m = s.match(re);
    if (m) return m[0];
  }
  return null;
}

export function deriveInputHash(scenario) {
  // 只含事件文本；gold/adversarial/shouldReject 绝不参与（防泄漏，04 §6）。
  return sha256(scenario.events.map((e) => String(e.text)).join('\n'));
}

export function normalizeClaim(s) {
  return String(s)
    .toLowerCase()
    .replace(/[。，、；：！？.,;:!'"()（）[\]「」…·—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveSpan(event, quote) {
  const text = String(event.text);
  const first = text.indexOf(quote);
  if (first === -1) return { start: 0, end: 0, resolvable: false };
  const last = text.lastIndexOf(quote);
  if (first !== last) return { start: 0, end: 0, resolvable: false }; // 非唯一定位
  return { start: first, end: first + quote.length, resolvable: true };
}

export function extractCandidates(scenario, { runId = 'baseline' } = {}) {
  const out = [];
  // R2-B#1：不读 shouldReject（gold 侧标注）。无可记内容必须靠规则自然产出零候选，
  // 由评分层对照 gold 判定零输出是否正确（04 §6 禁入清单）。
  const inputHash = deriveInputHash(scenario);
  const seen = new Set(); // 同场景同 claim 幂等去重
  for (const ev of scenario.events) {
    if (!['user', 'assistant', 'tool'].includes(ev.role)) continue;
    for (const raw of String(ev.text).split(/[。；？！?!;\n]+/)) {
      const sentence = raw.trim();
      if (sentence.length < 6) continue;
      if (isAckSentence(sentence)) continue;
      const negCue = firstCue(NEG_CUES, sentence);
      const sugCue = firstCue(SUGGEST_CUES, sentence);
      const decCue = firstCue(DECIDE_CUES, sentence);
      const condCue = firstCue(COND_CUES, sentence);
      const type = condCue ? 'hypothesis' : 'fact';
      const span = resolveSpan(ev, sentence);
      const id = makeCandidateId(
        { sourceEpoch: scenario.source?.sourceEpoch ?? 1, rangeId: scenario.scenarioId, inputHash },
        normalizeClaim(sentence),
      );
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        candidateId: id,
        schemaVersion: 1, // R2-m#8：整数递增（01 §1），抽取器版本记在 provenance.tool
        scenarioId: scenario.scenarioId,
        status: 'pending',
        type,
        claim: sentence,
        role: ev.role,
        scope: 'pilot:synthetic',
        scopeUnresolved: true,
        assertion: {
          speechAct: sugCue ? 'suggest' : decCue ? 'decide' : 'state',
          negated: Boolean(negCue),
          about: null,
          condition: condCue,
        },
        evidence: [{ eventId: ev.eventId, quote: sentence, start: span.start, end: span.end, hash: span.resolvable ? sha256(ev.text) : null, resolvable: span.resolvable }],
        provenance: { provider: 'rule', model: 'none', tool: 'baseline-rules@pilot-1', runId }, // R2-m#8：provider 用 01 §1 闭集 rule|glm|human
        time: { observedAt: ev.ts ?? null },
      });
    }
  }
  return out;
}

export function runBaseline(scenarios, { runId = 'baseline' } = {}) {
  const candidates = [];
  const zeroOutputScenarios = [];
  for (const s of scenarios) {
    const c = extractCandidates(s, { runId });
    candidates.push(...c);
    // 只陈述抽取侧事实（零候选清单）；是否「正确零输出」由评分层对照 gold 判定
    if (c.length === 0) zeroOutputScenarios.push(s.scenarioId);
  }
  // 04 §3：固定配置多次运行要可复现——内容摘要刻意剔除 runId（运行身份不属于抽取内容）。
  const digest = createHash('sha256').update(JSON.stringify(candidates.map((c) => ({ ...c, provenance: { ...c.provenance, runId: '' } })))).digest('hex');
  return {
    candidates,
    meta: { runId, extractor: 'baseline-rules@pilot-1', processed: scenarios.length, zeroOutputScenarios, contentDigest: digest },
  };
}

export async function main() {
  const { loadCorpus } = await import('./corpus-validate.mjs');
  const [corpusDir, outDir] = process.argv.slice(2);
  if (!corpusDir) {
    console.error('usage: node baseline-runner.mjs <corpusDir> [outDir]');
    process.exit(1);
  }
  const scenarios = await loadCorpus(corpusDir);
  const runId = 'baseline-' + new Date().toISOString().replace(/[:.]/g, '-');
  const r = runBaseline(scenarios, { runId });
  const target = outDir ?? `pilot/p1a/out/baseline/${runId}`;
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(target, { recursive: true });
  writeFileSync(`${target}/candidates.jsonl`, r.candidates.map((c) => JSON.stringify(c)).join('\n') + '\n');
  writeFileSync(`${target}/meta.json`, JSON.stringify(r.meta, null, 2) + '\n');
  console.log(JSON.stringify({ runId, target, candidates: r.candidates.length, zeroOutputScenarios: r.meta.zeroOutputScenarios }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
