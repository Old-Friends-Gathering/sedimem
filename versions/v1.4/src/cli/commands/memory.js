/**
 * memo CLI —— 「记忆本体」命令 handler（从 src/cli/memo.js 原样搬出，行为零变化）。
 * write / search / brief / get / supersede / forget / stats / reindex / scope / doctor
 */
import process from 'node:process';
import path from 'node:path';
import {
  UsageError, requireOpt, serviceOpts, loadService, printJson, printRecord, parseAgent, parseNumber,
  resolveMemoHome,
} from './shared.js';
import { isSessionScope, sessionStatus } from '../../session/lifecycle.js';

export async function cmdWrite(opts, asJson) {
  const service = await loadService(serviceOpts());
  try {
    const scope = serviceOpts().scope;
    if (scope && isSessionScope(scope)) {
      const st = sessionStatus({ service });
      if (st.status !== 'open') {
        throw new UsageError(
          `任务库 ${scope} ${st.status === 'closed' ? '已关闭' : '不存在'}：先 memo session start --title "..." 创建，再写。`,
        );
      }
    }
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

export async function cmdSearch(argv, opts, asJson) {
  const service = await loadService(serviceOpts());
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
        const mark = record.snippetTruncated ? '  [snippet]' : '';
        process.stdout.write(`\n# ${record.id}  score=${score.toFixed(3)}${mark}\n`);
        printRecord(record);
      }
      if (result.readBudget?.truncated) {
        process.stdout.write(`（会话读预算已满：${result.readBudget.truncatedReason}；本次返回 ${result.readBudget.returned} 条）\n`);
      }
    }
  } finally {
    await service.close();
  }
}

export async function cmdBrief(opts) {
  const service = await loadService(serviceOpts());
  try {
    process.stdout.write(await service.brief({ lines: parseNumber(opts, 'lines') }));
  } finally {
    await service.close();
  }
}

export async function cmdGet(positional) {
  const id = positional[0];
  if (!id) throw new UsageError('memo get <id>');
  const service = await loadService(serviceOpts());
  try {
    const record = await service.get(id);
    if (!record) {
      const e = new Error(`未找到记录: ${id}`);
      e.code = 'E_NOT_FOUND';
      throw e;
    }
    printRecord(record);
    // B5 读取审计：get 也是「读过」，要能从 events 追溯（只记 id/surface，不记内容）
    await service._event('read', record.id, { surface: 'cli', recordId: record.id });
  } finally {
    await service.close();
  }
}

export async function cmdSupersede(positional, opts, asJson) {
  const id = positional[0];
  if (!id) throw new UsageError('memo supersede <id> --value "..."');
  const value = requireOpt(opts, 'value', `memo supersede ${id} --value "..."`);
  const service = await loadService(serviceOpts());
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

export async function cmdForget(positional, opts, asJson) {
  const id = positional[0];
  // B3：按来源删除复用 forget，避免再加一个顶层命令（Q16 发布面同步成本）。
  // `memo forget --source-agent dsh` / `--source-session <taskId>` / `--content-hash <h>`
  const bySource = opts['source-agent'] !== undefined
    || opts['source-session'] !== undefined
    || opts['content-hash'] !== undefined;
  if (!id && !bySource) throw new UsageError('memo forget <id> [--purge] [--reason "..."]');
  if (id && bySource) throw new UsageError('memo forget: <id> 与 --source-* 不能同时使用');
  const service = await loadService(serviceOpts());
  try {
    if (bySource) {
      const result = await service.deleteBySource({
        agent: opts['source-agent'] === true ? undefined : opts['source-agent'],
        session: opts['source-session'] === true ? undefined : opts['source-session'],
        contentHash: opts['content-hash'] === true ? undefined : opts['content-hash'],
        reason: opts.reason === true || opts.reason === undefined ? undefined : String(opts.reason),
        dryRun: opts['dry-run'] === true,
      });
      if (asJson) printJson(result);
      else {
        const verb = result.dryRun ? '将删除' : '已删除';
        process.stdout.write(`${verb} ${result.tombstoned.length} 条记录；分库 ${result.scopes.length} 个；任务账本 ${result.taskIds.length} 个\n`);
      }
      return;
    }
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

export async function withStats(asJson, fn) {
  const service = await loadService(serviceOpts());
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

/**
 * memo scope —— 打印本目录解析出的分库（裁决 28 的排查入口）。
 * 为什么 CLI 也需要：判断「DSH 写的那条我为什么搜不到」时，第一步永远是确认两边 scope 是否同一个。
 */
export async function cmdScope(asJson) {
  const { resolveScope } = await import('../../core/scope.js');
  const { scope, root } = resolveScope({ cwd: process.cwd(), env: process.env });
  const memoHome = resolveMemoHome();
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

/**
 * Windows 适配层说明（B6）。
 * 结论（docs/06 §4.1）：Windows 只支持 kernel/CLI；adapters（DSH/Codex/Claude 客户端适配、
 * launchd 自启等）不支持。doctor 在 win32 明确说明并以退出码 2 标记「部分支持」。
 * @param {string} [platform]
 */
export function windowsAdapterNotice(platform = 'win32') {
  return {
    ok: false,
    platform,
    supported: ['kernel', 'cli'],
    unsupported: ['adapters', 'launchd'],
    exitCode: 2,
    issues: [{
      code: 'windows_adapters_unsupported',
      severity: 'warning',
      message: 'Windows 仅支持 kernel/CLI（items/events/brief/search 等命令可用）；'
        + 'adapters（DSH/Codex/Claude 客户端注入、launchd 自启）不支持。详见 docs/06 §4.1。',
    }],
  };
}

/** memo doctor（任务 A）：损坏库也正常打印结构化结果并退出码 1（有 error）；健康库 0。
 *  win32：先打印适配层限制（exit 2），不把「部分支持」伪装成全绿。 */
export async function cmdDoctor(asJson, platform = process.platform) {
  if (platform === 'win32') {
    const notice = windowsAdapterNotice(platform);
    if (asJson) printJson(notice);
    else {
      process.stdout.write('Windows：仅支持 kernel/CLI\n');
      for (const i of notice.issues) process.stdout.write(`  [${i.severity}] ${i.code}: ${i.message}\n`);
    }
    return 2;
  }
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

/**
 * memo inject（B5）：构建一次注入并把审计写进 events.jsonl（kind:'inject'）。
 * 与插件 pre-step 的差别：插件是高频只读钩子，审计由本命令/显式调用方写，
 * 避免每步注入都落盘（docs/02 §3.24）。
 */
export async function cmdInject(opts, asJson) {
  const service = await loadService(serviceOpts());
  try {
    const { buildInjection } = await import('../../render/inject.js');
    const built = await buildInjection({
      memoHome: service.memoHome,
      scope: service.scope,
      maxChars: parseNumber(opts, 'max-chars') ?? parseNumber(opts, 'maxChars'),
      allowUntrusted: opts['allow-untrusted'] === true,
      surface: typeof opts.surface === 'string' ? opts.surface : 'cli',
    });
    if (built === null) {
      if (asJson) printJson({ text: null, chars: 0, audited: false });
      else process.stdout.write('（无可注入内容）\n');
      return 0;
    }
    const audited = opts['no-audit'] !== true;
    if (audited) await service._event('inject', null, built.audit);
    if (asJson) printJson({ ...built, audited });
    else process.stdout.write(`${built.text}\n`);
    return 0;
  } finally {
    await service.close();
  }
}

/**
 * memo audit verify|anchor（B5）：本地校验/锚定 events.jsonl 的哈希链。
 * 边界（必须如实说明）：**不抗同 UID 重算**——能重写事件文件的人也能重算整条链；
 * `--git` 只是把当前链头写进本地 git 提交（不 push），作为外部时间戳的可选手段。
 */
export async function cmdAudit(positional, opts, asJson) {
  const sub = positional[0] ?? 'verify';
  const service = await loadService(serviceOpts());
  try {
    const { verifyEventChain, writeAnchor, eventHash } = await import('../../storage/audit.js');
    if (sub === 'verify') {
      const events = await service.store.readEvents();
      const verify = verifyEventChain(events);
      const result = { ok: verify.ok, events: events.length, chained: verify.chained, broken: verify.broken };
      if (asJson) printJson(result);
      else {
        process.stdout.write(`${verify.ok ? 'OK' : '链断裂'}（events=${events.length}，chained=${verify.chained}）\n`);
        for (const b of verify.broken) process.stdout.write(`  [#${b.index}] ${b.reason}\n`);
      }
      return verify.ok ? 0 : 1;
    }
    if (sub === 'anchor') {
      const events = await service.store.readEvents();
      const anchor = await writeAnchor({ memoHome: service.memoHome, events });
      let git = null;
      if (opts.git === true) {
        // 只 add/commit 两个本地文件；不 push（审计锚不引入远端副作用）
        const { spawnSync } = await import('node:child_process');
        try {
          spawnSync('git', ['-C', service.memoHome, 'add', 'events.jsonl', 'events.anchor.json'], { stdio: 'pipe' });
          git = spawnSync('git', ['-C', service.memoHome, 'commit', '-m', `memo audit anchor ${new Date().toISOString()}`], { stdio: 'pipe' });
        } catch (err) {
          git = { status: null, error: err };
        }
      }
      const result = { ok: true, ...anchor, head: events.length > 0 ? eventHash(events[events.length - 1]) : null, git: git ? { status: git.status } : null };
      if (asJson) printJson(result);
      else process.stdout.write(`锚已写入 ${anchor.path}（count=${anchor.count}，chained=${anchor.chained}）\n`);
      return 0;
    }
    throw new UsageError('memo audit verify|anchor [--git] [--json]');
  } finally {
    await service.close();
  }
}
