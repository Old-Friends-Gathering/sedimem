#!/usr/bin/env node
// eval/run.js — L3 评测入口：注入回归 + 指标 + bench
// 用法：node eval/run.js [--json] [--suite all|injection|metrics|bench]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CASES_DIR = join(HERE, 'cases');
const RESULTS_DIR = join(HERE, 'results');
const TMP_ROOT = join(HERE, '.tmp');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json');
const suiteIdx = argv.indexOf('--suite');
const suite = suiteIdx >= 0 && argv[suiteIdx + 1] ? argv[suiteIdx + 1] : 'all';
if (!['all', 'injection', 'metrics', 'bench'].includes(suite)) {
  console.error(`用法错误：未知 --suite "${suite}"（可选 all|injection|metrics|bench）`);
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const ts = new Date().toISOString().replace(/[:.]/g, '-');

// ---------- 工具 ----------
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}
function statsOf(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: pct(s, 50), p95: pct(s, 95), n: samples.length };
}

/** 把「模块找不到」错误转成可读的相对路径提示 */
function friendlyModuleError(err) {
  const m = String(err?.message || '').match(/Cannot find module '([^']+)'/);
  if (m) {
    let p = m[1].replace(/^file:\/\//, '');
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
    const rel = relative(ROOT, p) || p;
    return `实现缺失：找不到模块 ${rel}（请先完成该文件的实现）`;
  }
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return `实现缺失：${err.message}`;
  return null;
}

async function loadService() {
  const url = pathToFileURL(join(ROOT, 'src/api/service.js')).href;
  try {
    return await import(url);
  } catch (err) {
    const friendly = friendlyModuleError(err);
    console.error(friendly || `实现加载失败：${err?.stack || err}`);
    process.exit(1);
  }
}

// ---------- injection：子进程跑 tests/injection ----------
const CASE_FILES = [
  ['I1', 'i1-duplicate.test.js'],
  ['I2', 'i2-conflict.test.js'],
  ['I3', 'i3-stale.test.js'],
  ['I4', 'i4-delete.test.js'],
  ['I5', 'i5-poison.test.js'],
  ['I6', 'i6-quota.test.js'],
  ['I7', 'i7-paraphrase.test.js'],
  ['I8', 'i8-concurrent.test.js'],
  ['I9', 'i9-asof-tz.test.js'],
  ['I10', 'i10-suspicious-read.test.js'],
  ['I11', 'i11-agent-judge.test.js'],
  ['I12', 'i12-cjk-dedupe.test.js'],
];

function runCase(id, file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--test', join('tests', 'injection', file)], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (err) => resolve({ id, pass: false, ms: Date.now() - t0, detail: `spawn 失败：${err.message}` }));
    p.on('close', (code) => {
      const ms = Date.now() - t0;
      if (code === 0) return resolve({ id, pass: true, ms, detail: 'ok' });
      // 找模块缺失信息，给出可读错误
      const m = out.match(/Cannot find module '([^']+)'/);
      let detail;
      if (m) {
        let mod = m[1].replace(/^file:\/\//, '');
        try { mod = decodeURIComponent(mod); } catch { /* keep raw */ }
        const rel = relative(ROOT, mod);
        detail = `实现缺失：找不到模块 ${rel || mod}`;
      } else {
        // 取 TAP 失败摘要（最后几行非空文本）
        const lines = out.split('\n').filter((l) => l.trim());
        detail = lines.slice(-12).join(' | ').slice(0, 500);
      }
      resolve({ id, pass: false, ms, detail });
    });
  });
}

// ---------- metrics：指标快照 ----------
async function metricsSuite() {
  const { createMemoryService } = await loadService();
  const home = mkdtempSync(join(TMP_ROOT, 'metrics-'));
  const svc = await createMemoryService({ memoHome: home, scope: 'repo:eval-metrics' });
  let writes = 0;
  let searches = 0;
  let st2out = null;
  try {
    const i1 = JSON.parse(readFileSync(join(CASES_DIR, 'i1-duplicate.json'), 'utf8'));
    for (const text of i1.texts) {
      await svc.write({ text, subject: i1.subject, predicate: i1.predicate, value: i1.value, source: { agent: 'test' } });
      writes++;
    }
    const i2 = JSON.parse(readFileSync(join(CASES_DIR, 'i2-conflict.json'), 'utf8'));
    let nowMs = i2.tFirstMs;
    const clock = { nowMs: () => nowMs, now: () => new Date(nowMs).toISOString() };
    const svc2 = await createMemoryService({ memoHome: home, scope: 'repo:eval-metrics2', clock });
    try {
      await svc2.write({ text: i2.first.text, subject: i2.subject, predicate: i2.predicate, value: i2.first.value, source: { agent: 'test' } });
      nowMs = i2.tSecondMs;
      await svc2.write({ text: i2.second.text, subject: i2.subject, predicate: i2.predicate, value: i2.second.value, source: { agent: 'test' } });
      writes += 2;
      await svc2.search(i2.query); searches++;
      st2out = await svc2.stats();
    } finally {
      await svc2.close();
    }
    await svc.search(i1.query); searches++;
    const st = await svc.stats();

    // --- I7 指标：换措辞近重复拦截（unstructured，不带 subject/predicate） ---
    const i7 = JSON.parse(readFileSync(join(CASES_DIR, 'i7-paraphrase.json'), 'utf8'));
    const svc7 = await createMemoryService({ memoHome: home, scope: 'repo:eval-metrics-i7' });
    let st7 = null;
    try {
      let blocked = 0;
      for (const text of i7.paraphrases) {
        const r = await svc7.write({ text, source: { agent: 'test' } });
        writes++;
        if (r.action !== 'created') blocked++;
      }
      st7 = await svc7.stats();
      st7.__nearDupBlocked = blocked;
      await svc7.search(i7.query); searches++;
    } finally {
      await svc7.close();
    }

    // --- curate 指标：制造一个 disputed 对 → curateExport → curateApply(a_wins) 后 disputed 应清零 ---
    const svcC = await createMemoryService({ memoHome: home, scope: 'repo:eval-metrics-curate' });
    let disputedAfterCurate = null;
    try {
      await svcC.write({ text: '评审状态当前是 pending，等待 owner 确认', subject: 'policy.review', predicate: 'status', value: 'pending', source: { agent: 'test' } });
      writes++;
      await svcC.write({ text: '评审状态已被安全策略阻塞，标记为 blocked', subject: 'policy.review', predicate: 'status', value: 'blocked', source: { agent: 'test' } });
      writes++;
      const batch = await svcC.curateExport();
      if (batch) {
        await svcC.curateApply({ batchId: batch.batchId, decisions: [{ pairIndex: 0, decision: 'a_wins' }] });
        disputedAfterCurate = (await svcC.stats()).disputed ?? 0;
      } else {
        // 无 disputed 可裁决时（例如实现把不可比对也拦截了），直接读当前 disputed
        disputedAfterCurate = (await svcC.stats()).disputed ?? 0;
      }
    } finally {
      await svcC.close();
    }

    // --- I11 指标（裁决 23）：Agent 当裁判闭环 —— dedupeScan 发现簇 + curateApply(merge) 收敛 ---
    // §3.3 的 5 句真人改写（词法门控不拦）+ 1 句追加改写，共 6 条同义
    const I11_TEXTS = [
      'The CI deploy pipeline requires Node 22+',
      'Our release pipeline needs node version 22 or later',
      'CI/CD deployment must use Node.js 22 minimum',
      'pipeline: node >= 22 required for deploy',
      'node 22 is the minimum version the deployment pipeline needs',
      'Deploying through CI requires at least version 22 of Node',
    ];
    const svc11 = await createMemoryService({ memoHome: home, scope: 'repo:eval-metrics-i11' });
    let dedupeClusters = null;
    let agentMerged = null;
    let agentLoopActive = null;
    try {
      const ids = [];
      for (const text of I11_TEXTS) {
        const r = await svc11.write({ text, source: { agent: 'test' } });
        writes++;
        ids.push(r.record.id);
      }
      const scan = await svc11.dedupeScan({ threshold: 0.45 });
      dedupeClusters = scan.clusters.length;
      const texts = new Set(I11_TEXTS);
      const cluster = scan.clusters.find((c) => c.items.filter((it) => texts.has(it.text)).length >= 4);
      if (cluster) {
        // Agent 判定：同簇逐对 merge（胜者 = 簇内第一条）
        const items = cluster.items.filter((it) => ids.includes(it.id));
        const pairs = items.slice(1).map((loser) => ({
          a: { id: items[0].id },
          b: { id: loser.id },
          reason: 'dedupe cluster: agent judged same fact',
        }));
        const batch = await svc11.queue.exportBatch(pairs, { limit: pairs.length });
        const decisions = pairs.map((_, i) => ({ pairIndex: i, decision: 'merge', note: 'eval I11 agent judge' }));
        const applied = await svc11.curateApply({ batchId: batch.batchId, decisions });
        agentMerged = applied.applied.filter((r) => r.applied).length;
        agentLoopActive = (await svc11.stats()).active;
      } else {
        agentMerged = 0;
        agentLoopActive = (await svc11.stats()).active;
      }
    } finally {
      await svc11.close();
    }

    const active = st.active + (st2out?.active ?? 0) + (st7?.active ?? 0);
    return {
      active,
      dupRatio: st.dupRatio,
      conflictRate: st2out?.conflictRate ?? 0,
      unitCost: active > 0 ? Number(((writes + searches) / active).toFixed(3)) : null,
      nearDupBlocked: st7?.__nearDupBlocked ?? null,       // I7a：20 条词面近似句中被近重复拦截的条数
      disputedAfterCurate,                                  // curate(a_wins) 后残留 disputed（期望 0）
      dedupeClusters,                                       // I11：dedupeScan(0.45) 发现的候选簇数
      agentMerged,                                          // I11：Agent merge 裁决成功落盘对数
      agentLoopActive,                                      // I11：merge 后残留 active（期望 ≤2）
      gate: {
        dupRatio: st.dupRatio < 0.10,
        conflictRate: (st2out?.conflictRate ?? 0) < 0.20,
        disputedCountI7: (st7?.disputed ?? 0) === 0,        // I7a 门禁：换措辞不得制造 disputed
        dedupeClustersFound: (dedupeClusters ?? 0) >= 1,    // I11 门禁：候选发现必须有效
        agentLoopConverged: agentMerged >= 4 && agentLoopActive !== null && agentLoopActive <= 2,
      },
    };
  } finally {
    await svc.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------- bench：写入 1000/5000，采样 write/search 延迟 ----------
async function benchSuite() {
  const { createMemoryService } = await loadService();
  const out = {};
  for (const n of [1000, 5000]) {
    const home = mkdtempSync(join(TMP_ROOT, `bench-${n}-`));
    const svc = await createMemoryService({ memoHome: home, scope: `repo:eval-bench${n}` });
    try {
      const wTimes = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        await svc.write({
          text: `基准第 ${i} 条 bench item k${i} = v${i}`,
          subject: `bench.g${i % 10}`,
          predicate: `k${i}`,
          value: `v${i}`,
          source: { agent: 'test' },
        });
        wTimes.push(performance.now() - t0);
      }
      const sTimes = [];
      for (let i = 0; i < 200; i++) {
        const q = `bench v${(i * 7) % n}`;
        const t0 = performance.now();
        await svc.search(q);
        sTimes.push(performance.now() - t0);
      }
      out[`n${n}`] = { write: statsOf(wTimes), search: statsOf(sTimes) };
    } finally {
      await svc.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  }
  return out;
}

// ---------- 汇总 ----------
mkdirSync(RESULTS_DIR, { recursive: true });
mkdirSync(TMP_ROOT, { recursive: true });

const report = { version, ts: new Date().toISOString(), cases: [], metrics: null, bench: null };
try {
  if (suite === 'all' || suite === 'injection') {
    for (const [id, file] of CASE_FILES) report.cases.push(await runCase(id, file));
  }
  if (suite === 'all' || suite === 'metrics') report.metrics = await metricsSuite();
  if (suite === 'all' || suite === 'bench') report.bench = await benchSuite();
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

const resultFile = join(RESULTS_DIR, `v${version}-${ts}.json`);
// 末尾补换行：Q8 编码卫生门禁要求所有文件以 \n 结束（历史上这里漏了，导致跑完 eval 就红）
const serialize = (o) => JSON.stringify(o, null, 2) + '\n';
writeFileSync(resultFile, serialize(report));
writeFileSync(join(RESULTS_DIR, 'LATEST.json'), serialize(report));

// ---------- 输出 ----------
if (!jsonOut) {
  console.log(`memo eval v${version}  suite=${suite}  ${report.ts}`);
  if (report.cases.length) {
    console.log('\n┌──────┬──────┬──────────┬──────────────────────────────┐');
    console.log('│ case │ pass │   ms     │ detail                       │');
    console.log('├──────┼──────┼──────────┼──────────────────────────────┤');
    for (const c of report.cases) {
      const d = c.detail.length > 28 ? c.detail.slice(0, 27) + '…' : c.detail;
      console.log(`│ ${c.id.padEnd(4)} │ ${(c.pass ? 'PASS' : 'FAIL').padEnd(4)} │ ${String(c.ms).padEnd(8)} │ ${d.padEnd(28)} │`);
    }
    console.log('└──────┴──────┴──────────┴──────────────────────────────┘');
  }
  if (report.metrics) {
    const m = report.metrics;
    console.log(`\nmetrics: active=${m.active} dupRatio=${m.dupRatio}(${m.gate.dupRatio ? 'ok' : 'FAIL'}) ` +
      `conflictRate=${m.conflictRate}(${m.gate.conflictRate ? 'ok' : 'FAIL'}) unitCost=${m.unitCost}`);
    console.log(`  nearDupBlocked=${m.nearDupBlocked} disputedAfterCurate=${m.disputedAfterCurate} ` +
      `disputedCountI7(${m.gate.disputedCountI7 ? 'ok' : 'FAIL'})`);
    console.log(`  dedupeClusters=${m.dedupeClusters}(${m.gate.dedupeClustersFound ? 'ok' : 'FAIL'}) ` +
      `agentMerged=${m.agentMerged} agentLoopActive=${m.agentLoopActive} ` +
      `agentLoop(${m.gate.agentLoopConverged ? 'ok' : 'FAIL'})`);
  }
  if (report.bench) {
    console.log('\nbench:');
    for (const [k, v] of Object.entries(report.bench)) {
      console.log(`  ${k}: write p50=${v.write.p50?.toFixed(2)}ms p95=${v.write.p95?.toFixed(2)}ms | ` +
        `search p50=${v.search.p50?.toFixed(2)}ms p95=${v.search.p95?.toFixed(2)}ms`);
    }
  }
  console.log(`\n结果已写入 ${relative(process.cwd(), resultFile) || resultFile} 与 LATEST.json`);
} else {
  console.log(JSON.stringify(report));
}

const casesFail = report.cases.some((c) => !c.pass);
const gateFail = report.metrics && (!report.metrics.gate.dupRatio || !report.metrics.gate.conflictRate
  || !report.metrics.gate.disputedCountI7 || !report.metrics.gate.dedupeClustersFound
  || !report.metrics.gate.agentLoopConverged);
if (casesFail || gateFail) process.exit(1);
