// storage/jsonl-store.js — 真相层 JSONL 存储（契约：docs/02 §3）
// items/<scope>.jsonl 只 append 完整记录快照（同 id 最后一行胜出）；坏行 fail-loud。

import path from 'node:path';
import fsp from 'node:fs/promises';
import { withLock } from './lock.js';

export class JsonlStore {
  /** @param {{memoHome: string}} opts */
  constructor({ memoHome }) {
    if (!memoHome || typeof memoHome !== 'string') {
      const err = new Error(`JsonlStore: memoHome required, got ${JSON.stringify(memoHome)}`);
      err.code = 'E_INVALID_RECORD';
      throw err;
    }
    this.memoHome = memoHome;
    this.itemsDir = path.join(memoHome, 'items');
    this.eventsPath = path.join(memoHome, 'events.jsonl');
  }

  _scopePath(scope) {
    return path.join(this.itemsDir, `${scope}.jsonl`);
  }

  /** 追加一行完整记录快照到 items/<scope>.jsonl（带锁） */
  async append(record) {
    await withLock(this.memoHome, () => this.appendImmediate(record));
  }

  /**
   * 追加记录快照，**不取锁**（调用方必须已持有 memoHome 的 scope 锁）。
   * 供 api 层把「增量重读 → 判定 → 追加」放进同一把 withLock 临界区用（裁决 13）。
   */
  async appendImmediate(record) {
    const line = JSON.stringify(record) + '\n';
    await fsp.mkdir(this.itemsDir, { recursive: true });
    await fsp.appendFile(this._scopePath(record.scope), line, 'utf8');
  }

  /** items/<scope>.jsonl 当前字节大小（文件不存在 → 0）。 */
  async fileSize(scope) {
    try {
      const st = await fsp.stat(this._scopePath(scope));
      return st.size;
    } catch (e) {
      if (e.code === 'ENOENT') return 0;
      throw e;
    }
  }

  /**
   * 从字节 offset 增量读取 items/<scope>.jsonl 的新增部分（裁决 13）。
   * - 只消费到最后一个换行符为止：尾部半行（并发写入未完成）留待下次再读；
   *   换行字节 0x0A 不会出现在 UTF-8 多字节序列中间，按字节切是安全的。
   * - chunk 内按 id fold（最后一行胜出），返回 {records, nextOffset}。
   * - 坏行 fail-loud：err.code='E_CORRUPT_JSONL'。
   * @param {string} scope
   * @param {number} fromOffset 上次已消费到的字节偏移
   * @returns {Promise<{records: MemoryRecord[], nextOffset: number}>}
   */
  async loadScopeIncremental(scope, fromOffset = 0) {
    const file = this._scopePath(scope);
    let buf;
    try {
      buf = await fsp.readFile(file);
    } catch (e) {
      if (e.code === 'ENOENT') return { records: [], nextOffset: 0 };
      throw e;
    }
    const start = Math.max(0, Math.min(fromOffset, buf.length));
    const slice = buf.subarray(start);
    const lastNl = slice.lastIndexOf(0x0a);
    if (lastNl === -1) return { records: [], nextOffset: start }; // 没有完整新行
    const nextOffset = start + lastNl + 1;
    const text = slice.subarray(0, lastNl + 1).toString('utf8');

    const byId = new Map();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        const err = new Error(`loadScopeIncremental: bad JSON at ${file} (offset ${start}, chunk line ${i + 1}): ${e.message}`);
        err.code = 'E_CORRUPT_JSONL';
        throw err;
      }
      if (!rec || typeof rec.id !== 'string') {
        const err = new Error(`loadScopeIncremental: record without id at ${file} (offset ${start}, chunk line ${i + 1})`);
        err.code = 'E_CORRUPT_JSONL';
        throw err;
      }
      byId.set(rec.id, rec); // 同 id 最后一行胜出
    }
    return { records: [...byId.values()], nextOffset };
  }

  /**
   * 逐行 parse + 按 id fold（最后一行胜出）+ 按 createdAt 升序。
   * 坏行不静默跳过：抛 err.code='E_CORRUPT_JSONL'。
   * @returns {Promise<MemoryRecord[]>}
   */
  async loadScope(scope) {
    const file = this._scopePath(scope);
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const byId = new Map();
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        const err = new Error(`loadScope: bad JSON at ${file}:${i + 1}: ${e.message}`);
        err.code = 'E_CORRUPT_JSONL';
        throw err;
      }
      if (!rec || typeof rec.id !== 'string') {
        const err = new Error(`loadScope: record without id at ${file}:${i + 1}`);
        err.code = 'E_CORRUPT_JSONL';
        throw err;
      }
      byId.set(rec.id, rec); // 同 id 最后一行胜出（含墓碑版本 → 重建不复活）
    }
    return [...byId.values()].sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /** 列出 items/ 下所有 scope 名（不含 .jsonl 后缀） */
  async listScopes() {
    let entries;
    try {
      entries = await fsp.readdir(this.itemsDir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    return entries.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)).sort();
  }

  /** 审计事件：{ts, op, scope, id, detail} → events.jsonl */
  async appendEvent(event) {
    await withLock(this.memoHome, () => this.appendEventImmediate(event));
  }

  /** 追加事件，**不取锁**（调用方必须已持有 memoHome 的 scope 锁；裁决 13）。 */
  async appendEventImmediate(event) {
    const line = JSON.stringify({ ...event }) + '\n';
    await fsp.mkdir(this.memoHome, { recursive: true });
    await fsp.appendFile(this.eventsPath, line, 'utf8');
  }

  /**
   * 读最近 limit 条事件（默认全部）。
   * @param {{limit?: number}} opts
   */
  async readEvents({ limit } = {}) {
    let raw;
    try {
      raw = await fsp.readFile(this.eventsPath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const events = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        events.push(JSON.parse(lines[i]));
      } catch (e) {
        const err = new Error(`readEvents: bad JSON at ${this.eventsPath}:${i + 1}: ${e.message}`);
        err.code = 'E_CORRUPT_JSONL';
        throw err;
      }
    }
    return typeof limit === 'number' && limit >= 0 ? events.slice(-limit) : events;
  }
}
