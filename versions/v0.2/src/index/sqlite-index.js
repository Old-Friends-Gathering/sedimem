// index/sqlite-index.js — SQLite FTS5 索引（实现 IndexPort，契约：docs/09-sqlite-index.md）
// 与 InvertedIndex 同一套接口语义：score>0 才返回、score 降序、同分按 id 升序、
// filter 在打分后过滤、limit undefined 不截断、add 无 id 抛 E_INVALID_RECORD。
// 关键对齐点：写入侧把记录先过 tokenize()（与内存索引同一个，core/hash.js），
// 把 token 流写入 FTS 列；查询侧 buildMatchExpr 也用同一 tokenize() 的输出。
// 这样两侧的词元完全一致，避免 unicode61 对中文切词方式不同导致的语义漂移。

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { tokenize } from '../core/hash.js';
import { scopeKeyOf } from '../config/paths.js';

const require = createRequire(import.meta.url);

/**
 * 构造 FTS5 MATCH 表达式（纯函数，docs/09 §4.2）：
 * tokenize() 切词 → 每个 token 包成 "..." 字面量（内部 " 双写）→ OR 连接。
 * token 数 0 → null（调用方直接返回 []）。不用 AND：内存实现是命中任一词即累加。
 * @param {string} query
 * @returns {string|null}
 */
/** 单查询最多纳入的 token 数（SQLite FTS5 对超长 OR 表达式是线性放大，实测 50k 词项 848ms） */
export const MAX_QUERY_TOKENS = 256;

export function buildMatchExpr(query) {
  const tokens = tokenize(String(query ?? '')).slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** 把任意字段转成 token 流字符串（写入 FTS 列；与内存索引的 _docTerms 同源） */
function tokenized(s) {
  return tokenize(String(s ?? '')).join(' ');
}

function invalidRecord(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_RECORD';
  return err;
}

export class SqliteIndex {
  /**
   * @param {{memoHome?: string, scope?: string, clock?: object,
   *          sqlite?: {DatabaseSync: function}} } opts
   * sqlite 模块可注入（测试用）；缺省从 node:sqlite 加载，加载失败抛 E_INDEX_UNAVAILABLE。
   */
  constructor({ memoHome, scope = 'default', clock, sqlite } = {}) {
    if (!memoHome || typeof memoHome !== 'string') {
      const err = new Error('SqliteIndex: memoHome (non-empty string) is required');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const mod = sqlite ?? SqliteIndex.loadSqlite();
    if (!mod || typeof mod.DatabaseSync !== 'function') {
      const err = new Error('SqliteIndex: node:sqlite is not available in this Node build (upgrade Node >= 22.5 or switch index.backend to memory)');
      err.code = 'E_INDEX_UNAVAILABLE';
      throw err;
    }
    this.clock = clock ?? null;
    this._sqlite = mod;
    this._records = new Map();
    this._built = false; // 是否已通过 build() 装载过：用来区分「合法空索引」与「绕过 build 的陈旧索引」
    this._dir = join(memoHome, 'index');
    mkdirSync(this._dir, { recursive: true });
    this._path = join(this._dir, `${scopeKeyOf(scope)}.sqlite`);
    this._open();
    this._ensureConsistent();
  }

  /** 单文件库路径（诊断/测试用；docs/09 §3） */
  get dbPath() { return this._path; }

  static loadSqlite() {
    try { return require('node:sqlite'); } catch { return null; }
  }

  _open() {
    this.db = new this._sqlite.DatabaseSync(this._path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      create table if not exists docs (
        id text primary key,
        text text not null,
        subject text, predicate text, value text,
        kind text, status text, created_at text
      );
      create virtual table if not exists docs_fts using fts5(
        text, subject, predicate, value,
        content='docs', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      create trigger if not exists docs_ai after insert on docs begin
        insert into docs_fts(rowid, text, subject, predicate, value)
        values (new.rowid, new.text, new.subject, new.predicate, new.value);
      end;
      create trigger if not exists docs_ad after delete on docs begin
        insert into docs_fts(docs_fts, rowid, text, subject, predicate, value)
        values ('delete', old.rowid, old.text, old.subject, old.predicate, old.value);
      end;
      create trigger if not exists docs_au after update on docs begin
        insert into docs_fts(docs_fts, rowid, text, subject, predicate, value)
        values ('delete', old.rowid, old.text, old.subject, old.predicate, old.value);
        insert into docs_fts(rowid, text, subject, predicate, value)
        values (new.rowid, new.text, new.subject, new.predicate, new.value);
      end;
    `);
  }

  /** docs 与 fts 行数一致；SQLITE_CORRUPT / 行数不符 → 删库重建（docs/09 §6，索引是派生层） */
  _ensureConsistent() {
    let bad = null;
    try {
      const d = this.db.prepare('select count(*) as n from docs').get().n;
      // external content 表的 count(*) 读的就是 docs 表，与 docs 恒等 → 不能拿它验同步（审核 S2）。
      // 真正能验的是 FTS 内部索引块：docs_fts_data 里有行而 docs 空、或反过来，才是漂移。
      const seg = this.db.prepare("select count(*) as n from docs_fts_data").get().n;
      if (d === 0 && seg > 1) bad = new Error(`SqliteIndex: fts segment has data but docs is empty (seg=${seg})`);
      // 内存副本与 docs 表条数不一致（例如外部进程改过表）→ 也要重建
      if (this._built && this._records.size !== d) {
        bad = new Error(`SqliteIndex: stale in-memory view (${this._records.size}) vs docs (${d})`);
      }
      this.db.prepare("insert into docs_fts(docs_fts) values('integrity-check')").run();
    } catch (e) {
      // integrity-check 抛错即索引损坏（比行数比对强得多）
      bad = e;
    }
    if (!bad) return;
    // 删库重建：索引不含真相，删掉只会让下次启动变慢（docs/09 §3）
    try { this.db.close(); } catch { /* 已损坏的句柄 close 失败可忽略：文件马上被删除 */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(this._path + suffix, { force: true }); } catch { /* 尽力而为；重建前清场 */ }
    }
    this._records.clear();
    this._open();
    if (!process.env.MEMO_QUIET) {
      process.emitWarning(
        `SqliteIndex: index file was corrupt (${bad.message}); rebuilt empty at ${this._path}. Run reindex to repopulate.`,
        'IndexRebuilt',
      );
    }
  }

  _inTx(fn) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const out = fn();
      this.db.exec('COMMIT;');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  _insert(record) {
    this.db.prepare(
      `insert into docs (id, text, subject, predicate, value, kind, status, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      tokenized(record.text),
      tokenized(record.subject),
      tokenized(record.predicate),
      tokenized(record.value),
      String(record.kind ?? ''),
      String(record.status ?? ''),
      String(record.createdAt ?? ''),
    );
  }

  /** 全量重建 */
  build(records) {
    const list = Array.isArray(records) ? records : [];
    this._inTx(() => {
      this.db.exec('delete from docs;');
      for (const r of list) {
        // build 也走 add 的校验语义：无 id fail-loud，不静默丢
        if (!r || typeof r.id !== 'string') {
          throw invalidRecord('SqliteIndex.build: record with string id required');
        }
        this._insert(r);
      }
    });
    this._records = new Map(list.map((r) => [r.id, r]));
    this._built = true; // 用于区分「合法空索引」与「绕过 build 的陈旧索引」
    return this;
  }

  /** 幂等：同 id 覆盖 */
  add(record) {
    if (!record || typeof record.id !== 'string') {
      throw invalidRecord('SqliteIndex.add: record with string id required');
    }
    this._inTx(() => {
      this.db.prepare('delete from docs where id = ?').run(record.id);
      this._insert(record);
    });
    this._records.set(record.id, record);
    return this;
  }

  remove(id) {
    if (!this._records.has(id)) return this;
    this._inTx(() => { this.db.prepare('delete from docs where id = ?').run(id); });
    this._records.delete(id);
    return this;
  }

  /**
   * BM25 检索（docs/09 §4）：FTS5 bm25() 是负数，score = -rank 转正；
   * 先打分后 filter；filter 存在且 limit 为数字时 SQL 窗口放大到 max(limit, 200)，
   * 过滤后不足再回查一次（窗口 ×10），避免过滤后假阴性。
   * @param {string} query
   * @param {{limit?: number, filter?: (record) => boolean}} opts
   * @returns {{id: string, score: number}[]}
   */
  search(query, opts = {}) {
    // 默认 limit=10，必须与 InvertedIndex 完全一致（审核 S1：两后端默认行为相反会让端口承诺失效）。
    // 不能用解构默认值写法去「显式 undefined 不截断」——内存实现从来没有这个语义，
    // 想不截断就显式传 Infinity 或 limit: index.size。
    const filter = opts.filter;
    const limit = opts.limit === undefined ? 10 : opts.limit;
    const expr = buildMatchExpr(query);
    if (expr === null) return [];
    if (this._records.size === 0) {
      // docs 表有数据但内存副本空 = 有人绕过 build 直接用（重启后未 build 的旧行为：
      // 会静默返回空结果，比报错危险得多）。fail-loud，提示 reindex。
      const rows = this.db.prepare('select count(*) as n from docs').get().n;
      if (rows > 0) {
        const err = new Error(
          `SqliteIndex: index has ${rows} rows but service view is empty — call build(records) or memo reindex`,
        );
        err.code = 'E_INDEX_STALE';
        throw err;
      }
      return [];
    }

    // limit undefined → 不截断：SQL 用 -1（SQLite 负 limit = 无限制）
    let sqlLimit = filter && typeof limit === 'number'
      ? Math.max(limit, 200)
      : (typeof limit === 'number' ? limit : -1);

    const rows = this._scoredRows(expr, sqlLimit);
    let out = this._filterAndPositivize(rows, filter);
    if (filter && typeof limit === 'number' && out.length < limit && rows.length === sqlLimit) {
      // 回查一次：第一窗口被 filter 吃掉太多时放大 10 倍
      const rows2 = this._scoredRows(expr, sqlLimit * 10);
      out = this._filterAndPositivize(rows2, filter);
    }
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return typeof limit === 'number' ? out.slice(0, Math.max(0, limit)) : out;
  }

  /** 取打分行（rank 升序 = 最负最相关；同分按 id 升序，与内存实现一致） */
  _scoredRows(expr, sqlLimit) {
    return this.db.prepare(
      `select docs.id as id, bm25(docs_fts) as rank
         from docs_fts join docs on docs.rowid = docs_fts.rowid
        where docs_fts match ?
        order by rank asc, docs.id asc
        limit ?`,
    ).all(expr, sqlLimit);
  }

  /** 打分后过滤（契约：filter 收到完整记录），并把负 rank 转正、挡住 0 分边界 */
  _filterAndPositivize(rows, filter) {
    const out = [];
    for (const row of rows) {
      const score = -Number(row.rank);
      if (!(score > 0)) continue; // 挡住 rank === 0 / NaN 边界
      const record = this._records.get(row.id);
      if (!record) continue; // docs 与内存 Map 失同步（不应发生）：保守跳过
      if (filter && !filter(record)) continue;
      out.push({ id: row.id, score });
    }
    return out;
  }

  /** 当前索引的文档数（诊断用） */
  get size() { return this._records.size; }

  close() {
    try { this.db.close(); } catch { /* 幂等 close：已关/损坏句柄不阻塞退出 */ }
  }
}
