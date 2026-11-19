// B7.6 参考集重跑（gate 口径）：把参考集（goldset-v1 的 gold claim）当作**抽取输出**喂给真管线，
// 只测量「闸门」行为——真陈述能否被接纳、严重错误是否为零、异议/纠正是否能被消解。
//
// 边界（必须遵守）：
//   1. 这不是抽取质量评测：抽取器仍是 p1a 的规则基线（`pilot/p1a/tools/baseline-runner.mjs`），
//      「抽取 P/R」以 BASELINE.md（B4 报告）为准；本工具测的是**接纳闸门**。
//   2. 只读参考集与语料；不写真相层文件、不联网、不打打补丁式后门（不传 ctx.objection）。
//   3. 输出含每个场景的行级结果，便于逐条复核；聚合指标交给 `pilot/p1a/tools/score.mjs`。
//
// 用法：
//   node pilot/p1b/tools/reference-run.mjs --corpus pilot/p1a/corpus --out pilot/p1b/out/ref-run
//   可选 --scenarios S001,S002 只跑指定场景（调试用）

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPipeline } from './pipeline.mjs';
import { createSnapshotStore } from './evidence.mjs';

const PIPELINE_VERSION = 'pipeline@b7.6-oracle-gate';

/**
 * 读取语料目录下所有 scenarios-*.jsonl。
 * @param {string} dir 语料目录
 * @returns {Array<object>} 场景数组
 */
export function loadCorpus(dir) {
  const files = readdirSync(dir).filter((f) => f.startsWith('scenarios-') && f.endsWith('.jsonl')).sort();
  const out = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}

/** 事件表与快照仓（与真管线同构：快照用于 hash 比对） */
export function buildSources(scenarios) {
  const events = new Map();
  const snapshots = createSnapshotStore();
  for (const s of scenarios) {
    for (const e of s.events ?? []) {
      events.set(e.eventId, e);
      snapshots.put({ sourceId: s.scenarioId, sourceEpoch: s.source?.sourceEpoch ?? 1, eventId: e.eventId, text: e.text });
    }
  }
  return { events, snapshots };
}

/**
 * 把一条 gold 转成「抽取输出」形态的 claim（oracle 模式：不做抽取推理）。
 * @param {object} g gold claim
 * @param {object} s 所属场景
 * @returns {object} 管线 ingest 入参
 */
export function goldToClaim(g, s) {
  const ev = (g.evidence ?? [])[0];
  const quote = ev?.quote ?? '';
  const event = (s.events ?? []).find((e) => e.eventId === ev?.eventId);
  return {
    claim: g.claim,
    scope: g.scope,
    type: g.type,
    status: g.status,
    assertion: {
      subject: g.assertion?.about ?? null,
      predicate: g.assertion?.predicate ?? null,
      value: g.assertion?.value ?? null,
      speechAct: g.assertion?.speechAct,
      negated: g.assertion?.negated,
      about: g.assertion?.about ?? null,
      condition: g.assertion?.condition ?? null,
      assertedValidFrom: g.time?.assertedValidFrom ?? null,
      assertedValidTo: g.time?.assertedValidTo ?? null,
    },
    evidence: ev
      ? [{ eventId: ev.eventId, quote, ts: event?.ts ?? null }]
      : [],
    role: g.role ?? event?.role ?? null,
  };
}

/**
 * 单场景跑管线：ingest → decide → （accept 才）commit。
 * @param {object} s 场景
 * @param {{events:Map,snapshots:object}} src 来源
 * @param {object} opts {clock}
 * @returns {{scenarioId:string, rows:Array<object>, accepted:Array<object>, rowsByDecision:object}}
 */
export function runScenario(s, src, { clock = () => new Date().toISOString() } = {}) {
  const scenarioEvents = new Map((s.events ?? []).map((e) => [e.eventId, e]));
  const p = createPipeline({
    events: scenarioEvents,
    snapshots: src.snapshots,
    sourceId: s.scenarioId,
    sourceEpoch: s.source?.sourceEpoch ?? 1,
    sourceScope: null, // 参考集场景的 scope 由 gold 自带；绑定 scope 不参与 gate 判定
    policy: {},
    clock,
  });

  const rows = [];
  const accepted = [];
  const claims = (s.gold ?? []).map((g) => goldToClaim(g, s));
  if (claims.length === 0) {
    return { scenarioId: s.scenarioId, rows, accepted, rowsByDecision: {} };
  }
  const ingested = p.ingest({ runKey: `ref-${s.scenarioId}`, claims });
  let opSeq = 0;
  ingested.forEach((item, idx) => {
    const g = s.gold[idx];
    const r = p.decide(item.candidateId);
    rows.push({
      goldId: g.goldId,
      candidateId: item.candidateId,
      row: r.row,
      decision: r.decision,
      reason: r.reason,
      objectionKind: r.objectionKind ?? null,
    });
    if (r.decision === 'accept') {
      opSeq += 1;
      const c = p.get(item.candidateId);
      const commit = p.commit(item.candidateId, {
        opId: `ref-${s.scenarioId}-op${opSeq}`,
        expected: { candidateVersion: c.meta.version, evidenceHash: c.meta.evidenceHash, expectedTruthRevision: p.truthRevision() },
      });
      accepted.push({ goldId: g.goldId, claim: g.claim, commitKind: commit.kind, recordId: commit.recordId ?? null });
    }
  });
  const rowsByDecision = rows.reduce((acc, r) => {
    acc[r.decision] = (acc[r.decision] ?? 0) + 1;
    return acc;
  }, {});
  return { scenarioId: s.scenarioId, rows, accepted, rowsByDecision };
}

/**
 * 全量参考集重跑。
 * @param {object[]} scenarios 场景
 * @param {object} opts {clock, only}
 * @returns {object} 报告对象
 */
export function runReference(scenarios, { clock = () => new Date().toISOString(), only = null } = {}) {
  const list = only ? scenarios.filter((s) => only.includes(s.scenarioId)) : scenarios;
  const src = buildSources(list);
  const perScenario = list.map((s) => runScenario(s, src, { clock }));
  const totals = { gold: 0, accept: 0, hold: 0, reject: 0 };
  const rowHistogram = {};
  const rejectReasons = {};
  const holdReasons = {};
  for (const r of perScenario) {
    totals.gold += r.rows.length;
    totals.accept += r.rowsByDecision.accept ?? 0;
    totals.hold += r.rowsByDecision.hold ?? 0;
    totals.reject += r.rowsByDecision.reject ?? 0;
    for (const row of r.rows) {
      const k = `${row.row}:${row.reason}`;
      rowHistogram[k] = (rowHistogram[k] ?? 0) + 1;
      if (row.decision === 'reject') rejectReasons[row.reason] = (rejectReasons[row.reason] ?? 0) + 1;
      if (row.decision === 'hold') holdReasons[row.reason] = (holdReasons[row.reason] ?? 0) + 1;
    }
  }
  const payload = {
    pipelineVersion: PIPELINE_VERSION,
    generatedAt: clock(),
    scenarioCount: list.length,
    totals,
    acceptRate: totals.gold ? totals.accept / totals.gold : null,
    rowHistogram,
    rejectReasons,
    holdReasons,
    perScenario,
  };
  payload.contentDigest = createHash('sha256')
    .update(JSON.stringify({ scenarioCount: list.length, totals, rowHistogram }))
    .digest('hex');
  return payload;
}

/** 落盘（含 gitignored out 目录）；返回目录 */
export function writeReport(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const dir = join(outDir, `ref-${report.generatedAt.replace(/[:.]/gu, '-')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return dir;
}

function parseArgs(argv) {
  const out = { corpus: 'pilot/p1a/corpus', out: 'pilot/p1b/out/ref-run', only: null };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/u, '');
    const v = argv[i + 1];
    if (k === 'only') out.only = String(v).split(',').map((x) => x.trim()).filter(Boolean);
    else if (k in out) out[k] = v;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  const scenarios = loadCorpus(args.corpus);
  const report = runReference(scenarios, { only: args.only });
  const dir = writeReport(report, args.out);
  const { gold, accept, hold, reject } = report.totals;
  process.stdout.write(`参考集重跑完成：场景 ${report.scenarioCount} / gold ${gold}\n`);
  process.stdout.write(`  accept ${accept} / hold ${hold} / reject ${reject}（accept 率 ${(report.acceptRate * 100).toFixed(2)}%）\n`);
  process.stdout.write(`  行分布 ${JSON.stringify(report.rowHistogram)}\n`);
  process.stdout.write(`  产物 ${dir}\n`);
}
