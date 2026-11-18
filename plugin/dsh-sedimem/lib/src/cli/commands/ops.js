/**
 * memo CLI —— 基础设施命令 handler（从 src/cli/memo.js 原样搬出，行为零变化）。
 * serve / migrate / conflicts / backfill-vectors
 */
import process from 'node:process';
import path from 'node:path';
import { UsageError, resolveMemoHome, serviceOpts, loadService, printJson, parseNumber } from './shared.js';

/** memo serve：只读 Web 服务（W3）。SIGINT/SIGTERM 优雅关闭 exit 0；EADDRINUSE 清晰报错 exit 1。 */
export async function cmdServe(opts) {
  const port = parseNumber(opts, 'port') ?? 7788;
  const { createWebServer } = await import('../../web/server.js');
  let web;
  try {
    web = await createWebServer({
      memoHome: resolveMemoHome(),
      port,
      host: '127.0.0.1',
      includeUi: !opts['no-ui'],
      // W7：人类写入口默认关闭，`--write` 或 MEMO_WRITE=1 才开（docs/02 裁决 89）
      write: opts.write === true || opts['write'] === true,
    });
  } catch (err) {
    if (err && (err.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(err.message)))) {
      process.stderr.write(`端口 ${port} 已被占用（EADDRINUSE）。请用 --port 换一个端口，例如：memo serve --port ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  }
  process.stdout.write(`memo serve 已启动: ${web.url}\n`);
  // B4：浏览器首次 GET / 会拿到 HttpOnly cookie；脚本要直连 API 时用这里的 token（不打印值，只打印位置）
  process.stdout.write(`会话 token 文件: ${path.join(resolveMemoHome(), 'web-token')}（0600；API 用 Authorization: Bearer <token>）\n`);
  try {
    const res = await fetch(new URL('api/summary', web.url), {
      headers: { authorization: `Bearer ${web.token}` },
    });
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

export async function cmdMigrate(positional, opts, USAGE) {
  if (positional[0] !== 'dsh-memory') {
    throw new UsageError(`未知的 migrate 目标: ${positional[0] ?? '(空)'}\n${USAGE}`);
  }
  const { migrateDshMemory } = await import('../migrate-dsh-memory.js');
  await migrateDshMemory({ dbPath: opts.db === true ? undefined : opts.db, argv: positional.slice(1) });
}

export async function cmdConflicts(positional, opts, asJson) {
  const { listConflicts, resolveConflicts } = await import('../../views/conflicts.js');
  const service = await loadService(serviceOpts());
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

export async function cmdBackfillVectors(opts, asJson) {
  const { backfillCli } = await import('../backfill.js');
  const { createEmbedder } = await import('../../index/embedder.js');
  const { loadPolicy } = await import('../../config/policy.js');
  return await backfillCli(opts, {
    createEmbedder,
    policy: loadPolicy(),
    json: asJson,
  });
}

/**
 * memo llm status|test —— LLM 层自检。
 *
 * 为什么需要它：LLM 是「默认关闭 + 需要凭据」的能力，出问题时的第一个问题永远是
 * 「到底有没有拿到 key、端点通不通、预算还剩多少」。这条命令把三件事一次说清，
 * 避免去看哪一层吞了错。
 *
 *   status  → { provider, model, ready, reason, keySource, budget }
 *   test    → 真发一次极短补全（purpose=derive 的最小输入），返回耗时与 token 估算
 */
export async function llmCli(service, { action = 'status', json = false } = {}) {
  const port = service?.llmPort ?? null;
  const budget = service?.llmBudget ?? null;
  const status = {
    provider: port?.provider ?? 'none',
    model: port?.model ?? '',
    baseUrl: port?.baseUrl ?? null,
    ready: Boolean(port?.ready),
    reason: port?.ready ? 'ok' : (port?.reason ?? 'no-port'),
    keySource: port?.keySource ?? 'missing',
    dailyLimitCny: port?.dailyLimitCny ?? null,
    budget: budget && typeof budget === 'object' ? budget : null,
  };

  if (action === 'status') {
    if (json) { process.stdout.write(`${JSON.stringify({ ok: true, ...status })}\n`); return { ok: true, ...status }; }
    const lines = [
      `provider : ${status.provider}`,
      `model    : ${status.model || '–'}`,
      `baseUrl  : ${status.baseUrl || '–'}`,
      `ready    : ${status.ready ? 'yes' : 'no'}（${status.reason}）`,
      `keySource: ${status.keySource}`,
      `dailyCap : ${status.dailyLimitCny == null ? '–' : `¥${status.dailyLimitCny}`}`,
    ];
    if (status.budget) {
      lines.push(`spent    : ¥${status.budget.spentCny ?? 0}（今日 ${status.budget.calls ?? 0} 次）`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return { ok: true, ...status };
  }

  if (action !== 'test') {
    const err = new Error(`memo llm: 未知子命令 ${action}（支持 status / test）`);
    err.code = 'E_USAGE';
    throw err;
  }

  if (!port?.ready) {
    const msg = `LLM 未就绪：${status.reason}。把 key 写入 ~/.config/sedimem/llm-key（0600）`
      + '或设 MEMO_LLM_API_KEY，再把 policy.llm.provider 改成 openai-compatible、egress 改成 egress-allowed。';
    if (json) { process.stdout.write(`${JSON.stringify({ ok: false, code: 'E_LLM_UNAVAILABLE', message: msg, ...status })}\n`); return { ok: false, ...status }; }
    process.stdout.write(`${msg}\n`);
    return { ok: false, code: 'E_LLM_UNAVAILABLE', ...status };
  }

  const startedAt = Date.now();
  const res = await port.complete({
    purpose: 'derive',
    system: '你是一个严格的事实摘要器，只输出 JSON：{"title":"<=40字","summary":"<=80字"}',
    user: '记录：sedimem 的真相层是 append-only 的 JSONL，索引与摘要都是可重建的派生物。',
  });
  const ms = Date.now() - startedAt;
  if (!res.ok) {
    const msg = `LLM 调用失败：${res.error?.code ?? 'E_LLM_FAILED'} ${res.error?.message ?? ''}`;
    if (json) { process.stdout.write(`${JSON.stringify({ ok: false, code: res.error?.code ?? 'E_LLM_FAILED', message: msg, ms, ...status })}\n`); return { ok: false, ms, ...status }; }
    process.stdout.write(`${msg}\n`);
    return { ok: false, code: res.error?.code ?? 'E_LLM_FAILED', ms, ...status };
  }
  const out = { ok: true, ms, sample: String(res.text ?? '').slice(0, 200), usage: res.usage ?? null, ...status };
  if (json) { process.stdout.write(`${JSON.stringify(out)}\n`); return out; }
  process.stdout.write(`LLM 可用（${ms}ms）：${out.sample}\n`);
  return out;
}

/**
 * B3：`memo verify-delete --source-agent <a>|--source-session <s>|--content-hash <h>`
 * 有残留 → 列出位置并返回 1（脚本/CI 可直接据此失败）。
 */
export async function cmdVerifyDelete(opts, asJson) {
  const agent = opts['source-agent'] === true ? undefined : opts['source-agent'];
  const session = opts['source-session'] === true ? undefined : opts['source-session'];
  const contentHash = opts['content-hash'] === true ? undefined : opts['content-hash'];
  if (agent === undefined && session === undefined && contentHash === undefined) {
    throw new UsageError('memo verify-delete 需要 --source-agent、--source-session 或 --content-hash 之一');
  }
  const service = await loadService(serviceOpts());
  try {
    const out = await service.verifyDelete({ agent, session, contentHash });
    if (asJson) printJson(out);
    else if (out.ok) {
      process.stdout.write(`verify-delete: OK（items ${out.checked.itemLines} 行 / index ${out.checked.indexFiles} 个 / brief ${out.checked.briefFiles} 个 / 账本 ${out.checked.ledgerFiles} 个）\n`);
    } else {
      process.stdout.write(`verify-delete: 发现 ${out.residue.length} 处残留\n`);
      for (const r of out.residue) {
        process.stdout.write(`  - ${r.where}: ${r.reason}${r.id ? `（${r.id}）` : ''}${r.hash ? `（${r.hash}）` : ''}\n`);
      }
    }
    return out.ok ? 0 : 1;
  } finally {
    await service.close();
  }
}

/** B2：`memo trust promote <id> --to T0|T1 --reason "..." [--drop-taint a,b]` */
export async function cmdTrust(positional, opts, asJson) {
  if (positional[0] !== 'promote') {
    throw new UsageError('memo trust promote <id> --to T0|T1 --reason "..."');
  }
  const id = positional[1];
  if (!id) throw new UsageError('memo trust promote <id> --to T0|T1 --reason "..."');
  if (opts.to === undefined || opts.to === true) throw new UsageError('memo trust promote: --to 是必填项');
  if (opts.reason === undefined || opts.reason === true) throw new UsageError('memo trust promote: --reason 是必填项（审计要求）');
  const dropTaint = typeof opts['drop-taint'] === 'string'
    ? opts['drop-taint'].split(',').map((x) => x.trim()).filter(Boolean)
    : [];
  const service = await loadService(serviceOpts());
  try {
    const out = await service.promoteTrust({
      id, to: String(opts.to), reason: String(opts.reason), dropTaint,
    });
    const result = {
      id, from: out.from, to: out.to, taintRemoved: out.taintRemoved, v: out.record.v,
    };
    if (asJson) printJson(result);
    else process.stdout.write(`${id}: ${out.from} → ${out.to}（taint −${out.taintRemoved}）\n`);
    return 0;
  } finally {
    await service.close();
  }
}

/**
 * memo mcp（B6）：在前台启动 MCP server 子进程，stdio 直接继承。
 * 为什么用子进程：server.js 的 stdio 协议与 CLI 的 stdout 文案互斥，
 * 同进程会把 USAGE/日志混进 JSON-RPC 流，客户端直接解析失败。
 * @param {string[]} argv 原样转发给 server 的参数
 */
export async function cmdMcp(argv = []) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const serverPath = fileURLToPath(new URL('../../mcp/server.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath, ...argv], { stdio: 'inherit', env: process.env });
  return await new Promise((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(`memo mcp 启动失败: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) resolve(1);
      else resolve(typeof code === 'number' ? code : 1);
    });
  });
}
