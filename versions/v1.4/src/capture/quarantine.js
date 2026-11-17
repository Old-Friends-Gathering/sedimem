// capture/quarantine.js — 隔离区（B5，v1.4）：只存**引用**，不存正文
//
// 为什么单独一层：捕获链路可能拿到整段对话/网页/文件内容，直接进 inbox 会把
// 「待审正文」变成第二个真相层。隔离区只保留「去哪儿看」（uri）、「看的是哪一版」
// （hash）和「为什么值得看」（≤200 字 quote），正文永远留在原处，由人决定是否提升。
//
// 存储：`<memoHome>/inbox/<scopeKey>.quarantine.jsonl`（append-only，同 id 最后一行胜出）。
// 与 inbox 共用**同一套策略表**：`capture.maxQueueBytes`（每文件字节配额，E_QUEUE_QUOTA）
// 与 TTL（`capture.quarantineTtlMs`，默认 90 天；见 docs/02 §3.24）。
//
// 提升：`accept` 只走**人工**（必须显式给 --by，且不能是 capture/auto），
// 落库文本只有 quote（≤200 字），并带 tags ['quarantine','capture'] 供追溯。
import { randomUUID } from 'node:crypto';
import {
  mkdirSync, readFileSync, existsSync, statSync, renameSync, rmSync, writeFileSync,
  openSync, fstatSync, writeSync, closeSync,
} from 'node:fs';
import path from 'node:path';
import { scopeKeyOf } from '../config/paths.js';
import { defaultPolicy } from '../config/policy.js';

/** 人工提升者的最小校验：这两个值是「自动链路」的保留名，不能拿来冒充人工。 */
const NON_HUMAN_BY = new Set(['capture', 'auto']);

/**
 * 创建隔离区。
 * @param {{memoHome: string, scope?: string, maxQueueBytes?: number, ttlMs?: number}} args
 */
export function createQuarantine({ memoHome, scope = 'default', maxQueueBytes, ttlMs } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error('createQuarantine: memoHome is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const inboxDir = path.join(memoHome, 'inbox');
  const file = path.join(inboxDir, `${scopeKeyOf(scope)}.quarantine.jsonl`);
  const lockDir = path.join(memoHome, '.lock');
  const lockOwnerFile = path.join(lockDir, 'owner.json');
  const maxBytes = maxQueueBytes ?? defaultPolicy.capture?.maxQueueBytes ?? 4 * 1024 * 1024;
  const maxQuote = defaultPolicy.capture?.quarantineMaxQuoteChars ?? 200;
  const ttl = ttlMs ?? defaultPolicy.capture?.quarantineTtlMs ?? 90 * 24 * 3600 * 1000;
  let lastCorrupt = 0;

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  function ownerOf() {
    try { return JSON.parse(readFileSync(lockOwnerFile, 'utf8')); } catch { return null; }
  }

  /** 与 capture/queue.js 同一把 `<memoHome>/.lock`（同步数据锁，毫秒级操作）。 */
  function withLockSync(fn) {
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(memoHome, { recursive: true });
    const nonce = randomUUID();
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        mkdirSync(lockDir);
        writeFileSync(lockOwnerFile, JSON.stringify({ pid: process.pid, nonce, at: Date.now() }));
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const st = (() => { try { return statSync(lockDir); } catch { return null; } })();
        const owner = ownerOf();
        const stale = st && Date.now() - st.mtimeMs > 10000 && (!owner || !pidAlive(owner.pid));
        if (stale) {
          const grave = `${lockDir}.stale-${process.pid}-${nonce.slice(0, 8)}`;
          try { renameSync(lockDir, grave); rmSync(grave, { recursive: true, force: true }); } catch { /* 被抢 */ }
          continue;
        }
        if (Date.now() > deadline) {
          const err = new Error(`quarantine: 取锁超时（${lockDir}）`);
          err.code = 'E_LOCK_TIMEOUT';
          throw err;
        }
        const until = Date.now() + 2 + Math.random() * 2;
        while (Date.now() < until) { /* spin */ }
      }
    }
    try {
      return fn();
    } finally {
      try {
        const owner = ownerOf();
        if (owner?.nonce === nonce) rmSync(lockDir, { recursive: true, force: true });
      } catch { /* 已被剥夺 */ }
    }
  }

  /** 读全部行（同 id 最后一行胜出；坏行跳过并计数）。 */
  function read() {
    if (!existsSync(file)) return [];
    const byId = new Map();
    let corrupt = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object' && typeof row.id === 'string') byId.set(row.id, row);
        else corrupt++;
      } catch {
        corrupt++;
      }
    }
    lastCorrupt = corrupt;
    return [...byId.values()];
  }

  function append(rows) {
    if (rows.length === 0) return;
    withLockSync(() => {
      mkdirSync(inboxDir, { recursive: true });
      const payload = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
      const bytes = Buffer.byteLength(payload, 'utf8');
      const fd = openSync(file, 'a');
      try {
        const current = fstatSync(fd).size;
        if (current + bytes > maxBytes) {
          const err = new Error(`quarantine: 写入 ${bytes} 字节会超过上限 ${maxBytes}（当前 ${current}）`);
          err.code = 'E_QUEUE_QUOTA';
          err.detail = { file, current, bytes, maxBytes };
          throw err;
        }
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
    });
  }

  /** 只保留引用字段：正文键一律丢弃（宁可丢字段，也不把原文写进隔离区）。 */
  function normalizeRef(input) {
    if (!input || typeof input !== 'object') {
      const err = new Error('quarantine.add: 需要 {uri, hash, quote} 对象');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const uri = typeof input.uri === 'string' ? input.uri.trim() : '';
    const hash = typeof input.hash === 'string' ? input.hash.trim() : '';
    if (uri === '') {
      const err = new Error('quarantine.add: uri 不能为空（隔离区只存引用，不存正文）');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    if (hash === '') {
      const err = new Error('quarantine.add: hash 不能为空（没有版本标识的引用不可审计）');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const quoteRaw = typeof input.quote === 'string' ? input.quote.trim() : '';
    const quote = quoteRaw.length > maxQuote ? `${quoteRaw.slice(0, maxQuote)}…` : quoteRaw;
    return {
      id: randomUUID(),
      uri,
      hash,
      quote,
      kind: typeof input.kind === 'string' && input.kind !== '' ? input.kind : 'fact',
      reason: typeof input.reason === 'string' ? input.reason : '',
      // 审计：who/at 必填于调用方；这里只做形状兜底
      addedBy: typeof input.addedBy === 'string' && input.addedBy !== '' ? input.addedBy : 'unknown',
      at: new Date().toISOString(),
      status: 'pending',
    };
  }

  /**
   * 加入引用。返回新行（不含任何正文）。
   * @param {object|object[]} refs
   */
  function add(refs) {
    const list = Array.isArray(refs) ? refs : [refs];
    const rows = list.map(normalizeRef);
    append(rows);
    return rows;
  }

  /** 列表（默认全部；`status` 过滤）。过期条目标记 expired=true，不静默删除。 */
  function list({ status } = {}) {
    const now = Date.now();
    return read()
      .map((r) => {
        const at = Date.parse(String(r.at ?? ''));
        const expired = Number.isFinite(at) && now - at > ttl;
        return { ...r, expired };
      })
      .filter((r) => (status ? r.status === status : true));
  }

  /**
   * 人工提升：把引用提升为真相层记忆（只写 quote，不写原文）。
   * @param {string[]} ids
   * @param {{service: object, by: string}} opts by 必须是人工标识（不能是 capture/auto）
   */
  async function accept(ids, { service, by } = {}) {
    const who = typeof by === 'string' ? by.trim() : '';
    if (who === '') {
      const err = new Error('quarantine.accept: 必须显式给 --by <人工标识>（只走人工提升）');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    if (NON_HUMAN_BY.has(who)) {
      const err = new Error(`quarantine.accept: by=${who} 是自动链路保留名，不能冒充人工提升`);
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    if (!service || typeof service.write !== 'function') {
      const err = new Error('quarantine.accept: 需要已打开的 service');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
    const rows = read();
    const accepted = [];
    const skipped = [];
    const now = Date.now();
    for (const ref of rows) {
      if (!wanted.has(ref.id)) continue;
      if (ref.status !== 'pending') {
        skipped.push({ id: ref.id, reason: `status:${ref.status}` });
        continue;
      }
      const at = Date.parse(String(ref.at ?? ''));
      if (Number.isFinite(at) && now - at > ttl) {
        skipped.push({ id: ref.id, reason: 'expired' });
        continue;
      }
      await service.write({
        text: ref.quote === '' ? `隔离引用：${ref.uri}` : ref.quote,
        kind: ref.kind,
        // 只把引用写进 source.quote，正文始终留在 uri 指向的原处
        source: { agent: who, quote: `${ref.uri}#${ref.hash}` },
        tags: ['quarantine', 'capture'],
        privacy: 'private',
      });
      accepted.push(ref.id);
    }
    if (accepted.length > 0) {
      const decidedAt = new Date().toISOString();
      const fresh = new Map(read().map((r) => [r.id, r]));
      append(accepted
        .map((id) => (fresh.has(id) ? { ...fresh.get(id), status: 'accepted', decidedBy: who, decidedAt } : null))
        .filter(Boolean));
    }
    return { accepted, skipped };
  }

  /** 拒绝：只改状态，永不落库。 */
  function reject(ids, { by } = {}) {
    const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
    const who = typeof by === 'string' && by !== '' ? by : 'user';
    const rows = read().filter((r) => wanted.has(r.id) && r.status === 'pending');
    const decidedAt = new Date().toISOString();
    append(rows.map((r) => ({ ...r, status: 'rejected', decidedBy: who, decidedAt })));
    return { rejected: rows.map((r) => r.id) };
  }

  return { add, list, accept, reject, read, size: () => read().length, _file: file, get lastCorrupt() { return lastCorrupt; } };
}
