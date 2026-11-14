// cli/import.js — `memo import` 导入器（W7）
// 用法：memo import <src> <path> [--apply] [--json] [--limit N]
//   src ∈ agents|basic-memory|obsidian|mem0|cline
// 默认 dry-run：只解析 + 按 kind 计数报告，不落盘；--apply 才经 service.write 写入
// （noop_same_value 天然幂等）；并追加 op=import 事件 {src, path, sha256}。
import process from 'node:process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UsageError, loadService, printJson, resolveMemoHome } from './commands/shared.js';
import { countByKind, parseCline, parseSource, fileSha256 } from './import-parsers.js';

const SRCS = new Set(['agents', 'basic-memory', 'obsidian', 'mem0', 'cline']);

/** 读入 src 对应的内容：cline 读目录下 6 个 md，其余读单文件 */
async function readInput(src, target) {
  if (src === 'cline') {
    const files = {};
    for (const name of ['projectbrief.md', 'productContext.md', 'activeContext.md', 'systemPatterns.md', 'techContext.md', 'progress.md']) {
      const p = path.join(target, name);
      try {
        files[name] = await fsp.readFile(p, 'utf8');
      } catch {
        // 缺文件不致命：只导入存在的部分
      }
    }
    return { kind: 'dir', files, raw: JSON.stringify(files) };
  }
  // 只读一次：先 stat 再 read 是 TOCTOU（CodeQL js/file-system-race），
  // 上限判断改成读完之后按长度检查（超限就报错，文件本身不会更大）。
  let raw;
  try {
    raw = await fsp.readFile(target, 'utf8');
  } catch {
    throw new UsageError(`导入源不是可读文件: ${target}`);
  }
  if (raw.length > 10 * 1024 * 1024) throw new UsageError(`导入文件超过 10MB 上限: ${target}`);
  return { kind: 'file', raw, files: null };
}

/**
 * cmdImport — 命令实现（memo.js 分发调用）。
 * @param {{apply?: boolean, limit?: string|boolean}} opts
 * @param {string[]} positional [src, path]
 * @param {boolean} asJson
 */
export async function cmdImport(opts, positional, asJson) {
  const [src, target] = positional;
  if (!src || !SRCS.has(src)) {
    throw new UsageError(`memo import: src 必须是 ${[...SRCS].join('|')} 之一，收到: ${src ?? '(缺)'}`);
  }
  if (!target) throw new UsageError('memo import: 缺少 <path> 参数');
  const limit = opts.limit === undefined || opts.limit === true || opts.limit === ''
    ? Infinity
    : Number(opts.limit);
  if (limit !== Infinity && (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit))) {
    throw new UsageError(`--limit 必须是正整数，收到: ${opts.limit}`);
  }

  const input = await readInput(src, target);
  const items = src === 'cline' ? parseCline(input.files) : parseSource(src, input.raw);
  const sliced = items.slice(0, limit);
  const result = { src, path: target, dryRun: !opts.apply, parsed: sliced.length, byKind: countByKind(sliced) };

  if (!opts.apply) {
    // dry-run：只报告，不落盘、不写事件
    if (asJson) printJson(result);
    else {
      process.stdout.write(`dry-run：解析 ${result.parsed} 条（${JSON.stringify(result.byKind)}），加 --apply 才写入\n`);
    }
    return result;
  }

  // --apply：逐条走既有 service.write（同 text 同 slot → noop_same_value，天然幂等）
  const service = await loadService();
  let written = 0;
  let skipped = 0;
  try {
    for (const item of sliced) {
      const r = await service.write({ ...item, value: item.text, source: { agent: 'import' } });
      if (r.action === 'noop_duplicate' || r.action === 'noop_same_value') skipped += 1;
      else written += 1;
    }
    // 导入事件：不进真相层记录，只进事件流（幂等核对用 sha256）
    await service._event('import', null, { src, path: target, sha256: fileSha256(input.raw) });
  } finally {
    await service.close();
  }
  result.written = written;
  result.skipped = skipped;
  result.memoHome = resolveMemoHome();
  if (asJson) printJson(result);
  else process.stdout.write(`已导入 ${written} 条（跳过重复 ${skipped} 条）→ ${resolveMemoHome()}\n`);
  return result;
}
