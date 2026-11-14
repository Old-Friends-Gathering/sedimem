/**
 * memo CLI —— 基础设施命令 handler（从 src/cli/memo.js 原样搬出，行为零变化）。
 * serve / migrate / conflicts / backfill-vectors
 */
import process from 'node:process';
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
