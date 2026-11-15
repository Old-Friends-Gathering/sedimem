/**
 * memo CLI 共享工具（从 src/cli/memo.js 原样搬出，行为零变化）。
 * 契约：docs/02-data-model-and-contract.md §3 `src/cli/memo.js`
 * 退出码：0 成功 / 1 业务失败 / 2 用法错误
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { AGENT_PATTERN, RESERVED_AGENTS } from '../../core/record.js';

export function resolveMemoHome() {
  return process.env.MEMO_HOME || path.join(os.homedir(), '.memo');
}

export class UsageError extends Error {
  constructor(msg) {
    super(msg);
    this.code = 'E_USAGE';
  }
}

/** 解析 `--flag value` / `--flag` / 位置参数。重复 flag 取最后一个布尔语义的简单实现。 */
export function parseArgs(argv) {
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

export function requireOpt(opts, name, usage) {
  const v = opts[name];
  if (v === undefined || v === true || v === '') throw new UsageError(`缺少 --${name}\n${usage}`);
  return String(v);
}

/**
 * 0.6.2：命令行的 --scope 必须真的生效。
 *
 * 之前所有命令都只按 cwd/env 解析 scope，`memo write --scope session:...` 会被静默写进 cwd 的分库
 * （实测：session 库的写入落到了主库，且 session 禁 fact 的门禁因此被绕过）。这里统一把字符串型
 * --scope 透传给 createMemoryService，与 MEMO_SCOPE 同等优先级。
 */
/** 当前进程解析出的 CLI 选项（main() 里赋值），供 loadService 读取 --scope。 */
let CURRENT_OPTS = {};

export function setCurrentOpts(opts) {
  CURRENT_OPTS = opts;
}

export function serviceOpts() {
  const scope = CURRENT_OPTS?.scope;
  return typeof scope === 'string' && scope.length > 0 ? { scope } : {};
}

export async function loadService(extra = {}) {
  let mod;
  try {
    mod = await import('../../api/service.js');
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

export function printJson(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

export function printRecord(r) {
  // 有 title 就先打 title（裁决 59）：它是「人扫一眼认得出是哪条」的那句话
  const head = typeof r.title === 'string' && r.title !== '' ? `  「${r.title}」\n` : '';
  process.stdout.write(
    `${r.id}  [${r.kind}] ${r.status}\n${head}  ${r.text}\n  ${r.subject}.${r.predicate} = ${r.value}  (from ${r.validFrom}${r.validTo ? ` to ${r.validTo}` : ''}, conf ${r.confidence}, agent ${r.source.agent})\n`
  );
}

// 裁决 25：source.agent 是自由标签（不再枚举），校验规则与 core/record.js 保持同一份
export function parseAgent(opts, fallback = 'cli') {
  const agent = opts.agent === true || opts.agent === undefined ? fallback : String(opts.agent);
  if (!AGENT_PATTERN.test(agent) || RESERVED_AGENTS.has(agent)) {
    throw new UsageError(
      `--agent 必须匹配 ${AGENT_PATTERN}，且不能用保留名（${[...RESERVED_AGENTS].join('|')}），收到: ${agent}`,
    );
  }
  return agent;
}

export function parseNumber(opts, name) {
  if (opts[name] === undefined || opts[name] === true) return undefined;
  const n = Number(opts[name]);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} 不是数字: ${opts[name]}`);
  return n;
}
