// index/create-index.js — 索引后端构造点（契约：docs/09-sqlite-index.md §5）
// service.js 只调 createIndex({...})，IndexPort 的可插拔性验证点：注入只发生在这里。
// backend=memory（默认）与 v0.1.3 行为完全一致；sqlite 在 node:sqlite / FTS5
// 不可用时启动即抛 E_INDEX_UNAVAILABLE（不允许静默降级回 memory）。

import { createRequire } from 'node:module';
import { InvertedIndex } from './inverted-index.js';
import { SqliteIndex } from './sqlite-index.js';
import { createEmbedder } from './embedder.js';
import { createVectorIndex } from './vector-index.js';
import { createHybridIndex } from './hybrid-index.js';

const require = createRequire(import.meta.url);

/** 首次成功创建 sqlite 索引后提示一次实验特性（MEMO_QUIET=1 静默，测试用） */
let warnedExperimental = false;
function warnExperimentalOnce() {
  if (warnedExperimental || process.env.MEMO_QUIET) return;
  warnedExperimental = true;
  console.warn('[memo] index.backend=sqlite：node:sqlite 为实验特性（Node 22.5+，API 可能变化）');
}

function indexUnavailable(msg) {
  const err = new Error(msg);
  err.code = 'E_INDEX_UNAVAILABLE';
  return err;
}

/**
 * 按 policy.index.backend 构造索引。
 * @param {{policy?: object, memoHome?: string, scope?: string, clock?: object,
 *          sqliteModule?: object|null}} args（sqliteModule 供测试注入假模块）
 * @returns {InvertedIndex|SqliteIndex}
 */
export function createIndex({ policy, memoHome, scope = 'default', clock, sqliteModule } = {}) {
  const base = createLexicalIndex({ policy, memoHome, scope, clock, sqliteModule });
  const hybrid = maybeWrapHybrid(base, { policy, memoHome, scope, clock });
  return hybrid ?? base;
}

/**
 * 只构造词法索引（memory / sqlite）。语义道是外挂包装，不改变词法后端的语义。
 */
function createLexicalIndex({ policy, memoHome, scope, clock, sqliteModule }) {
  const backend = policy?.index?.backend ?? 'memory';
  if (backend === 'memory') return new InvertedIndex({ clock });
  if (backend !== 'sqlite') {
    const err = new Error(`createIndex: unknown index.backend ${JSON.stringify(backend)} (expected 'memory' | 'sqlite')`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }

  const mod = sqliteModule !== undefined ? sqliteModule : loadSqliteModule();
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    throw indexUnavailable(
      'createIndex: node:sqlite unavailable (upgrade Node >= 22.5, or set index.backend to "memory")',
    );
  }
  // FTS5 可用性探测（编译期可能被裁掉的组件，不能等第一次 search 才炸）
  try {
    const probe = new mod.DatabaseSync(':memory:');
    try {
      probe.exec('create virtual table probe_fts using fts5(x);');
    } finally {
      probe.close();
    }
  } catch (cause) {
    const err = indexUnavailable(
      `createIndex: FTS5 unavailable in this node:sqlite build (${cause.message}); upgrade Node or set index.backend to "memory"`,
    );
    err.cause = cause;
    throw err;
  }
  warnExperimentalOnce();
  return new SqliteIndex({ memoHome, scope, clock, sqlite: mod });
}

/**
 * 语义道包装（v0.4 D1）：policy.search.embedder.kind !== 'none' 时把词法索引
 * 包成双路索引；未配置时原样返回（返回 null 表示不包装，零成本）。
 * 向量文件落在 $MEMO_HOME/index/<scopeKey>.vectors.jsonl，删掉可用 backfill 重建。
 */
function maybeWrapHybrid(base, { policy, memoHome, scope, clock }) {
  const cfg = policy?.search?.embedder ?? { kind: 'none' };
  const kind = cfg.kind ?? 'none';
  if (kind === 'none') return null;
  if (!memoHome) {
    const err = new Error('createIndex: semantic lane requires memoHome (vector index path)');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const embedder = createEmbedder({ policy, memoHome });
  const dim = Number(cfg.dim ?? 0) > 0 ? Number(cfg.dim) : undefined;
  const vectorIndex = createVectorIndex({ memoHome, scope, dim, model: cfg.model });
  return createHybridIndex({
    base,
    embedder,
    vectorIndex,
    rrfK: policy?.search?.rrfK ?? 60,
    vectorTopK: policy?.search?.vectorTopK ?? 30,
    minScore: policy?.search?.minScore ?? 0.25,
    clock,
    onDegrade: (reason) => {
      if (!process.env.MEMO_QUIET) console.warn(`[memo] semantic lane degraded: ${reason}`);
    },
  });
}

/** 默认加载 node:sqlite；加载失败返回 null（由调用方统一抛 E_INDEX_UNAVAILABLE） */
function loadSqliteModule() {
  try { return require('node:sqlite'); } catch { return null; }
}
