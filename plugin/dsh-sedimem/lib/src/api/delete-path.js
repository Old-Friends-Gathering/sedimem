// api/delete-path.js — 按来源删除 + 删除验证（P0b B3 / docs/02 §3.24、I-12）
//
// 两条不变式：
//  1. 真相层 append-only：删除只追加墓碑（status='tombstoned'），绝不物理删 items 行。
//  2. 派生物必须跟着消失：索引/向量/brief/任务账本都不能再出现被删内容，否则
//     `memo verify-delete` 会把它当残留报出来（这正是本模块存在的意义）。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { withPatch, validateRecord } from '../core/record.js';
import { withLock } from '../storage/lock.js';
import { invalidArg } from '../core/errors.js';
import {
  scopeKeyOf, briefFileName, scopeFromItemsFileName, itemsFileName,
} from '../config/paths.js';

const TOMBSTONE_TAG = 'source-deleted';
const require = createRequire(import.meta.url);

/** 加载 node:sqlite（可选；索引后端为 sqlite 时必然可用）。 */
function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

/**
 * 在 sqlite 索引里按主键查残留。**不能**对 .sqlite 做字节扫描：DELETE 后 id 仍可能
 * 停在 freelist/WAL 页里，字节命中不等于索引还能查到它（实测 80 条删除全部误报）。
 * 查不到 docs 行才算删除干净；索引文件存在但 node:sqlite 不可用时 fail-closed。
 */
function sqliteResidue(file, ids) {
  const mod = loadSqlite();
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    return { unavailable: true, ids: [] };
  }
  const found = new Set();
  let db;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
    const hasDocs = db.prepare("select name from sqlite_master where type='table' and name='docs'").get();
    if (hasDocs) {
      const all = [...ids];
      for (let i = 0; i < all.length; i += 400) {
        const chunk = all.slice(i, i + 400);
        const marks = chunk.map(() => '?').join(',');
        for (const row of db.prepare(`select id from docs where id in (${marks})`).all(...chunk)) {
          found.add(row.id);
        }
      }
    }
  } catch {
    // 打不开/结构不认识时不能当作「已删除」：交给调用方报 fail-closed 残留。
    return { unavailable: true, ids: [] };
  } finally {
    try {
      db?.close();
    } catch { /* ignore */ }
  }
  return { unavailable: false, ids: [...found] };
}

/** 列出 memoHome 下所有真实分库（items/*.jsonl → scope）。 */
async function listScopes(memoHome) {
  let names = [];
  try {
    names = await fsp.readdir(path.join(memoHome, 'items'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => scopeFromItemsFileName(name))
    .filter((scope) => typeof scope === 'string' && scope !== '');
}

/** 读一个分库的全部行，按 id fold 出最新快照。 */
async function latestByScope(svc, scope) {
  const rows = await svc.store.loadScope(scope);
  const latest = new Map();
  for (const r of rows) latest.set(r.id, r);
  return [...latest.values()];
}

function selectorsOf({ agent, session, contentHash } = {}) {
  const sel = {};
  if (agent !== undefined) {
    if (typeof agent !== 'string' || agent.trim() === '') throw invalidArg('delete: --source-agent must be a non-empty string');
    sel.agent = agent.trim();
  }
  if (session !== undefined) {
    if (typeof session !== 'string' || session.trim() === '') throw invalidArg('delete: --source-session must be a non-empty string');
    sel.session = session.trim();
  }
  if (contentHash !== undefined) {
    if (typeof contentHash !== 'string' || contentHash.trim() === '') throw invalidArg('delete: --content-hash must be a non-empty string');
    sel.contentHash = contentHash.trim();
  }
  if (Object.keys(sel).length === 0) {
    throw invalidArg('delete: at least one of --source-agent / --source-session / --content-hash is required');
  }
  return sel;
}

function matches(r, sel) {
  if (sel.agent !== undefined && r.source?.agent !== sel.agent) return false;
  if (sel.session !== undefined && r.source?.session !== sel.session) return false;
  if (sel.contentHash !== undefined && r.contentHash !== sel.contentHash) return false;
  return true;
}

/** 任务账本目录（sessions/<taskId>/）与 meta（sessions/<taskId>.json）。 */
async function taskLedgerDirs(memoHome) {
  let names = [];
  try {
    names = await fsp.readdir(path.join(memoHome, 'sessions'), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names.filter((d) => d.isDirectory()).map((d) => d.name);
}

/**
 * 找出与选择器匹配的任务账本（只读）。taskId 是目录名；段里的 source.session /
 * source.sessionId / source.kind 任一命中即视为该来源的账本。
 * @returns {Promise<{ids: string[], scanned: number}>}
 */
async function matchLedgers(memoHome, sel, { taskIds = [] } = {}) {
  const wanted = new Set(taskIds.filter((x) => typeof x === 'string' && x !== ''));
  const ids = [];
  let scanned = 0;
  for (const id of await taskLedgerDirs(memoHome)) {
    const file = path.join(memoHome, 'sessions', id, 'segments.jsonl');
    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    scanned++;
    let hit = wanted.has(id);
    if (!hit) {
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        let seg;
        try {
          seg = JSON.parse(line);
        } catch {
          continue;
        }
        if (sel.agent !== undefined && (seg?.source?.agent === sel.agent || seg?.source?.kind === sel.agent)) {
          hit = true;
        }
        if (sel.session !== undefined
          && (seg?.source?.session === sel.session || seg?.source?.sessionId === sel.session)) {
          hit = true;
        }
        if (hit) break;
      }
    }
    if (hit) ids.push(id);
  }
  return { ids, scanned };
}

/** 删除任务账本目录（sessions/<taskId>/）与 meta（sessions/<taskId>.json）。 */
async function removeLedgers(memoHome, ids) {
  const removed = [];
  for (const id of ids) {
    await fsp.rm(path.join(memoHome, 'sessions', id), { recursive: true, force: true });
    await fsp.rm(path.join(memoHome, 'sessions', `${id}.json`), { force: true });
    removed.push(id);
  }
  return removed;
}

/** 删除一个分库的派生索引/向量文件（当前分库走 _reload 重建，不在这里删）。 */
async function removeDerivedIndex(memoHome, scope) {
  const base = path.join(memoHome, 'index', `${scopeKeyOf(scope)}.sqlite`);
  const vec = path.join(memoHome, 'index', `${scopeKeyOf(scope)}.vectors.jsonl`);
  const removed = [];
  for (const file of [base, `${base}-wal`, `${base}-shm`, vec, `${vec}.bak`]) {
    try {
      await fsp.rm(file, { force: true });
      removed.push(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return removed;
}

/** 删除 brief 文件（不重写成空文件：陈旧 brief 会继续泄露已删内容）。 */
async function removeBrief(memoHome, scope) {
  const file = path.join(memoHome, 'brief', briefFileName(scope));
  try {
    await fsp.rm(file, { force: true });
    return [file];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 按来源删除：对所有分库的匹配记录追加墓碑，并清掉派生索引/向量/brief/任务账本。
 * @param {import('./service.js').MemoryService} svc
 * @param {{agent?:string, session?:string, contentHash?:string, reason?:string, dryRun?:boolean}} opts
 */
export async function deleteBySource(svc, { agent, session, contentHash, reason, dryRun = false } = {}) {
  svc._ensureOpen();
  const sel = selectorsOf({ agent, session, contentHash });
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim() === '')) {
    throw invalidArg('delete: --reason must be a non-empty string when provided');
  }
  let now = svc._nowIso();
  let scopes = await listScopes(svc.memoHome);
  const planMatches = async () => {
    const found = [];
    for (const scope of scopes) {
      for (const rec of await latestByScope(svc, scope)) {
        if (rec.status === 'tombstoned') continue;
        if (!matches(rec, sel)) continue;
        found.push(rec);
      }
    }
    return found;
  };
  let planned = await planMatches();
  if (dryRun) {
    const recordTaskIds = planned.map((r) => r.source?.session).filter((x) => typeof x === 'string' && x !== '');
    const preview = await matchLedgers(svc.memoHome, sel, { taskIds: [session, ...recordTaskIds] });
    return {
      dryRun: true,
      selectors: sel,
      tombstoned: planned.map((r) => r.id),
      scopes: [...new Set(planned.map((r) => r.scope))],
      taskIds: preview.ids,
    };
  }

  const derived = [];
  const taskIds = [];
  await withLock(svc.memoHome, async () => {
    svc._inScopeLock = true;
    try {
      // 判定必须在锁内重做：锁外计划与锁内落墓碑之间若有并发写入，
      // 新记录会逃过删除，随后 verify-delete 就会报残留（这里不能靠「大概齐」）。
      now = svc._nowIso();
      scopes = await listScopes(svc.memoHome);
      await svc._refreshIncremental();
      planned = await planMatches();
      for (const rec of planned) {
        const tags = Array.isArray(rec.tags) && !rec.tags.includes(TOMBSTONE_TAG)
          ? [...rec.tags, TOMBSTONE_TAG] : rec.tags;
        const tomb = withPatch(rec, {
          status: 'tombstoned',
          validTo: rec.validTo ?? now,
          tags,
        });
        const v = validateRecord(tomb);
        if (!v.ok) throw invalidArg(`deleteBySource: produced invalid tombstone: ${v.errors.join('; ')}`);
        if (rec.scope === svc.scope) {
          // 当前分库：走 commit 让 _records/index 同步更新（锁已持有 → Immediate 通道）。
          await svc._commit(tomb, 'delete_source', {
            agent: sel.agent ?? null, session: sel.session ?? null, reason: reason?.trim() ?? null,
          });
        } else {
          await svc.store.appendImmediate(tomb);
        }
      }
      // 当前分库重载（索引只收 live）；其余分库直接删派生文件，下次打开会重建。
      if (planned.some((r) => r.scope === svc.scope)) {
        await svc._reload();
        // 向量 rewrite 会把旧文件备份成 .bak；那是派生备份，删除后不能留。
        const key = scopeKeyOf(svc.scope);
        await fsp.rm(path.join(svc.memoHome, 'index', `${key}.vectors.jsonl.bak`), { force: true });
        // sqlite WAL 里还留着 DELETE 前的帧；truncate 后磁盘不再有可回放副本。
        const db = svc.index?.db ?? svc.index?.base?.db;
        if (db && typeof db.exec === 'function') {
          try {
            db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
          } catch { /* 索引不是 WAL/已关闭：不阻断删除 */ }
        }
      }
      for (const scope of [...new Set(planned.map((r) => r.scope))]) {
        if (scope !== svc.scope) derived.push(...await removeDerivedIndex(svc.memoHome, scope));
        derived.push(...await removeBrief(svc.memoHome, scope));
      }
      // 任务账本：显式 session + 命中记录自带的 source.session 都是 taskId；
      // 再扫段里的 source 命中（按 agent/kind/session），保证账本不残留。
      const recordTaskIds = planned.map((r) => r.source?.session).filter((x) => typeof x === 'string' && x !== '');
      const ledgers = await matchLedgers(svc.memoHome, sel, { taskIds: [session, ...recordTaskIds] });
      taskIds.push(...await removeLedgers(svc.memoHome, ledgers.ids));
      const detail = {
        agent: sel.agent ?? null,
        session: sel.session ?? null,
        contentHash: sel.contentHash ?? null,
        reason: reason?.trim() ?? null,
        tombstoned: planned.length,
        ids: planned.slice(0, 50).map((r) => r.id),
        scopes: [...new Set(planned.map((r) => r.scope))],
        taskIds,
        derivedFiles: derived.length,
      };
      await svc._event('delete_source', sel.agent ?? sel.session ?? sel.contentHash ?? 'source', detail);
    } finally {
      svc._inScopeLock = false;
    }
  });
  return {
    dryRun: false,
    selectors: sel,
    tombstoned: planned.map((r) => r.id),
    scopes: [...new Set(planned.map((r) => r.scope))],
    taskIds,
    derivedFiles: derived.length,
  };
}

function bufferHas(buf, needle) {
  if (!needle) return false;
  return buf.includes(Buffer.from(needle));
}

async function readIfExists(file) {
  try {
    return await fsp.readFile(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * 按来源/哈希验证删除是否彻底。检查 items（只把非墓碑匹配当残留——append-only
 * 真相层里历史墓碑是预期的）、index/sqlite/vectors、brief、sessions 账本。
 * @returns {Promise<{ok:boolean, selectors:object, residue:object[], checked:object}>}
 */
export async function verifyDelete(svc, { agent, session, contentHash } = {}) {
  svc._ensureOpen();
  const sel = selectorsOf({ agent, session, contentHash });
  const memoHome = svc.memoHome;
  const residue = [];
  const checked = { scopes: 0, itemLines: 0, indexFiles: 0, briefFiles: 0, ledgerFiles: 0 };

  const targetIds = new Set();
  const targetTexts = new Set();
  const targetHashes = new Set();
  const targetSessions = new Set(session === undefined ? [] : [session]);
  const scopes = await listScopes(memoHome);
  checked.scopes = scopes.length;

  for (const scope of scopes) {
    const rows = await svc.store.loadScope(scope);
    checked.itemLines += rows.length;
    const latest = new Map();
    for (const r of rows) latest.set(r.id, r);
    for (const r of rows) {
      if (!matches(r, sel)) continue;
      targetIds.add(r.id);
      if (typeof r.source?.session === 'string' && r.source.session !== '') targetSessions.add(r.source.session);
      if (r.contentHash) targetHashes.add(r.contentHash);
      if (typeof r.text === 'string' && r.text.length >= 4) targetTexts.add(r.text);
      if (typeof r.value === 'string' && r.value.length >= 4) targetTexts.add(r.value);
    }
    for (const r of latest.values()) {
      if (r.status === 'tombstoned') continue;
      if (matches(r, sel)) {
        residue.push({ where: `items/${itemsFileName(scope)}`, reason: 'live record still present', id: r.id });
      }
    }
  }

  // 索引/向量：按 id 和 contentHash 在字节里找（sqlite/vectors 都存 id）。
  let indexNames = [];
  try {
    indexNames = await fsp.readdir(path.join(memoHome, 'index'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const name of indexNames) {
    // sqlite 的 -wal / -shm 是活库日志，DELETE 的旧帧会停留到 checkpoint；不按字节判残留。
    if (name.endsWith('.sqlite') || name.endsWith('.sqlite-wal') || name.endsWith('.sqlite-shm')) continue;
    const buf = await readIfExists(path.join(memoHome, 'index', name));
    if (!buf) continue;
    checked.indexFiles++;
    for (const id of targetIds) {
      if (bufferHas(buf, id)) {
        residue.push({ where: `index/${name}`, reason: 'record id still in derived index', id });
      }
    }
    for (const hash of targetHashes) {
      if (bufferHas(buf, hash)) residue.push({ where: `index/${name}`, reason: 'contentHash still in derived index', hash });
    }
  }
  for (const name of indexNames) {
    if (!name.endsWith('.sqlite')) continue;
    const file = path.join(memoHome, 'index', name);
    const check = sqliteResidue(file, targetIds);
    checked.indexFiles++;
    if (check.unavailable) {
      residue.push({ where: `index/${name}`, reason: 'sqlite index present but node:sqlite is unavailable; cannot verify deletion' });
      continue;
    }
    for (const id of check.ids) {
      residue.push({ where: `index/${name}`, reason: 'record id still queryable in sqlite index', id });
    }
  }

  // brief：按正文/标题 substring 找（brief 不含 id）。
  let briefNames = [];
  try {
    briefNames = await fsp.readdir(path.join(memoHome, 'brief'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const name of briefNames) {
    const buf = await readIfExists(path.join(memoHome, 'brief', name));
    if (!buf) continue;
    checked.briefFiles++;
    for (const text of targetTexts) {
      if (bufferHas(buf, text)) residue.push({ where: `brief/${name}`, reason: 'deleted text still in brief' });
    }
  }

  // 任务账本：按 source 字段 + 目标正文。
  for (const id of await taskLedgerDirs(memoHome)) {
    const file = path.join(memoHome, 'sessions', id, 'segments.jsonl');
    const buf = await readIfExists(file);
    if (!buf) continue;
    checked.ledgerFiles++;
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      let seg;
      try {
        seg = JSON.parse(line);
      } catch {
        continue;
      }
      const src = seg?.source ?? {};
      if ((sel.agent !== undefined && (src.agent === sel.agent || src.kind === sel.agent))
        || (sel.session !== undefined && (src.session === sel.session || src.sessionId === sel.session))
        || (id !== undefined && targetSessions.has(id))
        || (typeof src.session === 'string' && targetSessions.has(src.session))
        || (typeof src.sessionId === 'string' && targetSessions.has(src.sessionId))) {
        residue.push({ where: `sessions/${id}/segments.jsonl`, reason: 'ledger segment still references deleted source' });
        break;
      }
      for (const text of targetTexts) {
        if (line.includes(text)) {
          residue.push({ where: `sessions/${id}/segments.jsonl`, reason: 'deleted text still in ledger segment' });
          break;
        }
      }
    }
  }

  return { ok: residue.length === 0, selectors: sel, residue, checked };
}
