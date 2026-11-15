// cli/backfill.js — `memo backfill-vectors [--scope] [--force] [--dry-run]`（D1）
// 批量补算语义向量：扫真相层（items/<scope>.jsonl，走 JsonlStore 的 fold 语义），
// 对 active 且无向量的记录调 embedder，写入 VectorIndex。
// dryRun 只统计不写盘；force 对已有向量的记录重算（rewrite 走 .bak 备份）。
// embedder 不可用（kind=none 或服务调不通）→ E_EMBED_UNAVAILABLE，不降级硬跑。

import process from 'node:process';
import os from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlStore } from '../storage/jsonl-store.js';
import { createVectorIndex } from '../index/vector-index.js';
import { createEmbedder } from '../index/embedder.js';
import { resolveScope } from '../core/scope.js';
import { scopeKeyOf } from '../config/paths.js';

/** 读 index/<scopeKey>.vectors.jsonl 的 id 集合（坏行/缺行容错跳过） */
export function knownVectorIds(memoHome, scope) {
  const file = join(memoHome, 'index', `${scopeKeyOf(scope)}.vectors.jsonl`);
  const ids = new Set();
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (row && typeof row.id === 'string') ids.add(row.id);
    } catch { /* 坏行跳过 */ }
  }
  return ids;
}

function unavailable(msg) {
  const err = new Error(msg);
  err.code = 'E_EMBED_UNAVAILABLE';
  return err;
}

/**
 * 批量补算向量。
 * @param {{memoHome: string, scope?: string, embedder: object,
 *          force?: boolean, dryRun?: boolean, batchSize?: number}} args
 * @returns {Promise<{scanned: number, embedded: number, skipped: number, failed: number}>}
 */
export async function backfillVectors({
  memoHome, scope = 'default', embedder, force = false, dryRun = false, batchSize = 64,
} = {}) {
  if (!memoHome) {
    const err = new Error('backfillVectors: memoHome is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (!embedder || typeof embedder.embed !== 'function') {
    throw unavailable('backfillVectors: embedder is required (got none)');
  }
  if (embedder.ready === false) {
    // kind=none 等：语义道关闭时 fail-loud，绝不静默跑出 embedded=0 假装成功
    throw unavailable(`backfillVectors: embedder not ready (${embedder.name})`);
  }

  const store = new JsonlStore({ memoHome });
  const records = await store.loadScope(scope);
  const vi = createVectorIndex({ memoHome, scope });
  const known = force ? new Set() : knownVectorIds(memoHome, scope);

  const stats = { scanned: records.length, embedded: 0, skipped: 0, failed: 0 };
  /** @type {Array<{id: string, text: string}>} 本批待嵌入 */
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const texts = batch.map((b) => b.text);
    let vecs;
    try {
      vecs = await embedder.embed(texts);
    } catch {
      // 整批失败不中断流程（服务端故障对本批所有条目同样成立，逐条重试无意义）
      stats.failed += batch.length;
      batch = [];
      return;
    }
    batch.forEach((b, i) => {
      const vec = vecs[i];
      if (!Array.isArray(vec) || vec.length === 0) {
        stats.failed++;
        return;
      }
      if (!dryRun) vi.add(b.id, vec);
      stats.embedded++;
    });
    batch = [];
  };

  for (const rec of records) {
    // 墓碑/superseded/purged 不补算；disputed 可补（它仍是待裁决的真相）
    if (rec.status && rec.status !== 'active') { stats.skipped++; continue; }
    // 已有向量且非 force → 跳过（按持久化文件的 id 判定，避免与查询维度耦合）
    if (known.has(rec.id)) { stats.skipped++; continue; }
    if (!rec.id || typeof rec.text !== 'string' || rec.text.trim() === '') {
      stats.skipped++;
      continue;
    }
    batch.push({ id: rec.id, text: rec.text });
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return stats;
}


/**
 * CLI 入口：`memo backfill-vectors [--scope s] [--force] [--dry-run] [--json]`
 * @param {string[]} argv 进程参数（不含 node/脚本名）
 * @param {{memoHome?: string, policy?: object, embedder?: object, stdout?: object}} [inject]
 *   测试注入点；缺省 memoHome=MEMO_HOME||~/.memo，embedder 由 policy 构造。
 * @returns {Promise<number>} 退出码（0 成功 / 2 用法错误 / 1 业务失败）
 */
export async function backfillCli(argv = [], inject = {}) {
  const opts = { scope: undefined, force: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--scope') opts.scope = argv[++i];
    else {
      process.stderr.write(`backfill-vectors: 未知参数 ${a}\n用法: memo backfill-vectors [--scope s] [--force] [--dry-run] [--json]\n`);
      return 2;
    }
  }
  const memoHome = inject.memoHome ?? process.env.MEMO_HOME ?? join(os.homedir(), '.memo');
  let embedder = inject.embedder;
  if (!embedder) {
    let policy = inject.policy;
    if (!policy) ({ defaultPolicy: policy } = await import('../config/policy.js'));
    embedder = createEmbedder({ policy, memoHome });
  }
  const scope = opts.scope ?? process.env.MEMO_SCOPE
    ?? resolveScope({ cwd: process.cwd(), env: process.env }).scope;
  let result;
  try {
    result = await backfillVectors({
      memoHome, scope, embedder, force: opts.force, dryRun: opts.dryRun,
    });
  } catch (err) {
    process.stderr.write(`backfill-vectors: ${err.code ?? 'ERROR'} ${err.message}\n`);
    return 1;
  }
  if (opts.json) process.stdout.write(JSON.stringify(result) + '\n');
  else {
    process.stdout.write(
      `backfill-vectors(${scope}): scanned=${result.scanned} embedded=${result.embedded}` +
      ` skipped=${result.skipped} failed=${result.failed}${opts.dryRun ? ' [dry-run]' : ''}\n`,
    );
  }
  return 0;
}
