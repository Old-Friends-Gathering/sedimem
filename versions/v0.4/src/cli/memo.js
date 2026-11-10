#!/usr/bin/env node
/**
 * memo CLI —— 入口层，只做参数解析与 JSON 编解码，业务全部委托 MemoryService。
 * 契约：docs/02-data-model-and-contract.md §3 `src/cli/memo.js`
 * 退出码：0 成功 / 1 业务失败 / 2 用法错误
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { AGENT_PATTERN, RESERVED_AGENTS } from '../core/record.js';
import { cmdView, cmdBriefTier0 } from './view.js';

function resolveMemoHome() {
  return process.env.MEMO_HOME || path.join(os.homedir(), '.memo');
}

const USAGE = `memo —— 本地跨会话记忆系统 v0.1

用法:
  memo write --text "..." [--title "一句话标题"] [--kind fact] [--subject s] [--predicate p] [--agent dsh] [--value v] [--confidence 0.8] [--tags a,b] [--privacy private|shared] [--json]
  memo search "..." [--limit 10] [--kind fact] [--as-of ISO] [--json]
  memo brief [--lines 80] [--tier0]              # --tier0：一条一行的目录（≤800 字符，v0.3）
  memo view build|rebuild                        # 重建 L2 场景块视图（纯派生，可删可重建）
  memo view show L2 [--limit 50] [--json]
  memo view trace <recordId> [--json]            # 这条记录属哪个 L2 块 / 它是哪几条的派生（L3 溯源）
  memo view l3 plan [--json]                     # L3 候选（预算上限来自 policy.l3）
  memo view l3 apply --file drafts.json          # 写入 L3（必须带 sourceRefs，一次 ≤ batchSize）
  memo get <id>
  memo supersede <id> --value "..." [--text "..."] [--agent dsh] [--json]
  memo forget <id> [--purge] [--reason "..."] [--json]
  memo stats [--json]
  memo scope [--json]                                         # 看本目录解析出的分库（以及 MCP 侧覆盖文件）
  memo doctor [--json]
  memo reindex
  memo curate export [--limit 20]
  memo curate prompt  [--limit N] [--json]              # 生成裁决任务包（docs/10）
  memo curate auto    [--limit N] [--dry-run] [--json]   # 自动裁决（JudgePort，确定性无 LLM；裁决 50）
  memo compact        [--dry-run] [--grace 7d] [--json]  # 物理清理：只删 purge+过期的墓碑（裁决 51）
  memo curate status                                  # 列出批次与进度
  memo curate apply   --file <任务包.json>              # 应用裁决（严格校验）
  memo curate apply <batchId> --decisions <file|->
  memo dedupe scan [--threshold 0.45] [--dice 0.15] [--limit 50] [--json]   # 只读：近重复候选簇（裁决 22/23/26）
  memo dedupe apply --file decisions.json                     # decisions.json: {batchId?, decisions:[{ids:[...]|pairIndex, decision, note}]}
  memo migrate dsh-memory [--db path]
  memo serve [--port N] [--no-ui]                             # 只读 Web UI/API（默认 127.0.0.1:7788；--no-ui 只提供 API）

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
  // 有 title 就先打 title（裁决 59）：它是「人扫一眼认得出是哪条」的那句话
  const head = typeof r.title === 'string' && r.title !== '' ? `  「${r.title}」\n` : '';
  process.stdout.write(
    `${r.id}  [${r.kind}] ${r.status}\n${head}  ${r.text}\n  ${r.subject}.${r.predicate} = ${r.value}  (from ${r.validFrom}${r.validTo ? ` to ${r.validTo}` : ''}, conf ${r.confidence}, agent ${r.source.agent})\n`
  );
}

// 裁决 25：source.agent 是自由标签（不再枚举），校验规则与 core/record.js 保持同一份
function parseAgent(opts, fallback = 'cli') {
  const agent = opts.agent === true || opts.agent === undefined ? fallback : String(opts.agent);
  if (!AGENT_PATTERN.test(agent) || RESERVED_AGENTS.has(agent)) {
    throw new UsageError(
      `--agent 必须匹配 ${AGENT_PATTERN}，且不能用保留名（${[...RESERVED_AGENTS].join('|')}），收到: ${agent}`,
    );
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
      // 标题（裁决 59）：一行 ≤40 字，图谱/brief 显示的就是它
      title: opts.title === true || opts.title === undefined ? undefined : String(opts.title),
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

/** memo curate（B 路，docs/10）：prompt/status 为新增；apply 兼容两个形状——
 *  旧：`curate apply <batchId> --decisions <file|->`；新：`curate apply --file <pkg.json>`。 */
async function cmdCurate(sub, positional, opts, asJson) {
  // 新增子命令走 src/cli/curate.js（任务包生成/状态/严格校验应用）
  if (sub === 'auto') {
    const curate = await import('./curate.js');
    const service = await loadService();
    try {
      await curate.curateAutoCli(service, {
        limit: parseNumber(opts, 'limit'), dryRun: opts['dry-run'] === true, json: asJson,
      });
    } finally {
      await service.close();
    }
    return;
  }
  if (sub === 'prompt' || sub === 'status' || (sub === 'apply' && opts.file !== undefined)) {
    const curate = await import('./curate.js');
    const service = await loadService();
    try {
      if (sub === 'prompt') {
        const out = await curate.curatePrompt(service, {
          limit: parseNumber(opts, 'limit'), json: asJson,
        });
        if (asJson) printJson(out);
        return;
      }
      if (sub === 'status') {
        const out = await curate.curateStatus(service);
        if (asJson) {
          printJson(out);
          return;
        }
        if (out.batches === 0) {
          process.stdout.write('待处理批次: 0\n');
          return;
        }
        process.stdout.write(`待处理批次: ${out.batches}\n`);
        for (const r of out.rows) {
          process.stdout.write(`  ${r.batchId}  ${r.total} 对 / 已裁决 ${r.decided}  → ${r.state}\n`);
        }
        return;
      }
      // curate apply --file <pkg.json>
      const file = requireOpt(opts, 'file', 'memo curate apply --file <任务包.json>');
      const result = await curate.curateApplyFile(service, file);
      printJson(result);
      return;
    } finally {
      await service.close();
    }
  }
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

/** memo serve：只读 Web 服务（W3）。SIGINT/SIGTERM 优雅关闭 exit 0；EADDRINUSE 清晰报错 exit 1。 */
async function cmdServe(opts) {
  const port = parseNumber(opts, 'port') ?? 7788;
  const { createWebServer } = await import('../web/server.js');
  let web;
  try {
    web = await createWebServer({
      memoHome: resolveMemoHome(),
      port,
      host: '127.0.0.1',
      includeUi: !opts['no-ui'],
    });
  } catch (err) {
    if (err && (err.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err.message)))) {
      process.stderr.write(`端口 ${port} 已被占用（EADDRINUSE）。请用 --port 换一个端口，例如：memo serve --port ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  }
  process.stdout.write(`memo serve 已启动: ${web.url}\n`);
  try {
    const res = await fetch(new URL('api/summary', web.url));
    const j = await res.json();
    process.stdout.write(`scope: ${j.scope}\nmemoHome: ${j.memoHome}\n`);
  } catch {
    process.stdout.write('\n');
  }
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // 裁决 21：close/flushHits 的错误不得被吞——失败时打错误并以非零码退出，
    // 否则「hits 没落盘」会被伪装成正常关闭（审核 S1）
    try {
      await web.close();
      process.exit(process.exitCode ?? 0);
    } catch (err) {
      process.stderr.write(`memo serve 关闭失败: [${err?.code ?? 'E_INTERNAL'}] ${err?.message ?? err}\n`);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise(() => {}); // 常驻直到收到信号
  return 0;
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
    case 'brief': {
      if (opts.tier0) {
        const service = await loadService();
        try { await cmdBriefTier0(opts, asJson, service); } finally { await service.close(); }
        return 0;
      }
      await cmdBrief(opts);
      return 0;
    }
    case 'view': {
      const service = await loadService();
      try { return await cmdView(positional, opts, asJson, service); } finally { await service.close(); }
    }
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
      await cmdCurate(positional[0], positional.slice(1), opts, asJson);
      return 0;
    case 'dedupe':
      await cmdDedupe(positional[0], opts, asJson);
      return 0;
    case 'compact': {
      const { compactCli } = await import('./compact.js');
      const service = await loadService();
      try {
        // grace 不写死 7d：交给 policy.quota.purgeGraceMs（契约裁决 51），CLI 只透传用户显式值
        await compactCli(service, { dryRun: opts['dry-run'] === true, grace: opts.grace, json: asJson });
      } finally {
        await service.close();
      }
      return 0;
    }
    case 'retitle': {
      const { retitleRecords } = await import('../api/retitle.js');
      const service = await loadService();
      try {
        const dryRun = opts['dry-run'] === true;
        const limit = opts.limit === undefined || opts.limit === true ? 0 : Number(opts.limit);
        // --from-file：Agent 批量产出 [{id,title}] 后一次性写入（LLM 给的标题比纯规则更像人话）
        if (opts['from-file'] !== undefined && opts['from-file'] !== true) {
          const fsp = await import('node:fs/promises');
          const raw = await fsp.readFile(String(opts['from-file']), 'utf8');
          const list = JSON.parse(raw);
          if (!Array.isArray(list)) throw new UsageError('--from-file 需要 JSON 数组：[{id,title}]');
          const { applyTitles } = await import('../api/retitle.js');
          const r = await applyTitles(service, list, { dryRun });
          if (asJson) printJson(r);
          else process.stdout.write(`retitle(from-file): changed=${r.changed} skipped=${r.skipped} failed=${r.failed.length}${dryRun ? ' (dry-run)' : ''}\n`);
          return 0;
        }
        const r = await retitleRecords(service, { dryRun, limit });
        if (asJson) printJson(r);
        else {
          const tag = dryRun ? ' (dry-run)' : '';
          process.stdout.write(`retitle: 候选 ${r.total} 条，已补 ${r.changed} 条${r.failed?.length ? `，失败 ${r.failed.length}` : ''}${tag}\n`);
          for (const s of r.samples ?? []) process.stdout.write(`  · ${s.title}\n`);
        }
      } finally {
        await service.close();
      }
      return 0;
    }
    case 'backfill-vectors': {
      const { backfillCli } = await import('./backfill.js');
      const { createEmbedder } = await import('../index/embedder.js');
      const { loadPolicy } = await import('../config/policy.js');
      return await backfillCli(opts, {
        createEmbedder,
        policy: loadPolicy(),
        json: asJson,
      });
    }
    case 'conflicts': {
      const { listConflicts, resolveConflicts } = await import('../views/conflicts.js');
      const service = await loadService();
      try {
        if (positional[0] === 'resolve') {
          const r = await resolveConflicts({
            service,
            slot: String(opts.slot ?? ''),
            winnerId: String(opts.winner ?? positional[1] ?? ''),
            note: opts.note === true ? undefined : opts.note,
          });
          if (asJson) printJson(r);
          else {
            process.stdout.write(`conflicts resolve: 落败 ${r.resolved.length} 条`
              + `${r.skipped.length ? `，跳过 ${r.skipped.length}` : ''}\n`);
            for (const x of r.resolved) process.stdout.write(`  · ${x.id} → superseded\n`);
          }
          return 0;
        }
        const r = await listConflicts({ service });
        if (asJson) printJson(r);
        else {
          process.stdout.write(`conflicts: ${r.slots.length} 个 slot，disputed ${r.disputedCount} 条，scanned ${r.scanned}\n`);
          for (const slot of r.slots) {
            process.stdout.write(`  [${slot.disputedCount ? 'DISPUTED' : 'ACTIVE'}] ${slot.key}（${slot.records.length} 条）\n`);
            for (const rec of slot.records) {
              process.stdout.write(`    ${rec.status === 'disputed' ? '!' : '·'} ${rec.id}  ${String(rec.text).slice(0, 60)}\n`);
            }
          }
          if (r.slots.length > 0) process.stdout.write('  用 memo conflicts resolve --slot <key> --winner <id> 裁决\n');
        }
        return 0;
      } finally {
        await service.close();
      }
    }
    case 'capture': {
      const { captureCli } = await import('./capture.js');
      return await captureCli({ sub: positional[0], file: opts.file, scope: opts.scope, json: asJson, ids: opts.ids, all: opts.all === true, note: opts.note });
    }
    case 'migrate':
      if (positional[0] !== 'dsh-memory') {
        throw new UsageError(`未知的 migrate 目标: ${positional[0] ?? '(空)'}\n${USAGE}`);
      }
      await runMigrate(positional.slice(1), opts);
      return 0;
    case 'serve':
      return await cmdServe(opts);
    default:
      throw new UsageError(`未知命令: ${command}\n${USAGE}`);
  }
}

async function runMigrate(positional, opts) {
  const { migrateDshMemory } = await import('./migrate-dsh-memory.js');
  await migrateDshMemory({ dbPath: opts.db === true ? undefined : opts.db, argv: positional });
}

try {
  // 命令实现里有的分支会 return 出结构化结果（如 capture/conflicts 的 payload），
  // 那不是退出码——只接受整数，否则保持 0（否则 process.exitCode = {} 会抛
  // ERR_INVALID_ARG_TYPE，用户看到「memo 失败」但其实命令已经成功）。
  const code = await main();
  process.exitCode = Number.isInteger(code) ? code : 0;
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
