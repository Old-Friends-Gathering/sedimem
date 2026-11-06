// api/service.js — MemoryService（唯一对外 API，契约：docs/02-data-model-and-contract.md §3）
// 编排层：不含策略细节。策略来自 hygiene/* 与 config/policy.json。
// 车道 A（issue #32）：实现拆到 lifecycle/write-path/search-path/maintenance 四个模块，
// 本文件只保留「类 + 构造函数 + 一行委托」，方法集合与语义零改动（D1：只搬不改）。

import { systemClock } from '../core/clock.js';
import { queryEvents, queryExportRecords } from './read-only.js';
import { resolveScope } from '../core/scope.js';
import { JsonlStore } from '../storage/jsonl-store.js';
import { createIndex } from '../index/create-index.js';
import { QuotaPolicy } from '../hygiene/quota.js';
import { CurateQueue } from '../hygiene/curate.js';
import { defaultPolicy as POLICY } from '../config/policy.js';
import * as lifecycle from './lifecycle.js';
import * as writePath from './write-path.js';
import * as searchPath from './search-path.js';
import * as maintenance from './maintenance.js';

// 错误工厂：本文件是唯一权威（错误文本被测试逐字断言），四个承接模块经 import 反向取用；
// ESM 函数声明在实例化期即初始化，循环 import 在运行期取值是安全的。
export function invalid(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_RECORD';
  return err;
}
export function notFound(msg) {
  const err = new Error(msg);
  err.code = 'E_NOT_FOUND';
  return err;
}
export function invalidArg(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_ARG';
  return err;
}

/**
 * 创建 MemoryService（已 build 索引）。
 * @param {{memoHome: string, scope?: string, cwd?: string, clock?: object,
 *          store?: JsonlStore, index?: InvertedIndex, quota?: QuotaPolicy}} args
 */
export async function createMemoryService({
  memoHome, scope, cwd, clock = systemClock,
  store, index, quota,
} = {}) {
  if (!memoHome) throw invalid('createMemoryService: memoHome is required');
  const resolvedScope = scope ?? resolveScope({ cwd, env: process.env }).scope;
  const service = new MemoryService({
    memoHome,
    scope: resolvedScope,
    clock,
    store: store ?? new JsonlStore({ memoHome }),
    index: index ?? createIndex({ policy: POLICY, memoHome, scope: resolvedScope, clock }),
    quota: quota ?? new QuotaPolicy({}),
  });
  await service._init();
  return service;
}

export class MemoryService {
  constructor({ memoHome, scope, clock, store, index, quota }) {
    this.memoHome = memoHome;
    this.scope = scope;
    this.clock = clock;
    this.store = store;
    this.index = index;
    this.quota = quota;
    this.queue = new CurateQueue({ memoHome, clock });
    /** @type {Map<string, MemoryRecord>} 同 id 最后一行胜出 */
    this._records = new Map();
    /** @type {Map<string, MemoryRecord[]>} id -> 全部版本（asOf 查询用） */
    this._versions = new Map();
    /** @type {Map<string, number>} id -> 未落盘的 hits 增量（flushHits 前不写盘） */
    this._extraHits = new Map();
    /** @type {number} items/<scope>.jsonl 已增量消费到的字节偏移（裁决 13） */
    this._readOffset = 0;
    /** @type {Error|null} 初始化/重载时真相层损坏（E_CORRUPT_JSONL）——doctor 可读，其余操作 fail-loud */
    this._loadError = null;
    /** @type {boolean} 当前是否在本服务持有的 scope 锁临界区内（内部标志） */
    this._inScopeLock = false;
    this._closed = false;
  }

  // —— lifecycle ——
  async _init() { return lifecycle.init(this); }
  async _reload() { return lifecycle.reload(this); }
  async refreshView() { return lifecycle.refreshView(this); }
  async _refreshIncremental() { return lifecycle.refreshIncremental(this); }
  _ensureOpen() { return lifecycle.ensureOpen(this); }
  _nowIso() { return this.clock.now(); }
  async _event(op, id, detail) { return lifecycle.event(this, op, id, detail); }
  async _commit(record, op = 'write', detail = {}) { return lifecycle.commit(this, record, op, detail); }

  // —— write-path ——
  async write(input) { return writePath.writeRecord(this, input); }
  async supersede(args) { return writePath.supersedeRecord(this, args); }
  async forget(args) { return writePath.forgetRecord(this, args); }
  async enforceQuota(opts) { return writePath.enforceQuota(this, opts); }
  async _enforceQuota() { return writePath.enforceQuotaPrivate(this); }

  // —— search-path ——
  async search(query, opts) { return searchPath.searchRecords(this, query, opts); }
  _maskSuspicious(r, includeSuspicious) { return searchPath.maskSuspicious(this, r, includeSuspicious); }
  _withExtraHits(r) { return searchPath.withExtraHits(this, r); }
  async flushHits() { return searchPath.flushHits(this); }
  _statusOk(r, opts) { return searchPath.statusOk(this, r, opts); }
  async get(id, opts) { return searchPath.getRecord(this, id, opts); }
  async brief(opts) { return searchPath.briefRecords(this, opts); }

  // —— maintenance ——
  async stats() { return maintenance.stats(this); }
  async reindex() { return maintenance.reindex(this); }
  _parseCorruptLocation(message) { return maintenance.parseCorruptLocation(this, message); }
  _corruptIssue(code, e) { return maintenance.corruptIssue(this, code, e); }
  async doctor() { return maintenance.doctor(this); }
  async curateExport(opts) { return maintenance.curateExport(this, opts); }
  async curateApply(args) { return maintenance.curateApply(this, args); }
  async _commitPairVerdict(a, b, d, detail) { return maintenance.commitPairVerdict(this, a, b, d, detail); }
  async _applyIdsDecision(d) { return maintenance.applyIdsDecision(this, d); }
  async dedupeScan(opts) { return maintenance.dedupeScan(this, opts); }

  // —— read-only（裁决 30：实现本就在 api/read-only.js）——
  async events(args = {}) { return queryEvents(this, args); }
  async exportRecords(args = {}) { return queryExportRecords(this, args); }

  // —— close（实现见 lifecycle）——
  async close() { return lifecycle.close(this); }
}

export { POLICY as _policy };
