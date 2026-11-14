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
import { createLlmPort } from '../llm/port.js';
import { loadDerived, appendDerived } from '../llm/derived-store.js';
import { enqueueDerive, claimBatch, completeItem } from '../llm/outbox.js';
import { applyDerivation } from '../llm/derive.js';


// 错误工厂已上移到 core/errors.js（切断承接模块的反向 import 环）；
// 这里直接 re-export（不要先 import 再 export，否则 CodeQL 会把它们当未使用导入）。
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
 * 构造 LLM 端口：失败时降级为 null（调用方按 no-provider 处理），绝不阻断服务启动。
 * 端口自身的构造期校验（egress 冲突、非法端点）在这里被捕获并记入 reason，由 doctor 暴露。
 * @param {{policy?: object, memoHome: string, clock: object}} args
 */
function parseLlmPort({ policy, memoHome, clock }) {
  try {
    return createLlmPort({ policy: withLlmEnvOverrides(policy), memoHome, clock });
  } catch (err) {
    return { name: 'none', model: null, ready: false, reason: err?.code ?? 'E_LLM_INIT', complete: async () => ({ ok: false, error: { code: 'E_LLM_UNAVAILABLE', message: String(err?.message ?? err) } }) };
  }
}

/**
 * 用环境变量覆盖 policy.llm（不把任何密钥写进仓库）。
 *
 * 为什么需要：MCP server 由宿主以 stdio 子进程拉起，必须能在「不改仓库里的 policy.json」
 * 的前提下开启 LLM —— 否则要么把 key 写进版本库，要么每次改配置都提一个 PR。
 * 支持：MEMO_LLM_PROVIDER / MEMO_LLM_EGRESS / MEMO_LLM_BASE_URL / MEMO_LLM_MODEL /
 *       MEMO_LLM_API_KEY / MEMO_LLM_API_KEY_FILE / MEMO_LLM_DAILY_CNY
 */
function withLlmEnvOverrides(policy) {
  const env = typeof process !== 'undefined' ? process.env ?? {} : {};
  const pick = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  const provider = pick('MEMO_LLM_PROVIDER');
  const egress = pick('MEMO_LLM_EGRESS');
  const baseUrl = pick('MEMO_LLM_BASE_URL');
  const model = pick('MEMO_LLM_MODEL');
  const apiKey = pick('MEMO_LLM_API_KEY');
  const apiKeyFile = pick('MEMO_LLM_API_KEY_FILE');
  const daily = pick('MEMO_LLM_DAILY_CNY');
  if (!provider && !egress && !baseUrl && !model && !apiKey && !apiKeyFile && !daily) return policy;
  const llm = { ...(policy?.llm ?? {}) };
  if (provider) llm.provider = provider;
  if (egress) llm.egress = egress;
  if (baseUrl) llm.baseUrl = baseUrl;
  if (model) llm.model = model;
  if (apiKey) llm.apiKey = apiKey;
  if (apiKeyFile) llm.apiKeyFile = apiKeyFile;
  if (daily && Number.isFinite(Number(daily))) llm.dailyLimitCny = Number(daily);
  // provider 从 none 切到真实实现时，egress 必须一起放开，否则端口构造期就会拒绝
  if (llm.provider && llm.provider !== 'none' && (!llm.egress || llm.egress === 'local-only')) {
    llm.egress = 'egress-allowed';
  }
  return { ...(policy ?? {}), llm };
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
  store, index, quota, judge, policy, llmPort,
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
    // W3：LLM 端口注入点（测试可传假端口；缺省按 policy.llm 构造）
    llmPort,
  });
  await service._init();
  return service;
}

export class MemoryService {
  constructor({ memoHome, scope, clock, store, index, quota, judge, policy, llmPort }) {
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
    // —— LLM 总结层（v1.0 W3，裁决 83–88）——
    // 端口永不为 null：provider=none 时 ready=false，派生降级为 no-provider，写入路径完全不受影响。
    // 可注入端口（测试 / 多租户）；不传则按 policy.llm 构造，provider=none 时 ready=false
    this.llmPort = llmPort ?? parseLlmPort({ policy, memoHome, clock });
    /** @type {Map<string, object>} 派生 sidecar 缓存（键 `${id}@${validFrom}`） */
    this._derived = new Map();
    this._derivedLoaded = false;
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

  // —— LLM 派生层（v1.0 W3）——
  /** 惰性加载派生 sidecar（只读投影，不影响真相层） */
  async derivedFor(id, validFrom) {
    await this._loadDerived();
    return this._derived.get(`${id}@${validFrom}`) ?? null;
  }
  async _loadDerived() {
    if (this._derivedLoaded) return this._derived;
    this._derived = await loadDerived({ memoHome: this.memoHome, scope: this.scope });
    this._derivedLoaded = true;
    return this._derived;
  }
  /** 重建派生 sidecar：只做去重/原子重写（不调 LLM、不改真相层） */
  /**
   * 全量重建派生层：把所有 active 记录重新入队并排空。
   *
   * 注意：这不是「压缩 sidecar 文件」——那只是 compaction。真重建必须重新调 LLM，
   * 否则改了 prompt 版本或换了模型之后，旧标题会一直留在库里（v1.0.1 修的就是这个：
   * 旧实现把 existing derived 当入参，等于什么都没重建）。
   */
  async rebuildDerived({ maxRounds = 200, batch = 10 } = {}) {
    await this._loadDerived();
    const active = [...this._records.values()].filter((r) => r.status === 'active');
    let enqueued = 0;
    for (const r of active) {
      const res = await enqueueDerive({ memoHome: this.memoHome, scope: this.scope, id: r.id, validFrom: r.validFrom });
      if (res?.enqueued) enqueued += 1;
    }
    let ok = 0; let failed = 0; let skipped = 0; let rounds = 0;
    for (;;) {
      if (rounds >= maxRounds) break;
      const drained = await this.drainDerive({ limit: batch });
      ok += drained.ok ?? 0; failed += drained.failed ?? 0; skipped += drained.skipped ?? 0;
      rounds += 1;
      if ((drained.claimed ?? 0) === 0) break;
    }
    this._derivedLoaded = false;
    await this._loadDerived();
    return { scope: this.scope, active: active.length, enqueued, ok, failed, skipped, rounds };
  }
  /** 写成功后入队（只 append outbox，不做 LLM —— 裁决 84） */
  async enqueueDeriveFor(record) {
    if (!record || typeof record.id !== 'string') return { enqueued: false };
    return enqueueDerive({
      memoHome: this.memoHome, scope: this.scope, id: record.id, validFrom: record.validFrom,
    });
  }
  /** 排空一批（可被 CLI / MCP 空闲 / nightly 调用）；单条失败不影响整批 */
  async drainDerive({ limit = 5 } = {}) {
    const claimed = await claimBatch({ memoHome: this.memoHome, scope: this.scope, limit, clock: this.clock });
    const batch = Array.isArray(claimed) ? claimed : (claimed?.items ?? []);
    const out = { claimed: batch.length, ok: 0, failed: 0, skipped: 0 };
    for (const item of batch) {
      const versions = this._versions.get(item.id) ?? [];
      const record = versions.find((r) => r.validFrom === item.validFrom) ?? null;
      if (!record) {
        await completeItem({ memoHome: this.memoHome, scope: this.scope, id: item.id, validFrom: item.validFrom, ok: false });
        out.skipped += 1;
        continue;
      }
      const derived = await applyDerivation({
        port: this.llmPort,
        record,
        promptVersion: this.policy?.derive?.promptVersion ?? 'd1-v1',
        clock: this.clock,
      });
      await appendDerived({ memoHome: this.memoHome, scope: this.scope, record: derived });
      const ok = derived.deriveStatus === 'ok';
      await completeItem({ memoHome: this.memoHome, scope: this.scope, id: item.id, validFrom: item.validFrom, ok });
      this._derived.set(`${item.id}@${item.validFrom}`, derived);
      this._derivedLoaded = true;
      if (ok) out.ok += 1; else out.failed += 1;
    }
    return out;
  }

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
