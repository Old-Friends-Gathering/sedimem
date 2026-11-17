// llm/budget.js — LLM 日预算（契约：docs/plans/v1.0.0-refactor.md §2.1，审核 C2 修复：落盘跨进程共享）
//
// $MEMO_HOME/llm/budget.json 形状 { date:'YYYY-MM-DD', spentCny, calls, byPurpose:{purpose:{inTokens,outTokens,calls}} }。
// 跨日自动重置；并发走 llm/budget.lock 目录锁；写文件 tmp + rename 原子替换。

import path from 'node:path';
import fsp from 'node:fs/promises';
import { withPathLock, atomicWriteFile } from './lock.js';

/** 默认时钟：返回 Date（跨日判定按 ISO 日期字符串，UTC 口径，clock 可注入） */
const defaultClock = () => new Date();

/** budget.json 路径与 llm 目录 */
function budgetPaths(memoHome) {
  const dir = path.join(memoHome, 'llm');
  return { dir, file: path.join(dir, 'budget.json'), lock: 'budget.lock' };
}

/** ISO 日期（YYYY-MM-DD） */
function dateKey(clock) {
  return (clock || defaultClock)().toISOString().slice(0, 10);
}

/** 空预算 */
function emptyBudget(date) {
  return { date, spentCny: 0, calls: 0, byPurpose: {} };
}

/**
 * 读取当前预算（跨日自动重置：读到旧日期按空预算处理，不主动回写，写路径会落新日期）。
 * @param {string} memoHome
 * @param {{clock?: () => Date}} [opts]
 */
export async function readBudget(memoHome, opts = {}) {
  const { file } = budgetPaths(memoHome);
  const today = dateKey(opts.clock);
  let data = null;
  try {
    data = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch { data = null; } // 不存在 / 坏行：视为空预算
  if (!data || typeof data !== 'object' || data.date !== today) return emptyBudget(today);
  return {
    date: data.date,
    spentCny: typeof data.spentCny === 'number' ? data.spentCny : 0,
    calls: typeof data.calls === 'number' ? data.calls : 0,
    byPurpose: data.byPurpose && typeof data.byPurpose === 'object' ? data.byPurpose : {},
  };
}

/** 是否已超日限额（spentCny >= dailyLimitCny 即 blocked；limit<=0 视为未启用） */
export async function isBlocked(memoHome, opts = {}) {
  const llm = opts.policy && opts.policy.llm;
  const limit = llm && typeof llm.dailyLimitCny === 'number' ? llm.dailyLimitCny : Infinity;
  if (!(limit > 0)) return false;
  const budget = await readBudget(memoHome, opts);
  return budget.spentCny >= limit;
}

/**
 * 记账一次。超限不写入并返回 blocked；成功时在锁内追加 usage 换算的 CNY 并落盘。
 * @param {string} memoHome
 * @param {object} args
 * @param {{inTokens:number, outTokens:number}} args.usage  本次调用的 token 用量
 * @param {string} [args.purpose]  用途（用于 byPurpose 细分）
 * @param {{policy: object}} args  policy.llm.price {inPerM,outPerM}（每百万 token 单价）、dailyLimitCny
 * @param {{clock?: () => Date}} [opts]
 * @returns {Promise<{ok:true, spentCny:number}
 *                   |{ok:false, blocked:true, error:{code:string, message:string}}>}
 */
export async function chargeBudget(memoHome, { usage, purpose, policy } = {}, opts = {}) {
  const { dir, file, lock } = budgetPaths(memoHome);
  const llm = policy && policy.llm;
  const price = llm && llm.price ? llm.price : { inPerM: 0, outPerM: 0 };
  const limit = llm && typeof llm.dailyLimitCny === 'number' ? llm.dailyLimitCny : Infinity;
  const u = usage && typeof usage === 'object' ? usage : {};
  const inTokens = typeof u.inTokens === 'number' ? u.inTokens : 0;
  const outTokens = typeof u.outTokens === 'number' ? u.outTokens : 0;

  return withPathLock(dir, lock, async () => {
    const today = dateKey(opts.clock);
    const current = await readBudget(memoHome, { clock: opts.clock });
    // 按 usage 与单价换算 CNY，保留 4 位小数
    const cost = Math.round((inTokens / 1e6) * (price.inPerM || 0) * 1e4
      + (outTokens / 1e6) * (price.outPerM || 0) * 1e4) / 1e4;

    if (limit > 0 && current.spentCny + cost > limit) {
      return { ok: false, blocked: true, error: { code: 'E_LLM_BUDGET_EXCEEDED', message: `daily budget exceeded: spent ${current.spentCny} + cost ${cost} > limit ${limit}` } };
    }

    const next = {
      date: today,
      spentCny: Math.round((current.spentCny + cost) * 1e4) / 1e4,
      calls: current.calls + 1,
      byPurpose: { ...current.byPurpose },
    };
    const p = purpose || 'unknown';
    const prev = next.byPurpose[p] || { inTokens: 0, outTokens: 0, calls: 0 };
    next.byPurpose[p] = {
      inTokens: prev.inTokens + inTokens,
      outTokens: prev.outTokens + outTokens,
      calls: prev.calls + 1,
    };
    await atomicWriteFile(file, JSON.stringify(next) + '\n');
    return { ok: true, spentCny: next.spentCny };
  });
}
