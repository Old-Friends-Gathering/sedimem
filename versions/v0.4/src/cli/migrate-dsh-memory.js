#!/usr/bin/env node
/**
 * migrate-dsh-memory —— 把 $DSH_HOME/memory/memory.db 的 memories 表迁移成 items/default.jsonl。
 * 入口层：读 SQLite（node:sqlite）、构造 MemoryRecord、全部写入走 MemoryService.write。
 * 读不到库/表/列 → fail-loud（抛 Error 且 err.code）。
 *
 * 用法:
 *   node src/cli/migrate-dsh-memory.js [--db path] [--scope dir:dsh-memory] [--dry-run] [--json]
 * 也作为模块被 memo.js 复用: migrateDshMemory({ dbPath, scope, dryRun })
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const USAGE = `migrate-dsh-memory —— 把 DSH 旧记忆库 (SQLite) 迁移到 memo 真相层

用法:
  node src/cli/migrate-dsh-memory.js [--db /path/to/memory.db] [--scope dir:migrated-dsh] [--agent dsh] [--dry-run] [--json]

默认 --db 取 $DSH_HOME/memory/memory.db（DSH_HOME 默认 ~/.dsh）。`;

class UsageError extends Error {
  constructor(msg) {
    super(msg);
    this.code = 'E_USAGE';
  }
}

function failLoud(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

/** 探测 memories 表实际存在的列名，返回 Set */
function detectColumns(db) {
  let cols;
  try {
    cols = db.prepare('PRAGMA table_info(memories)').all();
  } catch (err) {
    failLoud('E_SQLITE', `PRAGMA table_info(memories) 失败: ${err.message}`);
  }
  if (!Array.isArray(cols) || cols.length === 0) {
    failLoud(
      'E_TABLE_NOT_FOUND',
      `数据库中不存在 memories 表（PRAGMA table_info(memories) 为空）。` +
        `请确认 --db 指向的是 DSH 旧记忆库（含 memories 表的 SQLite 文件）。`
    );
  }
  return new Set(cols.map((c) => c.name));
}

function pickRow(row, columns, candidates) {
  for (const name of candidates) {
    if (columns.has(name) && row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') {
      return String(row[name]);
    }
  }
  return undefined;
}

export async function migrateDshMemory({ dbPath, scope, agent = 'dsh', dryRun = false, asJson = false } = {}) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const resolvedDb = dbPath || path.join(dshHome, 'memory', 'memory.db');

  if (!fs.existsSync(resolvedDb)) {
    failLoud(
      'E_DB_NOT_FOUND',
      `找不到 DSH 记忆库: ${resolvedDb}\n` +
        `请确认 DSH_HOME（当前 ${dshHome}）或用 --db 显式指定 memory.db 路径。`
    );
  }

  let db;
  try {
    db = new DatabaseSync(resolvedDb, { readOnly: true });
  } catch (err) {
    failLoud('E_SQLITE_OPEN', `无法打开数据库 ${resolvedDb}: ${err.message}`);
  }

  let rows;
  const columns = detectColumns(db);
  try {
    rows = db.prepare('SELECT * FROM memories').all();
  } catch (err) {
    failLoud('E_SQLITE_READ', `SELECT * FROM memories 失败: ${err.message}`);
  } finally {
    db.close();
  }

  // 列名探测：不同版本 dsh-memory 列名不同，按候选优先级取。
  const summaries = [];
  for (const row of rows) {
    const text =
      pickRow(row, columns, ['content', 'memory', 'text', 'summary', 'value']) ?? '';
    const subject = pickRow(row, columns, ['subject', 'entity', 'key', 'topic']) ?? 'dsh-memory';
    const predicate = pickRow(row, columns, ['predicate', 'attribute', 'field']) ?? 'text';
    const value = pickRow(row, columns, ['value', 'content', 'memory', 'text']) ?? text;
    const kindRaw = pickRow(row, columns, ['kind', 'type', 'category']);
    const tagsRaw = pickRow(row, columns, ['tags']);
    const createdAt = pickRow(row, columns, ['created_at', 'createdAt', 'ts', 'timestamp']);
    if (!text) continue; // 空行跳过，不构成迁移失败
    summaries.push({
      text,
      subject,
      predicate,
      value,
      kind: normalizeKind(kindRaw),
      tags: [
        'migrated:dsh-memory',
        ...(tagsRaw ? String(tagsRaw).split(/[,;]/).map((t) => t.trim()).filter(Boolean) : []),
      ],
      createdAt,
    });
  }

  let service = null;
  let writeResults = [];
  if (!dryRun) {
    let mod;
    try {
      mod = await import('../api/service.js');
    } catch (err) {
      failLoud(
        'E_MISSING_SERVICE',
        `无法加载 MemoryService (src/api/service.js)：${err.message}。迁移写盘依赖该模块，请待其就绪后重试。`
      );
    }
    const scopeOpts = scope ? { scope } : {};
    service = await mod.createMemoryService({ memoHome: process.env.MEMO_HOME || path.join(os.homedir(), '.memo'), ...scopeOpts });
    try {
      for (const s of summaries) {
        const result = await service.write({
          text: s.text,
          kind: s.kind,
          subject: s.subject,
          predicate: s.predicate,
          value: s.value,
          tags: s.tags,
          source: { agent },
        });
        writeResults.push({ action: result.action, id: result.record.id });
      }
    } finally {
      await service.close();
    }
  }

  const report = {
    db: resolvedDb,
    rowsTotal: rows.length,
    rowsMigrated: summaries.length,
    dryRun,
    writes: writeResults,
  };
  if (asJson) process.stdout.write(JSON.stringify(report) + '\n');
  else
    process.stdout.write(
      `迁移完成: 读取 ${rows.length} 行，写入 ${summaries.length} 条` +
        `${dryRun ? '（dry-run，未写盘）' : ''}\n` +
        writeResults.reduce((acc, w) => acc + `  ${w.action}: ${w.id}\n`, '')
    );
  return report;
}

const KINDS = new Set(['fact', 'pref', 'decision', 'gotcha', 'state']);
function normalizeKind(raw) {
  if (!raw) return 'fact';
  const lower = String(raw).toLowerCase();
  if (KINDS.has(lower)) return lower;
  if (lower.includes('prefer')) return 'pref';
  if (lower.includes('decis')) return 'decision';
  if (lower.includes('gotcha') || lower.includes('pitfall') || lower.includes('lesson')) return 'gotcha';
  if (lower.includes('state') || lower.includes('status')) return 'state';
  return 'fact';
}

/** CLI 直跑入口 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const opts = Object.create(null);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    } else positional.push(a);
  }
  if (opts.db === true) throw new UsageError('--db 需要一个路径');
  return (
    (
      await migrateDshMemory({
        dbPath: opts.db,
        scope: opts.scope === true ? undefined : opts.scope,
        agent: opts.agent === true ? 'dsh' : opts.agent,
        dryRun: Boolean(opts['dry-run']),
        asJson: Boolean(opts.json),
      })
    ),
    0
  );
}

// 仅作为脚本直跑时执行 main；被 memo.js import 时不执行。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    process.stderr.write(`migrate-dsh-memory 失败 [${err.code ?? 'E_UNKNOWN'}]: ${err.message}\n`);
    process.exit(1);
  });
}
