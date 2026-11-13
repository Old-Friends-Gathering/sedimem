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
import { createJudge } from '../hygiene/judge.js';
import { CurateQueue } from '../hygiene/curate.js';
import { defaultPolicy as POLICY } from '../config/policy.js';
import * as lifecycle from './lifecycle.js';
import * as writePath from './write-path.js';
import * as searchPath from './search-path.js';
import * as maintenance from './maintenance.js';
import { invalid, notFound, invalidArg } from '../core/errors.js';

// 错误工厂已上移到 core/errors.js（切断承接模块的反向 import 环）；
// 这里 re-export 保持既有「从本文件取错误工厂」的外部调用不破。
export { invalid, notFound, invalidArg } from '../core/errors.js';

/**
 * 策略浅合并：override 的每个顶层 section 整体替换，section 内部按 key 覆盖一层。
 * 只用于构造期覆盖（测试 / 多租户），不做深递归——策略结构是我们自己定义的，两层足够。
 * @param {object} base 默认策略
 * @param {object|undefined} override 覆盖项
 */
export function mergePolicy(base, override) {
  if (!override) return base;
  const out = { ...base };
  for (const [key, val] of Object.entries(override)) {
    const cur = base?.[key];
    out[key] = val && typeof val === 'object' && !Array.isArray(val)
      && cur && typeof cur === 'object' && !Array.isArray(cur)
      ? { ...cur, ...val }
      : val;
  }
  return out;
}

/**
 * 创建 MemoryService（已 build 索引）。
 * @param {{memoHome: string, scope?: string, cwd?: string, clock?: object,
 *          store?: JsonlStore, index?: InvertedIndex, quota?: QuotaPolicy,
 *          judge?: object, policy?: object}} args
 *   policy 覆盖项（v0.4）：传部分对象时与默认 POLICY 深合并，用于测试与多租户。
 */
export async function createMemoryService({
  memoHome, scope, cwd, clock = systemClock,
  store, index, quota, judge, policy,
} = {}) {
  if (!memoHome) throw invalid('createMemoryService: memoHome is required');
  // 浅合并（每个顶层 section 一层）：传 {redact:{enabled:false}} 只改那一项，
  // 其余 section 仍取默认 POLICY —— 避免测试里的局部覆盖把 kinds/quota 一起抹掉。
  const effectivePolicy = mergePolicy(POLICY, policy);
  const resolvedScope = scope ?? resolveScope({ cwd, env: process.env }).scope;
  const service = new MemoryService({
    memoHome,
    scope: resolvedScope,
    clock,
    store: store ?? new JsonlStore({ memoHome }),
    // policy 可在构造时覆盖（测试与多租户用）；默认仍是 config/policy.json 的 POLICY。
    policy: effectivePolicy,
    index: index ?? createIndex({ policy: effectivePolicy, memoHome, scope: resolvedScope, clock }),
    quota: quota ?? new QuotaPolicy({}),
    // 裁决 50：裁决器是注入点（JudgePort）。缺省 ruleJudge 确定性、无 LLM，保证 curateAuto 行为可复现。
    judge: judge ?? createJudge({ policy: effectivePolicy }),
  });
  await service._init();
  return service;
}

export class MemoryService {
  constructor({ memoHome, scope, clock, store, index, quota, judge, policy }) {
    this.memoHome = memoHome;
    /** @type {object} 生效策略（默认 config/policy.json；构造期可覆盖，裁决 53 之后新增） */
    this.policy = policy;
    this.scope = scope;
    this.clock = clock;
    this.store = store;
    this.index = index;
    this.quota = quota;
    /** @type {{name: string, decide: Function}} 裁决器（裁决 50：构造注入，不读 env） */
    this.judge = judge;
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
  async curateAuto(opts) { return maintenance.curateAuto(this, opts); }
  async compact(opts) { return maintenance.compact(this, opts); }

  // —— read-only（裁决 30：实现本就在 api/read-only.js）——
  async events(args = {}) { return queryEvents(this, args); }
  async exportRecords(args = {}) { return queryExportRecords(this, args); }

  // —— close（实现见 lifecycle）——
  async close() { return lifecycle.close(this); }
}

export { POLICY as _policy };
