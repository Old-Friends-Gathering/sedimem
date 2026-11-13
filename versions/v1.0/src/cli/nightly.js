#!/usr/bin/env node
/**
 * nightly —— 确定性夜间整合（无 LLM、无随机）。
 * 步骤（契约 docs/01-architecture.md §2「整合」；裁决 #20）：
 *   1. TTL 过期标记：active 且 expired 的 state 类记录 → forget(tombstone, reason='ttl_expired')
 *   2. 配额淘汰：委托 service.enforceQuota({dryRun})（墓碑打 tags:['quota']，策略唯一来源 config/policy.js）
 *   3. flushHits（读路径累计的 hits 增量聚合落盘，裁决 #6/#21）
 *   4. brief 重建并落盘 $MEMO_HOME/brief/<scope>.md（契约布局声明，派生层允许覆盖重写）
 *   5. metrics 快照写 $MEMO_HOME/metrics/<date>.json
 * 策略单一来源（裁决 #20）：本文件不携带任何淘汰阈值/半衰期常量，
 * maxActive 等一律经 src/config/policy.js loadPolicy() 读取、淘汰逻辑一律走 service。
 * 只读遍历用 store.loadScope；任何写操作走 MemoryService（裁决 #10）。
 * 用法: node src/cli/nightly.js [--dry-run] [--json] [--scope ...]
 * --dry-run 只打印计划，不写盘。
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { metricsFileName, briefFileName } from '../config/paths.js';

const USAGE = `nightly —— memo 确定性夜间整合

用法: node src/cli/nightly.js [--dry-run] [--json] [--scope repo:x]
环境: MEMO_HOME（默认 ~/.memo）、MEMO_SCOPE（强制指定 scope）`;

function failLoud(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

function parseArgv(argv) {
  const opts = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) failLoud('E_USAGE', `无法识别的参数: ${a}\n${USAGE}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else opts[key] = true;
  }
  return opts;
}

async function loadService(scope) {
  let mod;
  try {
    mod = await import('../api/service.js');
  } catch (err) {
    failLoud(
      'E_MISSING_SERVICE',
      `无法加载 MemoryService (src/api/service.js)：${err.message}。nightly 依赖该模块，请待其就绪后重试。`
    );
  }
  return mod.createMemoryService({
    memoHome: process.env.MEMO_HOME || path.join(os.homedir(), '.memo'),
    ...(scope ? { scope } : {}),
  });
}

/** 策略唯一来源（裁决 #20）：maxActive 等一律从 src/config/policy.js 读。 */
async function loadPolicy() {
  let mod;
  try {
    mod = await import('../config/policy.js');
  } catch (err) {
    failLoud(
      'E_MISSING_POLICY',
      `无法加载策略模块 (src/config/policy.js)：${err.message}。裁决 #20 要求策略单一来源，nightly 不携带本地副本。`
    );
  }
  if (typeof mod.loadPolicy !== 'function') {
    failLoud('E_MISSING_POLICY', 'src/config/policy.js 未导出 loadPolicy()。');
  }
  return mod.loadPolicy();
}

/** 计算过期候选：active 且 isExpired（TTL 语义委托 src/hygiene/decay.js）。只读遍历。 */
async function findExpired(records) {
  const { isExpired } = await import('../hygiene/decay.js');
  const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() };
  return records.filter((r) => r.status === 'active' && r.validTo === null && isExpired(r, clock));
}

/** enforceQuota 返回形状适配：容忍 {evicted:[ids]} / {ids:[...]} / [ids] / {count:n}。 */
function extractEvictedIds(result) {
  if (Array.isArray(result)) return result.map((x) => (typeof x === 'string' ? x : x?.id ?? String(x)));
  const arr = result?.evicted ?? result?.ids ?? result?.records;
  if (Array.isArray(arr)) return arr.map((x) => (typeof x === 'string' ? x : x?.id ?? String(x)));
  if (typeof result?.count === 'number') return result.count;
  return [];
}

/** flushHits 返回形状适配：容忍 {flushed:n} / {count:n} / [{id,hits}]。 */
function extractHitsFlushed(result) {
  if (typeof result?.flushed === 'number') return result.flushed;
  if (typeof result?.count === 'number') return result.count;
  if (Array.isArray(result)) return result.length;
  return 0;
}

/**
 * 检索健康指标（issue #36，裁决 52）：聚合当天 [date 00:00 UTC, now) 的 search 事件。
 * 分母为 0 → 全部写 null（不是 0）：夜跑时当天没有检索是常态，
 * 写 0 会把「没数据」画成「命中率 0%」，趋势图会说谎。
 * @returns {Promise<{searchCount:number|null,noHitRate:number|null,staleHitRate:number|null,avgTopScore:number|null}>}
 */
async function computeSearchMetrics(service, date) {
  const since = `${date}T00:00:00.000Z`; // 与 metrics 文件名同一 date 窗口（UTC）
  const until = new Date().toISOString();
  const { events } = await service.events({ since, until, ops: ['search'], limit: 100000 });
  const searchCount = events.length;
  if (searchCount === 0) {
    return { searchCount: null, noHitRate: null, staleHitRate: null, avgTopScore: null };
  }
  const noHit = events.filter((ev) => ev.detail?.hits === 0).length;
  const stale = events.filter((ev) => (ev.detail?.staleHits ?? 0) > 0).length;
  const scores = events
    .map((ev) => ev.detail?.topScore)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  return {
    searchCount,
    noHitRate: noHit / searchCount,
    staleHitRate: stale / searchCount,
    // 当天全是空结果（topScore 全 null）时均值分母为 0 → 同样写 null
    avgTopScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  };
}

// ─── 数学/金融纯函数（W4：只报表，绝不写 policy）──────────────────────────
// 三个函数都是纯函数：同输入必同输出、零副作用，单测直接 import 本文件
// （因此文件末尾的 main() 执行加了 isMain 守卫，import 不会再触发 CLI 跑批）。

/** math 段兜底：policy.json 缺 math/子键时使用这些默认值（纪律：不改 policy.json）。 */
const MATH_DEFAULTS = Object.freeze({
  calibrateDecay: Object.freeze({ enabled: true, minSamples: 50, reportOnly: true }),
  hysteresis: Object.freeze({ enterRatio: 0.8, exitRatio: 0.6 }),
});

/** 取 policy.math.calibrateDecay.minSamples，缺段/缺键/非数值兜底到默认值。 */
function minSamplesOf(policy) {
  const v = policy?.math?.calibrateDecay?.minSamples;
  return typeof v === 'number' && Number.isFinite(v) ? v : MATH_DEFAULTS.calibrateDecay.minSamples;
}

/** 取 policy.math.hysteresis.<键>，缺段/缺键/非数值兜底到默认值。 */
function hysteresisOpt(policy, key) {
  const v = policy?.math?.hysteresis?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : MATH_DEFAULTS.hysteresis[key];
}

/**
 * 生存分析式半衰期估计（W4 任务 1：**只报告**，绝不写 policy）。
 * 对每个 kind：取 status==='superseded' 且 validFrom/validTo 可解析的记录，
 * 计算存活时长 (validTo - validFrom) 毫秒；样本数 < minSamples（默认 50）→
 * 返回 { note:'insufficient-samples', medianMs:null, suggestedHalfLifeMs:null }；
 * 够样本 → 建议半衰期 = round(中位数 × ln2)（口径按任务契约固定：×0.693）。
 * 结果只落 metrics.decayCalibration，**绝不回写 policy**（reportOnly 语义）。
 * @param {{records:Array, policy?:object, now?:number|string}} args
 * @returns {Array<{kind:string,samples:number,medianMs:number|null,suggestedHalfLifeMs:number|null,note?:string}>}
 */
export function calibrateDecay({ records, policy, now } = {}) {
  if (!Array.isArray(records)) {
    const err = new Error('calibrateDecay: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const minSamples = minSamplesOf(policy);
  // 按 kind 分桶：只看已被 superseded 的记录（active 记录的存活时长还没结束，属删失样本）
  const byKind = new Map();
  for (const r of records) {
    if (!r || r.status !== 'superseded') continue;
    const from = Date.parse(r.validFrom ?? '');
    const to = Date.parse(r.validTo ?? '');
    // 非法/非正时长（时钟回拨、手工修数据）不进样本，避免污染中位数
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from <= 0) continue;
    const kind = String(r.kind ?? 'unknown');
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(to - from);
  }
  const out = [];
  for (const [kind, durations] of byKind) {
    if (durations.length < minSamples) {
      out.push({ kind, samples: durations.length, medianMs: null, suggestedHalfLifeMs: null, note: 'insufficient-samples' });
      continue;
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    // 偶数个样本取中间两数的均值（标准中位数定义）
    const medianMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    // 指数衰减分布的经验近似：中位数 × ln2 ≈ 建议半衰期（口径按任务契约固定为 ×0.693）
    out.push({ kind, samples: sorted.length, medianMs, suggestedHalfLifeMs: Math.round(medianMs * 0.693) });
  }
  return out;
}

/**
 * 滞回开关（W4 任务 2：纯函数，不接插件）。
 * ratio ≥ enterRatio（默认 0.8）→ 'on'；ratio ≤ exitRatio（默认 0.6）→ 'off'；
 * 中间保持 prev（默认 'off'）。用于「会话 token 用满提示」的防抖：
 * 单阈值开关在阈值附近会来回抖动，双阈值滞回消除抖动。
 * @param {{ratio:number, prev?:string, policy?:object}} args
 * @returns {'on'|'off'}
 */
export function hysteresisState({ ratio, prev, policy } = {}) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    const err = new Error('hysteresisState: ratio must be a finite number');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const enter = hysteresisOpt(policy, 'enterRatio');
  const exit = hysteresisOpt(policy, 'exitRatio');
  if (ratio >= enter) return 'on';
  if (ratio <= exit) return 'off';
  return prev === 'on' ? 'on' : 'off'; // 中间带保持原状态；prev 缺省视为 'off'
}

/**
 * 注入足迹统计（W4 任务 3：为将来 R(D) 曲线留数据）。
 * brief/tier0 均按「字符数 = String.length（含换行）、行数 = split('\n').length」计；
 * null/undefined 计 0。
 * @param {{brief?:string|null, tier0?:string|null}} args
 * @returns {{briefChars:number,briefLines:number,tier0Chars:number,tier0Lines:number}}
 */
export function tokenFootprint({ brief, tier0 } = {}) {
  const count = (s) => (typeof s === 'string' ? { chars: s.length, lines: s.split('\n').length } : { chars: 0, lines: 0 });
  const b = count(brief);
  const t = count(tier0);
  return { briefChars: b.chars, briefLines: b.lines, tier0Chars: t.chars, tier0Lines: t.lines };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const opts = parseArgv(argv);
  const dryRun = Boolean(opts['dry-run']);
  const asJson = Boolean(opts.json);

  const memoHome = process.env.MEMO_HOME || path.join(os.homedir(), '.memo');
  const policy = await loadPolicy(); // 裁决 #20：策略单一来源（本文件不写死任何阈值）
  const service = await loadService(opts.scope === true ? undefined : opts.scope);

  const plan = { date: new Date().toISOString().slice(0, 10), dryRun, expired: [], evicted: [], hitsFlushed: 0, briefPath: null, briefLines: 0, metrics: null, dedupe: null };
  try {
    // 枚举当前记录集：service.search 要求非空查询、无法全量拉取；
    // 通过 StoragePort（JsonlStore.loadScope，fold 后最后一行胜出）只读真相层（裁决 #10 例外）。
    const { JsonlStore } = await import('../storage/jsonl-store.js');
    const { resolveScope } = await import('../core/scope.js');
    const scopeOpt = opts.scope === true ? undefined : opts.scope;
    const { scope } = scopeOpt
      ? { scope: scopeOpt }
      : resolveScope({ env: process.env });
    const store = new JsonlStore({ memoHome });
    const records = await store.loadScope(scope); // 只读，绝不写真相层

    // 1) TTL 过期标记（语义委托 src/hygiene/decay.js isExpired；写走 service.forget）
    const expired = await findExpired(records);
    plan.expired = expired.map((r) => r.id);

    if (!dryRun) {
      for (const r of expired) {
        await service.forget({ id: r.id, mode: 'tombstone', reason: 'nightly:ttl_expired' });
      }
    }

    // 2) 配额淘汰：裁决 #20 —— 必须走 service.enforceQuota()（墓碑打 tags:['quota']），
    //    禁止本地实现淘汰选择逻辑（审核 arch#4：本地淘汰造成 doctor 盲区）。
    const quotaResult = await service.enforceQuota({ dryRun });
    plan.evicted = extractEvictedIds(quotaResult);

    // 3) flushHits：读路径累计的 hits 增量聚合落盘（裁决 #6；#21 要求不吞错）
    if (!dryRun) {
      plan.hitsFlushed = extractHitsFlushed(await service.flushHits());
    }

    // 3b) 派生队列兜底排空（v1.0 W3 裁决 86：nightly 是第三顺位 drain 者，上限 200 条，
    //     受 llm 日预算约束；无 provider 时立即全部 no-provider 失败，不会无限重试）
    if (!dryRun) {
      try {
        plan.deriveDrained = await service.drainDerive({ limit: 200 });
      } catch (err) {
        plan.deriveDrained = { error: String(err?.message ?? err) };
      }
    }

    // 4) brief 重建并落盘（契约布局声明 brief/<scope>.md；派生层，允许覆盖重写）
    const brief = await service.brief({});
    plan.briefLines = brief.split('\n').length;
    const briefPath = path.join(memoHome, 'brief', briefFileName(scope));
    plan.briefPath = briefPath;
    if (!dryRun) {
      await fsp.mkdir(path.dirname(briefPath), { recursive: true });
      await fsp.writeFile(briefPath, brief.endsWith('\n') ? brief : brief + '\n');
    }

    // 4b) 注入足迹（W4 任务 3）：brief + tier0 目录的字符/行数，
    //     为将来 R(D)（检索质量-预算）曲线留数据。tier0 用 renderTier0 纯渲染（只读）。
    const { renderTier0 } = await import('../render/tier0.js');
    const tier0Text = renderTier0(records, { policy, now: Date.now() }).text;
    const footprint = tokenFootprint({ brief, tier0: tier0Text });

    // 4c) 半衰期校准（W4 任务 1）：生存分析式估计，**只报告**——
    //     结果落 metrics.decayCalibration，绝不写 policy（math.calibrateDecay.reportOnly）。
    //     enabled=false 时跳过计算（math 段缺失视为启用，默认值兜底）。
    const calibEnabled = policy?.math?.calibrateDecay?.enabled !== false;
    const decayCalibration = calibEnabled
      ? calibrateDecay({ records, policy, now: Date.now() })
      : [];

    // 6) 去重候选簇（裁决 23：只打印摘要，不自动裁决；--dry-run 同样可见。
    //    dedupeScan 只读，安全；API 未就绪时降级为提示，不阻断其余整合步骤。）
    if (typeof service.dedupeScan === 'function') {
      const scan = await service.dedupeScan({}); // threshold/limit 默认走 policy.dedupe（裁决 24）
      plan.dedupe = {
        clusters: scan.clusters.length,
        scanned: scan.scanned,
        threshold: scan.threshold,
        summary: scan.clusters.map((c) => ({
          key: c.key,
          size: c.size,
          maxSimilarity: c.maxSimilarity,
          ids: c.items.slice(0, 3).map((i) => i.id),
        })),
      };
    }

    // 5) metrics 快照
    const stats = dryRun
      ? await service.stats() // dry-run 未写盘，统计即当前态
      : await service.stats();

    // 检索健康指标（issue #36，裁决 52）：当天（同一 date 窗口）的 search 事件聚合。
    // 口径：searchCount=事件数；noHitRate=hits===0 占比；staleHitRate=staleHits>0 占比；
    // avgTopScore=topScore 非 null 的均值。分母为 0 一律写 null——
    // 「没有数据」≠「命中率 0%」，混用会让趋势图说谎。
    const searchMetrics = await computeSearchMetrics(service, plan.date);
    plan.metrics = {
      ts: new Date().toISOString(),
      scope,
      maxActive: policy?.quota?.maxActive,
      total: stats.total,
      active: stats.active,
      superseded: stats.superseded,
      disputed: stats.disputed,
      tombstoned: stats.tombstoned,
      dupRatio: stats.dupRatio,
      conflictRate: stats.conflictRate,
      avgHits: stats.avgHits,
      expiredCount: plan.expired.length,
      evictedCount: Array.isArray(plan.evicted) ? plan.evicted.length : plan.evicted,
      hitsFlushed: plan.hitsFlushed,
      dedupeCandidates: plan.dedupe ? plan.dedupe.clusters : 0, // 裁决 23：候选簇数量（不自动裁决）
      // W4 数学/金融三条（只报表）：注入足迹 + 半衰期校准
      briefChars: footprint.briefChars,
      briefLines: footprint.briefLines,
      tier0Chars: footprint.tier0Chars,
      tier0Lines: footprint.tier0Lines,
      decayCalibration,
      ...searchMetrics,
    };

    if (!dryRun) {
      const metricsDir = path.join(memoHome, 'metrics');
      await fsp.mkdir(metricsDir, { recursive: true });
      // 裁决 31：metrics 按 scope 分文件，scopeKey 归一化非法字符；
      // 同 scope 覆盖，不同 scope 隔离（旧 <date>.json 多分库同日互相覆盖属静默丢失）。
      const file = path.join(metricsDir, metricsFileName(plan.date, scope));
      await fsp
        .writeFile(file, JSON.stringify(plan.metrics, null, 2) + '\n', { flag: 'wx' })
        .catch((err) => {
          if (err.code === 'EEXIST') {
            // 同日重复运行：覆盖为最新快照（metrics 是派生层，可弃）
            return fsp.writeFile(file, JSON.stringify(plan.metrics, null, 2) + '\n');
          }
          throw err;
        });
    }

    if (asJson) process.stdout.write(JSON.stringify(plan) + '\n');
    else {
      process.stdout.write(
        `nightly ${plan.date}${dryRun ? ' (dry-run)' : ''}  scope=${scope}\n` +
          `  TTL 过期标记: ${plan.expired.length} 条\n` +
          `  配额淘汰: ${plan.metrics.evictedCount} 条（service.enforceQuota，墓碑 tags:['quota']，maxActive=${policy?.quota?.maxActive}）\n` +
          `  hits 落盘: ${plan.hitsFlushed} 条（service.flushHits）\n` +
          `  brief: ${plan.briefLines} 行 → ${plan.briefPath}\n` +
          `  注入足迹: brief=${footprint.briefChars}字符/${footprint.briefLines}行 tier0=${footprint.tier0Chars}字符/${footprint.tier0Lines}行\n` +
          (decayCalibration.length > 0
            ? `  半衰期校准(只报告): ${decayCalibration.map((c) => `${c.kind}:n=${c.samples}${c.medianMs == null ? '(样本不足)' : `→${c.suggestedHalfLifeMs}ms`}`).join('  ')}\n`
            : `  半衰期校准(只报告): 未计算（math.calibrateDecay.enabled=false 或无 superseded 样本）\n`) +
          `  metrics: active=${plan.metrics.active} dupRatio=${plan.metrics.dupRatio} conflictRate=${plan.metrics.conflictRate} hitsFlushed=${plan.metrics.hitsFlushed} searchCount=${plan.metrics.searchCount}\n` +
          (plan.dedupe
            ? `  去重候选: ${plan.dedupe.clusters} 簇（threshold=${plan.dedupe.threshold}，不自动裁决，裁决 23）\n` +
              plan.dedupe.summary
                .map((c) => `    - ${c.key}  size=${c.size}  maxSimilarity=${c.maxSimilarity.toFixed(3)}  ids=${c.ids.join(', ')}\n`)
                .join('')
            : `  去重候选: 未统计（MemoryService 尚未提供 dedupeScan）\n`) +
          (dryRun
            ? `  （未写盘；brief 将写 ${plan.briefPath}，metrics 快照将写 ${path.join(memoHome, 'metrics', metricsFileName(plan.date, scope))}）\n`
            : `  metrics 已写 ${path.join(memoHome, 'metrics', metricsFileName(plan.date, scope))}\n`)
      );
    }
    return 0;
  } finally {
    await service.close();
  }
}

// isMain 守卫：单测 import 本文件的纯函数（calibrateDecay 等）时不得触发 CLI 跑批。
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`nightly 失败 [${err.code ?? 'E_UNKNOWN'}]: ${err.message}\n`);
    process.exit(1);
  });
}
