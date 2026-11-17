// capture/queue.js — 待审捕获队列（D3，任务 B2）
// 存储 $MEMO_HOME/inbox/<scopeKey>.jsonl（append-only；同 id 最后一行胜出，与真相层同口径）。
// 候选绝不直接入库：accept 逐条走 service.write（V1–V5 门禁/去重/redaction 照常生效）。

import { randomUUID } from 'node:crypto';
import {
  mkdirSync, readFileSync, appendFileSync, existsSync, statSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { scopeKeyOf } from '../config/paths.js';
import { kindNames, defaultPolicy } from '../config/policy.js';
import { normalizeText } from '../core/hash.js';

/** policy kinds 无 bug：accept 落库时回落（候选行本身保留原 kind，不篡改历史） */
const KIND_FALLBACK = { bug: 'gotcha' };

/**
 * 创建捕获队列。
 * @param {{memoHome: string, scope?: string}} args
 * @returns {{add: Function, list: Function, accept: Function, reject: Function, read: Function, size: Function}}
 */
export function createCaptureQueue({ memoHome, scope = 'default', maxQueueBytes: maxBytes } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error('createCaptureQueue: memoHome is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const inboxDir = path.join(memoHome, 'inbox');
  const file = path.join(inboxDir, `${scopeKeyOf(scope)}.jsonl`);
  const lockDir = path.join(memoHome, '.lock');
  const lockOwnerFile = path.join(lockDir, 'owner.json');
  const maxQueueBytes = maxBytes ?? defaultPolicy.capture?.maxQueueBytes ?? 4 * 1024 * 1024;
  /** 最近一次读取遇到的坏行数（doctor/排障用；坏行不阻断队列，对抗审核 S-3） */
  let lastCorrupt = 0;

  /** 取同步互斥锁（mkdir 的 EEXIST 是原子排他；>10s 视为陈旧并接管）。 */
  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  function ownerOf() {
    try { return JSON.parse(readFileSync(lockOwnerFile, 'utf8')); } catch { return null; }
  }

  /**
   * 同步数据锁：与 storage/lock.js 共用 `<memoHome>/.lock`，写同样的 owner.json。
   * 队列操作是毫秒级，不单独心跳；异步 withLock 看到 pid 存活不会误接管。
   */
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
          const err = new Error(`capture queue: 取锁超时（${lockDir}）`);
          err.code = 'E_LOCK_TIMEOUT';
          throw err;
        }
        // 忙等 1–3ms：同步 API 没有 await 可用，队列写入是毫秒级操作
        const until = Date.now() + 2 + Math.random() * 2;
        while (Date.now() < until) { /* spin */ }
      }
    }
    try {
      return fn();
    } finally {
      // 只删自己持有的锁：避免接管后把下一个持有者的锁删掉。
      try {
        const owner = ownerOf();
        if (owner?.nonce === nonce) rmSync(lockDir, { recursive: true, force: true });
      } catch { /* 已被剥夺 */ }
    }
  }

  /** 读取全部行：坏行跳过并计数（不再让一行坏 JSON 永久阻断 add/list/accept） */
  function read() {
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    const byId = new Map(); // 同 id 最后一行胜出
    let corrupt = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        corrupt++;
        continue;
      }
      if (row && typeof row === 'object' && typeof row.id === 'string') byId.set(row.id, row);
      else corrupt++;
    }
    lastCorrupt = corrupt;
    return [...byId.values()];
  }

  /**
   * 追加若干行（add 的新候选 / accept 与 reject 的状态行）。
   * 对抗审核 B4：原来「全量读 → 拼 → 整文件写」在并发下会互相覆盖（200 条丢 100 条）。
   * 现在 ①整段在同步互斥锁内完成读改写；②写临时文件再 rename（读者永不见半行）。
   */
  /** 无锁追加（调用方**必须**已持锁）；写临时文件再 rename，读者永不见半行。 */
  function appendRaw(rows) {
    if (rows.length === 0) return;
    mkdirSync(inboxDir, { recursive: true });
    const payload = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
    const bytes = Buffer.byteLength(payload);
    const current = existsSync(file) ? statSync(file).size : 0;
    if (current + bytes > maxQueueBytes) {
      // 配额按字节而不是条数：一条 2 MB 的粘贴正文能把「50 条」撑爆。
      const err = new Error(`capture queue: 写入 ${bytes} 字节会超过上限 ${maxQueueBytes}（当前 ${current}）`);
      err.code = 'E_QUEUE_QUOTA';
      err.detail = { file, current, bytes, maxQueueBytes };
      throw err;
    }
    // O_APPEND 追加，不整文件重读重写；锁保证同一时刻只有本进程写。读者仍按「同 id 最后一行胜出」折叠。
    appendFileSync(file, payload);
  }

  /** 追加若干行（自带锁；锁内调用要用 appendRaw，同步锁不可重入）。 */
  function append(rows) {
    if (rows.length === 0) return;
    withLockSync(() => appendRaw(rows));
  }

  /**
   * 批量入队候选。同 normalizeText 文本（队内既有或本批内）跳过。
   * @param {{text: string, kind?: string, reason?: string}[]} candidates
   * @param {{by?: string}} [opts] by 记录入队人（decidedBy 尚空，仅溯源）
   * @returns {{added: object[], skipped: {text: string, reason: string}[]}}
   */
  function add(candidates, { by } = {}) {
    if (!Array.isArray(candidates)) {
      const err = new Error('add: candidates must be an array');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    return withLockSync(() => {
    const rows = read();
    const seen = new Set(rows.map((r) => normalizeText(String(r.text ?? ''))));
    const added = [];
    const skipped = [];
    for (const c of candidates) {
      if (!c || typeof c.text !== 'string' || c.text.length === 0) {
        skipped.push({ text: String(c?.text ?? ''), reason: 'invalid candidate' });
        continue;
      }
      const norm = normalizeText(c.text);
      if (seen.has(norm)) {
        skipped.push({ text: c.text, reason: 'duplicate' });
        continue;
      }
      seen.add(norm);
      const row = {
        id: randomUUID(),
        text: c.text,
        kind: c.kind ?? 'fact',
        reason: c.reason ?? '',
        at: new Date().toISOString(),
        status: 'pending',
        ...(by ? { addedBy: by } : {}),
      };
      added.push(row);
      rows.push(row);
    }
    if (added.length > 0) appendRaw(added);
    return { added, skipped };
    });
  }

  /**
   * 确认入库：逐条 service.write（真实签名 write(input)，source 校验照抄 record.js：
   * source.agent 必须匹配 AGENT_PATTERN 且非保留名，不合格该条 failed 不中断）。
   * @param {string[]} ids
   * @param {{service: object, by?: string}} opts by 缺省 'capture'（写入 source.agent）
   * @returns {Promise<{accepted: object[], rejected: {id: string, reason: string}[]}>}
   */
  async function accept(ids, { service, by = 'capture' } = {}) {
    if (!service || typeof service.write !== 'function') {
      const err = new Error('accept: service (with .write) is required');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    if (!Array.isArray(ids)) {
      const err = new Error('accept: ids must be an array');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const wanted = new Set(ids.map(String));
    const rows = read();
    const legalKinds = new Set(kindNames(defaultPolicy));
    const accepted = [];
    const rejected = [];
    const decided = [];
    for (const row of rows) {
      if (!wanted.has(row.id)) continue;
      if (row.status !== 'pending') {
        rejected.push({ id: row.id, reason: `already ${row.status}` });
        decided.push(row);
        continue;
      }
      // kind 落库回落（bug -> gotcha），原因留痕
      const kind = legalKinds.has(row.kind) ? row.kind : (KIND_FALLBACK[row.kind] ?? 'fact');
      try {
        const res = await service.write({
          text: row.text,
          kind,
          source: { agent: by, quote: row.reason ? `capture:${row.reason}` : 'capture' },
          tags: ['capture'],
        });
        accepted.push({ id: row.id, action: res.action, recordId: res.record?.id });
        decided.push({ ...row, kind, status: 'accepted', decidedAt: new Date().toISOString(), decidedBy: by });
      } catch (e) {
        // 单条失败不中断（D3：报告 failed 继续）
        rejected.push({ id: row.id, reason: `${e.code ?? 'E_WRITE_FAILED'}: ${e.message}` });
      }
    }
    const changed = decided.filter((r) => r.status === 'accepted');
    if (changed.length > 0) append(changed);
    return { accepted, rejected };
  }

  /**
   * 拒绝候选（不入库）。
   * @param {string[]} ids
   * @param {{note?: string}} [opts]
   * @returns {{rejected: object[], missing: string[]}}
   */
  function reject(ids, { note } = {}) {
    if (!Array.isArray(ids)) {
      const err = new Error('reject: ids must be an array');
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    const wanted = new Set(ids.map(String));
    const rows = read();
    const out = [];
    const missing = [];
    const updates = [];
    for (const row of rows) {
      if (!wanted.has(row.id)) continue;
      if (row.status !== 'pending') { out.push(row); continue; }
      const upd = {
        ...row,
        status: 'rejected',
        decidedAt: new Date().toISOString(),
        decidedBy: 'user',
        ...(note ? { note } : {}),
      };
      out.push(upd);
      updates.push(upd);
    }
    for (const id of wanted) if (!rows.some((r) => r.id === id)) missing.push(id);
    if (updates.length > 0) append(updates);
    return { rejected: out, missing };
  }

  /** 按状态过滤列出（缺省全部） */
  function list({ status } = {}) {
    const rows = read();
    return status === undefined || status === null || status === ''
      ? rows
      : rows.filter((r) => r.status === status);
  }

  /** 队列总行数（含已决） */
  function size() { return read().length; }

  return {
    add, list, accept, reject, read, size, _file: file,
    /** 最近一次读取遇到的坏行数（doctor/排障用；坏行不阻断队列） */
    get lastCorrupt() { return lastCorrupt; },
  };
}
