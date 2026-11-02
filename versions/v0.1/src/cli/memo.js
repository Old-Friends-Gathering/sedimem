#!/usr/bin/env node
/**
 * memo CLI —— 入口层，只做参数解析与 JSON 编解码，业务全部委托 MemoryService。
 * 契约：docs/02-data-model-and-contract.md §3 `src/cli/memo.js`
 * 退出码：0 成功 / 1 业务失败 / 2 用法错误
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';

function resolveMemoHome() {
  return process.env.MEMO_HOME || path.join(os.homedir(), '.memo');
}

const USAGE = `memo —— 本地跨会话记忆系统 v0.1

用法:
  memo write --text "..." [--kind fact] [--subject s] [--predicate p] [--agent dsh] [--value v] [--confidence 0.8] [--tags a,b] [--privacy private|shared] [--json]
  memo search "..." [--limit 10] [--kind fact] [--as-of ISO] [--json]
  memo brief [--lines 80]
  memo get <id>
  memo supersede <id> --value "..." [--text "..."] [--agent dsh] [--json]
  memo forget <id> [--purge] [--reason "..."] [--json]
  memo stats [--json]
  memo scope [--json]                                         # 看本目录解析出的分库（以及 MCP 侧覆盖文件）
  memo doctor [--json]
  memo reindex
  memo curate export [--limit 20]
  memo curate apply <batchId> --decisions <file|->
  memo dedupe scan [--threshold 0.45] [--dice 0.15] [--limit 50] [--json]   # 只读：近重复候选簇（裁决 22/23/26）
  memo dedupe apply --file decisions.json                     # decisions.json: {batchId?, decisions:[{ids:[...]|pairIndex, decision, note}]}
  memo migrate dsh-memory [--db path]

环境:
  MEMO_HOME   记忆库根目录（默认 ~/.memo）
  MEMO_SCOPE  强制指定 scope（默认按 cwd 推导 repo:x / dir:y）

退出码: 0 成功 / 1 业务失败 / 2 用法错误`;

class UsageError extends Error {
  constructor(msg) {
    super(msg);
    this.code = 'E_USAGE';
  }
}

/** 解析 `--flag value` / `--flag` / 位置参数。重复 flag 取最后一个布尔语义的简单实现。 */
function parseArgs(argv) {
  const positional = [];
  const opts = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

function requireOpt(opts, name, usage) {
  const v = opts[name];
  if (v === undefined || v === true || v === '') throw new UsageError(`缺少 --${name}\n${usage}`);
  return String(v);
}

async function loadService(extra = {}) {
  let mod;
  try {
    mod = await import('../api/service.js');
  } catch (err) {
    const e = new Error(
      `memo: 无法加载 MemoryService (src/api/service.js)：${err && err.message ? err.message : err}。` +
        `该模块由并行开发的同事提供，若尚未就绪请稍后重试。`
    );
    e.code = 'E_MISSING_SERVICE';
    e.cause = err;
    throw e;
  }
  const { createMemoryService } = mod;
  return createMemoryService({
    memoHome: resolveMemoHome(),
    cwd: process.cwd(),
    ...extra,
  });
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function printRecord(r) {
  process.stdout.write(
    `${r.id}  [${r.kind}] ${r.status}\n  ${r.text}\n  ${r.subject}.${r.predicate} = ${r.value}  (from ${r.validFrom}${r.validTo ? ` to ${r.validTo}` : ''}, conf ${r.confidence}, agent ${r.source.agent})\n`
  );
}

const ALLOWED_AGENTS = new Set(['dsh', 'codex', 'claude', 'cli', 'test', 'unknown']);

function parseAgent(opts, fallback = 'cli') {
  const agent = opts.agent === true || opts.agent === undefined ? fallback : String(opts.agent);
  if (!ALLOWED_AGENTS.has(agent)) {
    throw new UsageError(`--agent 必须是 dsh|codex|claude|cli|test|unknown，收到: ${agent}`);
  }
  return agent;
}

function parseNumber(opts, name) {
  if (opts[name] === undefined || opts[name] === true) return undefined;
  const n = Number(opts[name]);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} 不是数字: ${opts[name]}`);
  return n;
}

async function cmdWrite(opts, asJson) {
  const service = await loadService();
  try {
    const text = requireOpt(opts, 'text', 'memo write --text "..."');
    const result = await service.write({
      text,
      kind: opts.kind === true || opts.kind === undefined ? undefined : String(opts.kind),
      subject: opts.subject === true ? undefined : opts.subject,
      predicate: opts.predicate === true ? undefined : opts.predicate,
      value: opts.value === true || opts.value === undefined ? text : String(opts.value),
      confidence: parseNumber(opts, 'confidence'),
      tags: opts.tags === true || opts.tags === undefined ? undefined : String(opts.tags).split(',').map((s) => s.trim()).filter(Boolean),
      privacy: opts.privacy === true ? undefined : opts.privacy,
      source: { agent: parseAgent(opts) },
    });
    if (asJson) printJson(result);
    else
      process.stdout.write(
        `${result.action}${result.supersededId ? ` (superseded ${result.supersededId})` : ''}: ${result.record.id}\n`
      );
  } finally {
    await service.close();
  }
}

async function cmdSearch(argv, opts, asJson) {
  const service = await loadService();
  try {
    const query = argv.join(' ');
    if (!query) throw new UsageError('memo search 需要一个查询串');
    const result = await service.search(query, {
      limit: parseNumber(opts, 'limit'),
      kind: opts.kind === true ? undefined : opts.kind,
      asOf: opts['as-of'] === true ? undefined : opts['as-of'],
    });
    if (asJson) printJson(result);
    else {
      process.stdout.write(`共 ${result.total} 条（asOf ${result.asOf}）\n`);
      for (const { record, score } of result.items) {
        process.stdout.write(`\n# ${record.id}  score=${score.toFixed(3)}\n`);
        printRecord(record);
      }
    }
  } finally {
    await service.close();
  }
}

async function cmdBrief(opts) {
  const service = await loadService();
  try {
    process.stdout.write(await service.brief({ lines: parseNumber(opts, 'lines') }));
  } finally {
    await service.close();
  }
}

async function cmdGet(positional) {
  const id = positional[0];
  if (!id) throw new UsageError('memo get <id>');
  const service = await loadService();
  try {
    const record = await service.get(id);
    if (!record) {
      const e = new Error(`未找到记录: ${id}`);
      e.code = 'E_NOT_FOUND';
      throw e;
    }
    printRecord(record);
  } finally {
    await service.close();
  }
}

async function cmdSupersede(positional, opts, asJson) {
  const id = positional[0];
  if (!id) throw new UsageError('memo supersede <id> --value "..."');
  const value = requireOpt(opts, 'value', `memo supersede ${id} --value "..."`);
  const service = await loadService();
  try {
    const result = await service.supersede({
      oldId: id,
      value,
      text: opts.text === true || opts.text === undefined ? undefined : String(opts.text),
      source: { agent: parseAgent(opts) },
      reason: opts.reason === true ? undefined : opts.reason,
    });
    if (asJson) printJson(result);
    else printRecord(result.record);
  } finally {
    await service.close();
  }
}

async function cmdForget(positional, opts, asJson) {
  const id = positional[0];
  if (!id) throw new UsageError('memo forget <id> [--purge]');
  const service = await loadService();
  try {
    const result = await service.forget({
      id,
      mode: opts.purge ? 'purge' : 'tombstone',
      reason: opts.reason === true || opts.reason === undefined ? undefined : String(opts.reason),
    });
    if (asJson) printJson(result);
    else process.stdout.write(`${result.id}: ${result.status}\n`);
  } finally {
    await service.close();
  }
}

async function withStats(asJson, fn) {
  const service = await loadService();
  try {
    const result = await fn(service);
    if (asJson) printJson(result);
    else if (Array.isArray(result.issues)) {
      process.stdout.write(result.ok ? 'OK\n' : '发现问题:\n');
      for (const i of result.issues) process.stdout.write(`  [${i.severity}] ${i.code}: ${i.detail}\n`);
    } else printJson(result);
  } finally {
    await service.close();
  }
}

/** memo dedupe scan / apply（任务 B，裁决 22/23）。
 *  scan 只读：走 service.dedupeScan；apply 走 service.curateApply（非破坏落盘）。 */
async function cmdDedupe(sub, opts, asJson) {
  if (sub !== 'scan' && sub !== 'apply') {
    throw new UsageError(`未知的 dedupe 子命令: ${sub ?? '(空)'}\n${USAGE}`);
  }
  const service = await loadService();
  try {
    if (sub === 'scan') {
      const threshold = parseNumber(opts, 'threshold');
      if (threshold !== undefined && (threshold < 0 || threshold > 1)) {
        throw new UsageError(`--threshold 需在 [0,1] 内，收到: ${threshold}`);
      }
      if (typeof service.dedupeScan !== 'function') {
        const e = new Error('E_MISSING_DEDUPE_SCAN: MemoryService 尚未提供 dedupeScan（src/api/service.js 同事并行实现中）');
        e.code = 'E_MISSING_DEDUPE_SCAN';
        throw e;
      }
      const diceThreshold = parseNumber(opts, 'dice');
      if (diceThreshold !== undefined && (diceThreshold < 0 || diceThreshold > 1)) {
        throw new UsageError('--dice 需在 [0,1] 内');
      }
      const result = await service.dedupeScan({ threshold, diceThreshold, limit: parseNumber(opts, 'limit') });
      if (asJson) {
        printJson(result);
      } else if (result.clusters.length === 0) {
        process.stdout.write(`scanned=${result.scanned} threshold=${result.threshold}，无候选簇\n`);
      } else {
        process.stdout.write(`候选簇 ${result.clusters.length} 个（scanned=${result.scanned} threshold=${result.threshold} dice=${result.diceThreshold}）\n`);
        for (const c of result.clusters) {
          process.stdout.write(
            `\n#${c.key}  size=${c.size}  maxSimilarity=${c.maxSimilarity.toFixed(3)}  basis=${c.basis}\n`,
          );
          for (const i of c.items) {
            process.stdout.write(`  ${i.id}  [${i.kind}/${i.status}]  ${i.text}\n`);
          }
          if (Array.isArray(c.pairs) && c.pairs.length > 0) {
            process.stdout.write('  pairs:\n');
            for (const p of c.pairs) {
              process.stdout.write(
                `    ${p.strength} ${p.basis} score=${p.score} (c=${p.containment} d=${p.dice})  ${p.aId} <-> ${p.bId}\n`,
              );
            }
          }
        }
      }
      return;
    }
    // dedupe apply --file decisions.json
    const file = requireOpt(opts, 'file', 'memo dedupe apply --file decisions.json');
    const { readFile } = await import('node:fs/promises');
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new UsageError(`--file 不是合法 JSON (${file}): ${err.message}`);
    }
    const batchId = parsed && typeof parsed === 'object' && typeof parsed.batchId === 'string' ? parsed.batchId : undefined;
    const idShaped = Array.isArray(parsed.decisions) && parsed.decisions.some((d) => d && Array.isArray(d.ids));
    if (!batchId && !idShaped) {
      throw new UsageError(
        '--file 内容需含字符串 batchId（pairIndex 形状裁决），或 decisions 内使用 {ids:[...], decision} 形状（dedupe 簇 id 直接裁决，无需 batchId）'
      );
    }
    if (!Array.isArray(parsed.decisions)) throw new UsageError('--file 内容需含 decisions 数组 [{ids|pairIndex, decision, note}]');
    const result = await service.curateApply({ batchId, decisions: parsed.decisions });
    printJson(result);
  } finally {
    await service.close();
  }
}

async function cmdCurate(sub, positional, opts) {
  const service = await loadService();
  try {
    if (sub === 'export') {
      const batch = await service.curateExport({ limit: parseNumber(opts, 'limit') });
      if (!batch) {
        process.stdout.write('无待裁决候选\n');
        return;
      }
      printJson(batch);
    } else if (sub === 'apply') {
      const batchId = positional[0];
      if (!batchId) throw new UsageError('memo curate apply <batchId> --decisions <file|->');
      const decisionsSrc = requireOpt(opts, 'decisions', `memo curate apply ${batchId} --decisions <file|->`);
      let decisionsText;
      if (decisionsSrc === '-') {
        decisionsText = await new Promise((resolve, reject) => {
          let buf = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (c) => (buf += c));
          process.stdin.on('end', () => resolve(buf));
          process.stdin.on('error', reject);
        });
      } else {
        const { readFile } = await import('node:fs/promises');
        decisionsText = await readFile(decisionsSrc, 'utf8');
      }
      let decisions;
      try {
        decisions = JSON.parse(decisionsText);
      } catch (err) {
        throw new UsageError(`decisions 不是合法 JSON: ${err.message}`);
      }
      if (!Array.isArray(decisions)) throw new UsageError('decisions 必须是 JSON 数组 [{pairIndex, decision, note}]');
      printJson(await service.curateApply({ batchId, decisions }));
    } else {
      throw new UsageError(`未知的 curate 子命令: ${sub}\n${USAGE}`);
    }
  } finally {
    await service.close();
  }
}

/** memo doctor（任务 A）：损坏库也正常打印结构化结果并退出码 1（有 error）；健康库 0。 */
/**
 * memo scope —— 打印本目录解析出的分库（裁决 28 的排查入口）。
 * 为什么 CLI 也需要：判断「DSH 写的那条我为什么搜不到」时，第一步永远是确认两边 scope 是否同一个。
 */
async function cmdScope(asJson) {
  const { resolveScope } = await import('../core/scope.js');
  const { scope, root } = resolveScope({ cwd: process.cwd(), env: process.env });
  const memoHome = process.env.MEMO_HOME || path.join(os.homedir(), '.memo');
  // MCP 侧的覆盖是**按客户端**存的（.scope.<client>.json），列出全部而不是只读一个：
  // 排障时最常见的问题就是「DSH 那份覆盖指向别的项目」。
  const overrides = {};
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    for (const f of readdirSync(memoHome)) {
      const m = /^\.scope\.(.+)\.json$/.exec(f);
      if (!m) continue;
      try {
        const raw = JSON.parse(readFileSync(path.join(memoHome, f), 'utf8'));
        if (raw && typeof raw.scope === 'string') overrides[m[1]] = raw.scope;
      } catch {
        overrides[m[1]] = '<损坏>';
      }
    }
  } catch {
    /* memoHome 还不存在 */
  }
  const out = {
    scope,
    source: process.env.MEMO_SCOPE ? 'env:MEMO_SCOPE' : 'cwd',
    root,
    memoHome,
    mcpOverrides: overrides,
  };
  if (asJson) {
    printJson(out);
    return 0;
  }
  process.stdout.write(`scope    ${out.scope}（来源：${out.source}）\n`);
  process.stdout.write(`cwd      ${root}\n`);
  process.stdout.write(`memoHome ${out.memoHome}\n`);
  const names = Object.keys(overrides);
  if (names.length === 0) {
    process.stdout.write('MCP 覆盖 未设置（常驻 MCP server 按自身 cwd 解析；需要对齐时用 memory_scope）\n');
  } else {
    process.stdout.write('MCP 覆盖（按客户端，仅常驻 MCP server 使用，CLI 不读它）：\n');
    for (const n of names) process.stdout.write(`  ${n} → ${overrides[n]}\n`);
  }
  return 0;
}

async function cmdDoctor(asJson) {
  let service;
  try {
    service = await loadService();
  } catch (err) {
    // 双保险：即使 service 构造仍抛 E_CORRUPT_JSONL，也按结构化结果呈现而非裸抛
    if (err.code === 'E_CORRUPT_JSONL') {
      const m = String(err.message).match(/at (\S+?\.jsonl)(?::(\d+))?/);
      const issue = {
        code: 'corrupt_jsonl', severity: 'error',
        file: m ? m[1] : null, line: m && m[2] !== undefined ? Number(m[2]) : null,
        message: err.message,
        detail: err.message,
      };
      const result = { ok: false, issues: [issue] };
      if (asJson) printJson(result);
      else {
        process.stdout.write('发现问题:\n');
        process.stdout.write(`  [error] corrupt_jsonl: ${issue.detail}\n`);
      }
      return 1;
    }
    throw err;
  }
  let result;
  try {
    result = await service.doctor();
  } finally {
    try {
      await service.close();
    } catch (err) {
      if (err.code !== 'E_CORRUPT_JSONL') throw err; // 损坏库的 close 失败已被 doctor 呈现
    }
  }
  if (asJson) printJson(result);
  else {
    process.stdout.write(result.ok ? 'OK\n' : '发现问题:\n');
    for (const i of result.issues) {
      const loc = i.file ? `${i.file}${i.line !== null && i.line !== undefined ? `:${i.line}` : ''}: ` : '';
      const extra = i.code === 'duplicate_content_hash'
        ? ` (count=${i.count}, ids=${(i.ids ?? []).join(',')})` : '';
      process.stdout.write(`  [${i.severity}] ${i.code}: ${loc}${i.detail ?? i.message}${extra}\n`);
    }
  }
  return result.ok ? 0 : 1; // 有 error → 退出码 1
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const command = argv[0];
  const { positional, opts } = parseArgs(argv.slice(1));
  const asJson = Boolean(opts.json);

  switch (command) {
    case 'write':
      await cmdWrite(opts, asJson);
      return 0;
    case 'search':
      await cmdSearch(positional, opts, asJson);
      return 0;
    case 'brief':
      await cmdBrief(opts);
      return 0;
    case 'get':
      await cmdGet(positional);
      return 0;
    case 'supersede':
      await cmdSupersede(positional, opts, asJson);
      return 0;
    case 'forget':
      await cmdForget(positional, opts, asJson);
      return 0;
    case 'stats':
      await withStats(asJson, (s) => s.stats());
      return 0;
    case 'scope':
      return await cmdScope(asJson);
    case 'doctor':
      return await cmdDoctor(asJson);
    case 'reindex':
      await withStats(asJson, (s) => s.reindex());
      return 0;
    case 'curate':
      await cmdCurate(positional[0], positional.slice(1), opts);
      return 0;
    case 'dedupe':
      await cmdDedupe(positional[0], opts, asJson);
      return 0;
    case 'migrate':
      if (positional[0] !== 'dsh-memory') {
        throw new UsageError(`未知的 migrate 目标: ${positional[0] ?? '(空)'}\n${USAGE}`);
      }
      await runMigrate(positional.slice(1), opts);
      return 0;
    default:
      throw new UsageError(`未知命令: ${command}\n${USAGE}`);
  }
}

async function runMigrate(positional, opts) {
  const { migrateDshMemory } = await import('./migrate-dsh-memory.js');
  await migrateDshMemory({ dbPath: opts.db === true ? undefined : opts.db, argv: positional });
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`用法错误: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      `memo 失败 [${err.code ?? 'E_UNKNOWN'}]: ${err && err.message ? err.message : err}\n`
    );
    process.exitCode = 1;
  }
}
