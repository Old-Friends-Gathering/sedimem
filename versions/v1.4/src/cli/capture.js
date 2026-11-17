// cli/capture.js — `memo capture scan|list|accept|reject`（D3，任务 B2）
// 入口层：参数解析 + 输出投影；抽取在 capture/extract.js，队列在 capture/queue.js，入库走 api/service.js。

import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { extractCandidates } from '../capture/extract.js';
import { createCaptureQueue } from '../capture/queue.js';
import { createMemoryService } from '../api/service.js';
import { resolveScope } from '../core/scope.js';

/** memoHome 解析：入参 > MEMO_HOME > ~/.memo（与 src/cli/memo.js 同口径） */
function resolveMemoHome(explicit) {
  return explicit || process.env.MEMO_HOME || path.join(os.homedir(), '.memo');
}

/** scope 解析：显式入参 > 进程 cwd/env 解析（与 createMemoryService 同口径） */
function resolveScopeOr(scope) {
  return scope ?? resolveScope({ env: process.env }).scope;
}

/** 读输入文本：`-` 或缺省走 stdin（读完全量） */
async function readInput(file) {
  if (file && file !== '-') return readFileSync(file, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** 输出：--json 原样，否则人读行 */
function emit(json, text, value) {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(text);
  return value;
}

/**
 * `memo capture` CLI。
 * @param {{sub?: string, file?: string, scope?: string, memoHome?: string, json?: boolean,
 *          ids?: string[], all?: boolean, note?: string, by?: string}} args
 * @returns {Promise<object>} 子命令结果
 */
export async function captureCli(args = {}) {
  const { sub, file, scope, json = false, note, by, status } = args;
  const memoHome = resolveMemoHome(args.memoHome);
  const resolvedScope = resolveScopeOr(scope);

  if (sub === 'scan') {
    const text = await readInput(file);
    const candidates = extractCandidates(text);
    const queue = createCaptureQueue({ memoHome, scope: resolvedScope });
    const { added, skipped } = queue.add(candidates, { by });
    return emit(json,
      `扫描完成：候选 ${candidates.length}，入队 ${added.length}，跳过 ${skipped.length}\n`,
      { candidates, added, skipped });
  }

  if (sub === 'list') {
    const queue = createCaptureQueue({ memoHome, scope: resolvedScope });
    // --status 必须真的过滤（此前忽略该参数，`capture list --status pending` 会把已决策的也列出来）
    const rows = queue.list(status ? { status } : {});
    if (json) return emit(true, '', rows);
    process.stdout.write(`捕获队列（${resolvedScope}）：${rows.length} 条\n`);
    for (const r of rows) {
      process.stdout.write(
        `  [${r.status}] ${r.id}  (${r.kind}) ${clip(r.text)}  ${r.reason}\n`,
      );
    }
    return rows;
  }

  if (sub === 'accept') {
    const ids = await targetIds(args);
    const queue = createCaptureQueue({ memoHome, scope: resolvedScope });
    const service = await createMemoryService({ memoHome, scope: resolvedScope });
    try {
      const out = await queue.accept(ids, { service, by: by ?? 'capture' });
      return emit(json,
        `接受 ${out.accepted.length} 条，失败/跳过 ${out.rejected.length} 条\n`,
        out);
    } finally {
      await service.close();
    }
  }

  if (sub === 'reject') {
    const ids = await targetIds(args);
    const queue = createCaptureQueue({ memoHome, scope: resolvedScope });
    const out = queue.reject(ids, { note });
    return emit(json,
      `拒绝 ${out.rejected.length} 条，缺失 ${out.missing.length} 条\n`,
      out);
  }

  const err = new Error(`capture: unknown subcommand ${JSON.stringify(sub)}（可用 scan|list|accept|reject）`);
  err.code = 'E_INVALID_ARG';
  throw err;
}

/** accept/reject 目标：ids 数组或 --all（全部 pending） */
async function targetIds(args) {
  if (args.all) {
    const queue = createCaptureQueue({
      memoHome: resolveMemoHome(args.memoHome), scope: resolveScopeOr(args.scope),
    });
    return queue.list({ status: 'pending' }).map((r) => r.id);
  }
  const ids = (Array.isArray(args.ids) ? args.ids : []).map(String).filter((s) => s !== '');
  if (ids.length === 0) {
    const err = new Error('capture: --ids <id...> or --all is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  return ids;
}

/** 文本截断（人读表格用；不截 JSON 输出） */
function clip(text, max = 48) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
