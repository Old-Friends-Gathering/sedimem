/**
 * memo CLI —— 「记忆本体」命令 handler（从 src/cli/memo.js 原样搬出，行为零变化）。
 * write / search / brief / get / supersede / forget / stats / reindex / scope / doctor
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import {
  UsageError, requireOpt, serviceOpts, loadService, printJson, printRecord, parseAgent, parseNumber,
} from './shared.js';

export async function cmdWrite(opts, asJson) {
  const service = await loadService(serviceOpts());
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
        process.stdout.write(`\n# ${record.id}  score=${score.toFixed(3)}\n`);
        printRecord(record);
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
  if (!id) throw new UsageError('memo forget <id> [--purge]');
  const service = await loadService(serviceOpts());
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

/** memo doctor（任务 A）：损坏库也正常打印结构化结果并退出码 1（有 error）；健康库 0。 */
export async function cmdDoctor(asJson) {
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
