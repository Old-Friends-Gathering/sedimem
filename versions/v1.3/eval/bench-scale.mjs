#!/usr/bin/env node
// eval/bench-scale.mjs — 规模基准（D6）：write/search/冷启动重建/RSS（任务 A4）
// 用法：node versions/v0.4/eval/bench-scale.mjs --sizes 10000 [--json out.json]
// 不 import 任何第三方包；临时 MEMO_HOME 建在 os.tmpdir()，绝不写仓库目录。
// PASS/WARN 判据（docs/plans/v0.4-competitive-gaps.md §D6）：search p95 ≤ 50ms 且 coldStart ≤ 5000ms；
// WARN 不 exit 1（门禁语义：超了再优化，不阻塞）。

import { createMemoryService } from '../src/api/service.js';
import { QuotaPolicy } from '../src/hygiene/quota.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SEARCH_QUERIES = 200; // 每规模随机查询次数（p50/p95 样本量）
const SEARCH_P95_BUDGET_MS = 50; // D6 门禁：search p95 ≤ 50ms
const COLD_START_BUDGET_MS = 5000; // D6 门禁：冷启动重建 ≤ 5s

/**
 * 解析 --sizes（逗号列表，默认 10000）与 --json <path>。
 * @param {string[]} argv
 * @returns {{sizes: number[], jsonPath: string|null}}
 */
function parseArgs(argv) {
  const sizes = [];
  let jsonPath = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sizes') {
      const raw = argv[++i];
      if (raw === undefined) usageError('--sizes 需要一个值，如 --sizes 10000 或 --sizes 1000,10000');
      for (const part of String(raw).split(',')) {
        const n = Number(part.trim());
        if (!Number.isInteger(n) || n < 1) usageError(`--sizes 含非法规模: ${JSON.stringify(part)}`);
        sizes.push(n);
      }
    } else if (a === '--json') {
      jsonPath = argv[++i];
      if (!jsonPath) usageError('--json 需要一个输出文件路径');
    } else if (a === '--help' || a === '-h') {
      process.stdout.write('用法: node bench-scale.mjs --sizes 10000 [--json out.json]\n');
      process.exit(0);
    } else {
      usageError(`未知参数: ${a}`);
    }
  }
  return { sizes: sizes.length ? sizes : [10000], jsonPath };
}

/** 参数错误统一带 err.code='E_INVALID_ARG'。 */
function usageError(msg) {
  const err = new Error(`bench-scale: ${msg}`);
  err.code = 'E_INVALID_ARG';
  throw err;
}

/**
 * 升序排序后取分位数（线性插值，样本量小也稳定）。
 * @param {number[]} samples
 * @param {number} p 0..1
 * @returns {number}
 */
function percentile(samples, p) {
  const s = [...samples].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * 造第 i 条基准记录文本：保证 token 有区分度（随机查询能命中一部分），
 * 且 subject 唯一（避开同 slot 冲突裁决，让全部走 created 路径）。
 */
function makeRecord(i) {
  const topic = TOPICS[i % TOPICS.length];
  return {
    text: `${topic} 基准条目 ${i}：索引写入与检索延迟采样点，编号 token-${i}。`,
    title: `${topic} #${i}`,
    kind: 'fact',
    subject: `bench-item-${i}`,
    predicate: 'scale-index',
    source: { agent: 'bench' },
  };
}

const TOPICS = ['检索', '写入', '索引', '冷启动', '内存', '配额', '去重', '裁决'];

/**
 * 跑单个规模的完整基准。
 * @param {number} n 写入条数
 * @returns {Promise<{n:number,write:object,search:object,coldStartMs:number,rssMB:number}>}
 */
async function benchOne(n) {
  const home = mkdtempSync(join(tmpdir(), `sedimem-bench-${n}-`));
  try {
    // 配额注入 maxActive = n + 1000：默认 5000 会在 10k 写入时触发淘汰（tombstone），
    // 淘汰不是本基准的对象，抬高上限让全部记录保持 active。
    const quota = new QuotaPolicy({ maxActive: n + 1000 });
    const svc = await createMemoryService({ memoHome: home, scope: 'bench:scale', quota });

    // —— write 延迟 ——
    const writeMs = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const { action } = await svc.write(makeRecord(i));
      const dt = performance.now() - t0;
      if (action !== 'created') {
        const err = new Error(`bench-scale: 第 ${i} 条写入 action=${action}（期望 created，可能触发同 slot 判定）`);
        err.code = 'E_BENCH_WRITE';
        throw err;
      }
      writeMs.push(dt);
    }

    // —— search 延迟（200 次随机查询：一半命中主题词，一半命中唯一 token）——
    const searchMs = [];
    for (let q = 0; q < SEARCH_QUERIES; q++) {
      const i = Math.floor(Math.random() * n);
      const query = q % 2 === 0 ? TOPICS[i % TOPICS.length] : `token-${i}`;
      const t0 = performance.now();
      await svc.search(query, { limit: 10 });
      searchMs.push(performance.now() - t0);
    }

    // —— 冷启动重建：同一 memoHome 上新实例，计时到第一次可查询 ——
    const tCold = performance.now();
    const svc2 = await createMemoryService({ memoHome: home, scope: 'bench:scale', quota });
    await svc2.search(TOPICS[0], { limit: 1 });
    const coldStartMs = performance.now() - tCold;

    const rssMB = round2(process.memoryUsage().rss / 1024 / 1024);
    await svc2.close();
    await svc.close();

    return {
      n,
      write: { p50: round2(percentile(writeMs, 0.5)), p95: round2(percentile(writeMs, 0.95)) },
      search: { p50: round2(percentile(searchMs, 0.5)), p95: round2(percentile(searchMs, 0.95)) },
      coldStartMs: round2(coldStartMs),
      rssMB,
    };
  } finally {
    // trap 清理：无论成功/失败都删临时 MEMO_HOME，不写仓库目录
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * 人读表格（对齐列宽，中文环境也够用）。
 * @param {object[]} rows
 */
function printTable(rows) {
  const head = ['n', 'write p50', 'write p95', 'search p50', 'search p95', 'coldStartMs', 'rssMB'];
  const table = [head, ...rows.map((r) => [
    String(r.n), `${r.write.p50}ms`, `${r.write.p95}ms`, `${r.search.p50}ms`, `${r.search.p95}ms`, String(r.coldStartMs), String(r.rssMB),
  ])];
  const widths = head.map((_, c) => Math.max(...table.map((row) => row[c].length)));
  for (const row of table) {
    process.stdout.write(`  ${row.map((cell, c) => cell.padStart(widths[c])).join('  |  ')}\n`);
  }
}

// —— main ——
const { sizes, jsonPath } = parseArgs(process.argv.slice(2));
const results = { generatedAt: new Date().toISOString(), node: process.version, sizes: [] };
let verdict = 'PASS';
for (const n of sizes) {
  process.stderr.write(`bench: n=${n} 写入+检索中…\n`);
  const r = await benchOne(n);
  results.sizes.push(r);
  if (r.search.p95 > SEARCH_P95_BUDGET_MS || r.coldStartMs > COLD_START_BUDGET_MS) verdict = 'WARN';
}
process.stdout.write('\n');
printTable(results.sizes);
if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`\nJSON 已写入: ${jsonPath}\n`);
}
process.stdout.write(
  `\n${verdict}（判据: search p95 ≤ ${SEARCH_P95_BUDGET_MS}ms 且 coldStart ≤ ${COLD_START_BUDGET_MS}ms）\n`,
);
