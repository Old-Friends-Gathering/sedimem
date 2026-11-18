// cli/conflicts.js — `memo conflicts [--json] [--slot <slot>]` / `memo resolve --slot --winner [--note]`
// 入口层：只做参数解析、服务构建与输出投影，业务全部委托 views/conflicts.js（D4）。

import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { createMemoryService } from '../api/service.js';
import { listConflicts, resolveConflicts } from '../views/conflicts.js';

/** memoHome 解析：入参 > MEMO_HOME > ~/.memo（与 src/cli/memo.js 同口径） */
function resolveMemoHome(explicit) {
  return explicit || process.env.MEMO_HOME || path.join(os.homedir(), '.memo');
}

/** 构建并初始化服务；调用方负责 close */
async function makeService({ memoHome, scope } = {}) {
  return createMemoryService({ memoHome: resolveMemoHome(memoHome), scope });
}

/** 文本截断（人读表格用；不截 JSON 输出） */
function clip(text, max = 48) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** slot 键（含 \u0001 分隔符）转成人可读形式 */
function prettySlot(key) {
  return String(key).replace('\u0001', ' / ');
}

/**
 * `memo conflicts`：列出分歧 slot。
 * @param {{memoHome?: string, scope?: string, json?: boolean, slot?: string}} args
 * @returns {Promise<object>} listConflicts 的返回（--json 时已原样打印）
 */
export async function conflictsCli(args = {}) {
  const { json = false, slot } = args;
  const service = await makeService(args);
  try {
    const out = await listConflicts({ service });
    const filtered = slot !== undefined && slot !== null && slot !== ''
      ? { ...out, slots: out.slots.filter((s) => s.key === slot) }
      : out;
    if (json) {
      process.stdout.write(`${JSON.stringify(filtered)}\n`);
      return filtered;
    }
    process.stdout.write(
      `分歧 slot: ${filtered.slots.length}（disputed ${filtered.disputedCount}，`
      + `superseded ${filtered.supersededCount}，扫描 ${filtered.scanned} 条）\n`,
    );
    for (const s of filtered.slots) {
      process.stdout.write(`\n[${prettySlot(s.key)}] disputed=${s.disputedCount}\n`);
      for (const r of s.records) {
        process.stdout.write(
          `  ${r.status.padEnd(9)} ${r.id}  ${clip(r.text)}  (validFrom=${r.validFrom ?? '-'}, hits=${r.hits})\n`,
        );
      }
      for (const p of s.pairs) {
        process.stdout.write(
          `  pair ${p.aId} <-> ${p.bId} similarity=${p.similarity}\n`,
        );
      }
      process.stdout.write(`  修复: memo resolve --slot ${JSON.stringify(s.key)} --winner <id>\n`);
    }
    if (filtered.slots.length === 0) process.stdout.write('当前没有分歧 slot\n');
    return filtered;
  } finally {
    await service.close();
  }
}

/**
 * `memo resolve`：把同 slot 其它记录逐个 supersede（a_wins 语义，非破坏、幂等）。
 * @param {{memoHome?: string, scope?: string, json?: boolean,
 *          slot?: string, winner?: string, note?: string}} args
 * @returns {Promise<{resolved: {id: string}[], skipped: {id: string, reason: string}[]}>}
 */
export async function resolveCli(args = {}) {
  const { json = false, slot, winner, note } = args;
  if (typeof slot !== 'string' || slot.length === 0) {
    const err = new Error('resolve: --slot <slot> is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (typeof winner !== 'string' || winner.length === 0) {
    const err = new Error('resolve: --winner <recordId> is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const service = await makeService(args);
  try {
    const out = await resolveConflicts({ service, slot, winnerId: winner, note });
    if (json) {
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return out;
    }
    process.stdout.write(`已解决 ${out.resolved.length} 条，跳过 ${out.skipped.length} 条\n`);
    for (const r of out.resolved) process.stdout.write(`  superseded: ${r.id}\n`);
    for (const r of out.skipped) process.stdout.write(`  skipped: ${r.id}（${r.reason}）\n`);
    return out;
  } finally {
    await service.close();
  }
}
