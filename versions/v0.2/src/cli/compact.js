#!/usr/bin/env node
// cli/compact.js — `memo compact`（车道 D，issue #35；契约 docs/02 §3.13 裁决 51）
// Lead 负责把本模块接进 src/cli/memo.js 的子命令分发；本文件不直接改 memo.js。
// 语义只有一处实现：判定与落盘全部走 api/maintenance.js 的 compact()，
// CLI 层只做参数解析（--dry-run / --grace / --json）与输出格式化。
// 用法: memo compact [--dry-run] [--grace 7d] [--json]
//   --grace 接受 "7d" / "12h" / "30m" 或纯毫秒数字；非法值抛 UsageError（E_USAGE）。
import process from 'node:process';

export class UsageError extends Error {
  constructor(msg) {
    super(msg);
    this.code = 'E_USAGE';
  }
}

/**
 * 解析 --grace 值为毫秒。为什么白名单 d/h/m：宽松解析（如 "1w"、"7 days"）
 * 会让同一个值在不同版本里悄悄换算错，宁可 fail-loud。
 * @param {string|number|undefined|boolean} value
 * @returns {number|undefined} 未传 → undefined（让 compact 回落 policy/7d 缺省链）
 */
export function parseGraceMs(value) {
  if (value === undefined || value === true || value === null) return undefined;
  const m = /^(\d+)(d|h|m)?$/.exec(String(value).trim());
  if (!m) {
    throw new UsageError(`--grace 需形如 7d / 12h / 30m 或纯毫秒数字，收到: ${JSON.stringify(value)}`);
  }
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd': return n * 86400000;
    case 'h': return n * 3600000;
    case 'm': return n * 60000;
    default: return n; // 纯数字 = 毫秒
  }
}

/**
 * compact 子命令入口（由 memo.js 分发调用，也可在测试里直接调）。
 * @param {import('../api/service.js').MemoryService} service 已打开的 service
 * @param {{dryRun?: boolean, 'dry-run'?: boolean, grace?: string, json?: boolean}} opts
 */
export async function compactCli(service, opts = {}) {
  const dryRun = opts.dryRun === true || opts['dry-run'] === true;
  const asJson = opts.json === true;
  // 未显式给 --grace 时不传 purgeGraceMs，让 maintenance 走 policy.quota.purgeGraceMs（契约裁决 51）
  const graceMs = opts.grace === undefined ? undefined : parseGraceMs(opts.grace);

  const { compact } = await import('../api/maintenance.js');
  const result = await compact(service, { dryRun, purgeGraceMs: graceMs });

  if (asJson) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(
      `compact scope=${service.scope}${dryRun ? ' (dry-run)' : ''}\n` +
        `  before=${result.before} after=${result.after} purged=${result.purged} kept=${result.kept}\n` +
        (result.backupPath ? `  backup: ${result.backupPath}\n` : '') +
        (dryRun ? '  （未写盘；真删请去掉 --dry-run）\n' : '')
    );
  }
  return result;
}

// —— 直接 `node src/cli/compact.js` 运行时的薄壳（与 nightly 同形）——
const USAGE = `compact —— memo 物理压实（只删 purge 墓碑 + 超宽限期，裁决 51）

用法: node src/cli/compact.js [--dry-run] [--grace 7d] [--json] [--scope repo:x]
环境: MEMO_HOME（默认 ~/.memo）`;

function parseArgv(argv) {
  const opts = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`无法识别的参数: ${a}\n${USAGE}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else opts[key] = true;
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const opts = parseArgv(argv);
  const { createMemoryService } = await import('../api/service.js');
  const path = await import('node:path');
  const os = await import('node:os');
  const service = await createMemoryService({
    memoHome: process.env.MEMO_HOME || path.join(os.homedir(), '.memo'),
    ...(opts.scope && opts.scope !== true ? { scope: opts.scope } : {}),
  });
  try {
    return await compactCli(service, opts) && 0;
  } finally {
    await service.close();
  }
}

// 只有作为脚本直接执行时才跑 main（被 memo.js import 时不执行）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`compact 失败 [${err.code ?? 'E_UNKNOWN'}]: ${err.message}\n`);
    process.exit(err.code === 'E_USAGE' ? 2 : 1);
  });
}
