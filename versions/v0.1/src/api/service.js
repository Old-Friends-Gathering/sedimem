// api/service.js — MemoryService（唯一对外 API，契约：docs/02-data-model-and-contract.md §3）
// 编排层：不含策略细节。策略来自 hygiene/* 与 config/policy.json。

import { systemClock } from '../core/clock.js';
import { queryEvents, queryExportRecords } from './read-only.js';
import { createRecord, validateRecord, withPatch } from '../core/record.js';
import { resolveScope } from '../core/scope.js';
import { JsonlStore } from '../storage/jsonl-store.js';
import { withLock } from '../storage/lock.js';
import { createIndex } from '../index/create-index.js';
import { decideWrite } from '../hygiene/write-gate.js';
import { monotonicDecay, clusterNearDuplicates } from '../hygiene/conflict.js';
import { expiryFor, isExpired } from '../hygiene/decay.js';
import { QuotaPolicy } from '../hygiene/quota.js';
import { CurateQueue } from '../hygiene/curate.js';
import { detectSuspicious } from '../hygiene/suspicious.js';
import { renderBrief } from '../render/brief.js';
import { defaultPolicy as POLICY } from '../config/policy.js';
import { maskSuspiciousRecord } from './mask.js';

function invalid(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_RECORD';
  return err;
}
function notFound(msg) {
  const err = new Error(msg);
  err.code = 'E_NOT_FOUND';
  return err;
}
function invalidArg(msg) {
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

  async _init() {
    await this._reload();
  }

  async _reload() {
    // 顺序不能反（I8 并发偶发红的根因）：先取 fileSize，再全量读。
    // 若先读后取 size，两步之间他进程追加的行会「读时没看到 + readOffset 已越过」→ 永久漏读，
    // 同一条事实随后被再判一次 created（active 出现 2 条）。反过来最多把已读过的行再增量读一次，
    // 由 _refreshIncremental 的快照相等去重兜住。
    const sizeBefore = await this.store.fileSize(this.scope);
    let records;
    try {
      records = await this.store.loadScope(this.scope);
      this._loadError = null;
    } catch (e) {
      // 任务 A（doctor 修复）：真相层损坏不在这里裸抛——记下错误、以空索引继续构造，
      // doctor() 用它产出 corrupt_jsonl issue；其余操作经 _ensureOpen() fail-loud 原样抛出。
      if (e.code === 'E_CORRUPT_JSONL') {
        this._loadError = e;
        records = [];
      } else {
        throw e;
      }
    }
    this._records = new Map();
    this._versions = new Map();
    for (const r of records) {
      this._records.set(r.id, r);
      if (!this._versions.has(r.id)) this._versions.set(r.id, []);
      this._versions.get(r.id).push(r);
    }
    this.index.build(records);
    // 以「读之前」的 size 作为消费水位：宁可重复消费已读过的行，也不能跳过未读的行
    this._readOffset = records.length === 0 && this._loadError ? 0 : sizeBefore;
    return records;
  }

  /**
   * 增量重读真相层尾部并 fold 进内存索引/_records（裁决 13）。
   * 必须在 scope 锁临界区内调用（写路径由 write() 保证）。
   */
  /**
   * 读路径刷新（裁决 39）：常驻进程不写库，_records 会冻结；只读查询前调用，按水位增量重读。
   * 并发调用共享同一在途刷新（_refreshPromise），避免重复消费同一批行。
   * @returns {Promise<object[]>} 本次新增的记录快照
   */
  async refreshView() {
    this._ensureOpen();
    if (!this._refreshPromise) {
      this._refreshPromise = (async () => {
        try {
          return await this._refreshIncremental();
        } finally {
          this._refreshPromise = null;
        }
      })();
    }
    return this._refreshPromise;
  }

  async _refreshIncremental() {
    const size = await this.store.fileSize(this.scope);
    if (size < this._readOffset) {
      // 文件变短（异常/重建）：退化为全量重载，避免漏读
      return this._reload();
    }
    if (size === this._readOffset) return [];
    const { records, nextOffset } = await this.store.loadScopeIncremental(this.scope, this._readOffset);
    this._readOffset = nextOffset;
    for (const r of records) {
      const prev = this._records.get(r.id);
      // 同一快照被重复消费（_reload 的水位回退、半行补齐等）：不能重复计入版本链/索引，
      // 否则 hits、版本数与 dupRatio 类指标会被污染
      if (prev && prev.validTo === r.validTo && prev.status === r.status
          && prev.contentHash === r.contentHash && prev.hits === r.hits) {
        continue;
      }
      this._records.set(r.id, r);
      if (!this._versions.has(r.id)) this._versions.set(r.id, []);
      this._versions.get(r.id).push(r);
      this.index.add(r);
    }
    return records;
  }

  _ensureOpen() {
    if (this._closed) {
      const err = new Error('MemoryService: already closed');
      err.code = 'E_INVALID_RECORD';
      throw err;
    }
    // 真相层损坏（任务 A）：doctor 之外的操作照旧 fail-loud（错误信息含 file:line）
    if (this._loadError && !this._inDoctor) throw this._loadError;
  }

  _nowIso() { return this.clock.now(); }

  async _event(op, id, detail) {
    const ev = { ts: this._nowIso(), op, scope: this.scope, id, detail };
    if (this._inScopeLock) await this.store.appendEventImmediate(ev);
    else await this.store.appendEvent(ev);
  }

  /** 校验并 append 一条记录快照，同时更新缓存与索引 */
  async _commit(record, op = 'write', detail = {}) {
    const v = validateRecord(record);
    if (!v.ok) throw invalid(`commit: ${v.errors.join('; ')}`);
    if (this._inScopeLock) await this.store.appendImmediate(record);
    else await this.store.append(record);
    this._records.set(record.id, record);
    if (!this._versions.has(record.id)) this._versions.set(record.id, []);
    this._versions.get(record.id).push(record);
    this.index.add(record);
    await this._event(op, record.id, detail);
    return record;
  }

  /**
   * 写入。严格按契约动作优先级：hash 命中 → 同 slot 同值 → 同 slot 异值 → created。
   * @returns {{action: string, record: MemoryRecord, supersededId?: string}}
   */
  async write(input) {
    this._ensureOpen();
    if (!input || typeof input.text !== 'string' || input.text.length === 0) {
      throw invalid('write: input.text (non-empty string) is required');
    }
    // 投毒防线：可疑输入打标（I5）——写入成功但不进 brief。
    // 检测来自 hygiene/suspicious.js（归一化 + 启发式），pattern 单一来源 POLICY.suspiciousPatterns；
    // 启发式开关 POLICY.suspiciousHeuristics（缺省全 true）。
    const tags = Array.isArray(input.tags) ? [...input.tags] : [];
    const verdict = detectSuspicious(
      input.text, POLICY.suspiciousPatterns, { heuristics: POLICY.suspiciousHeuristics },
    );
    if (verdict.suspicious && !tags.includes('suspicious')) tags.push('suspicious');

    const candidate = createRecord({
      ...input,
      tags,
      scope: this.scope,
      value: input.value ?? input.text,
      subject: input.subject ?? 'text',
      predicate: input.predicate ?? 'text',
    }, { clock: this.clock });

    // 裁决 13（阻断项）：「增量重读 → 判定 → 追加」必须在同一把 scope 锁的临界区内完成，
    // 判定不得基于进程内陈旧快照。锁内追加/事件走 store 的 Immediate（无锁）变体。
    return withLock(this.memoHome, async () => {
      this._inScopeLock = true;
      try {
        await this._refreshIncremental();

        // candidates: 同 scope 且允许参与判定的记录（active + disputed）
        const candidates = [...this._records.values()].filter(
          (r) => r.status === 'active' || r.status === 'disputed',
        );

        const gate = decideWrite(candidate, candidates, { clock: this.clock });
        if (!gate || !gate.action) throw invalid('write: decideWrite returned no action');
        const record = gate.record ?? candidate;
        const vv = validateRecord(record);
        if (!vv.ok) throw invalid(`write: gate produced invalid record: ${vv.errors.join('; ')}`);

        switch (gate.action) {
          case 'created': {
            await this._commit(record, 'write', { action: gate.action, reason: gate.reason });
            await this.enforceQuota();
            return { action: gate.action, record };
          }
          case 'noop_duplicate':
          case 'noop_same_value': {
            // 不写真相层；只写审计事件（每次写操作必返回 action —— hook 静默失败防线）
            await this._event('write', record.id, { action: gate.action, reason: gate.reason });
            return { action: gate.action, record };
          }
          case 'supersede': {
            if (!gate.superseded) throw invalid('write: supersede without superseded record');
            // 同时：新记录 + 旧记录以 status:'superseded' + validTo 追加一次新版本
            // （write-gate 返回的 superseded 是未打补丁的 peer，这里负责落补丁）
            await this._commit(record, 'write', { action: gate.action, reason: gate.reason });
            const handoff = record.validFrom ?? this._nowIso();
            const closedOld = gate.superseded.status === 'superseded' && gate.superseded.validTo
              ? gate.superseded
              : withPatch(gate.superseded, {
                  status: 'superseded',
                  validTo: gate.superseded.validTo ?? handoff,
                });
            await this._commit(closedOld, 'supersede', { reason: gate.reason, by: record.id });
            return { action: gate.action, record, supersededId: closedOld.id };
          }
          case 'disputed': {
            await this._commit(record, 'write', { action: gate.action, reason: gate.reason });
            return { action: gate.action, record };
          }
          default:
            throw invalid(`write: unknown decideWrite action ${JSON.stringify(gate.action)}`);
        }
      } finally {
        this._inScopeLock = false;
      }
    });
  }

  /**
   * 配额淘汰（裁决 20：公开整合入口，供 nightly 调用）：淘汰低价值 active →
   * 写墓碑并打 tags:['quota']，不物理删；dryRun 只返回将被淘汰的 id，不落盘。
   * 价值与上限全部来自 policy（经 QuotaPolicy），service 不留魔法数字。
   * @param {{dryRun?: boolean}} [opts]
   * @returns {Promise<string[]>} 被淘汰（或 dryRun 下将被淘汰）的记录 id
   */
  async enforceQuota({ dryRun = false } = {}) {
    this._ensureOpen();
    const max = this.quota.maxActive ?? POLICY.quota.maxActive;
    const records = [...this._records.values()].filter((r) => r.status === 'active');
    if (records.length <= max) return [];
    const evictIds = this.quota.selectEvictions(records, { max });
    const victims = evictIds
      .map((id) => this._records.get(id))
      .filter(Boolean);
    if (dryRun) return victims.map((r) => r.id);
    for (const r of victims) {
      const tags = Array.isArray(r.tags) ? [...r.tags] : [];
      if (!tags.includes('quota')) tags.push('quota');
      const tomb = withPatch(r, {
        status: 'tombstoned',
        validTo: r.validTo ?? this._nowIso(),
        tags,
      });
      await this._commit(tomb, 'evict', { reason: 'quota_exceeded' });
    }
    return victims.map((r) => r.id);
  }

  /** 写路径内部的配额淘汰（保留旧私有入口，语义同 enforceQuota） */
  async _enforceQuota() {
    return this.enforceQuota();
  }

  /**
   * 检索：bm25 × kindWeight × recencyDecay × confidence（系数全部来自 policy）。
   * asOf 按时间戳比较（裁决 17，Date.parse 归一化到 UTC ms，禁止字典序）；
   * asOf 查询不新建索引实例（裁决 18：复用主索引 + 在内存记录上过滤）；
   * suspicious 记录默认不返回正文（裁决 16，仅 includeSuspicious:true 返回原文）。
   * @param {string} query
   * @param {{limit?: number, kind?: string, asOf?: string, includeDisputed?: boolean,
   *          status?: string, includeSuspicious?: boolean}} opts
   * @returns {{items: {record: MemoryRecord, score: number}[], total: number, asOf: string}}
   */
  async search(query, {
    limit = POLICY.search.limitDefault ?? 10,
    kind, asOf, includeDisputed = false, status = 'active', includeSuspicious = false,
  } = {}) {
    this._ensureOpen();
    if (typeof query !== 'string' || query.length === 0) {
      throw invalid('search: query (non-empty string) is required');
    }
    let asOfMs = null;
    let asOfIso = null;
    if (asOf !== undefined && asOf !== null) {
      asOfMs = Date.parse(asOf);
      if (typeof asOf !== 'string' || Number.isNaN(asOfMs)) {
        throw invalidArg(`search: asOf must be an ISO-8601 string, got ${JSON.stringify(asOf)}`);
      }
      asOfIso = new Date(asOfMs).toISOString(); // 归一化到 UTC（支持 +08:00 等偏移量）
    }

    // 选出参与检索的记录
    const picked = [];
    if (asOfMs !== null) {
      // asOf 查询（裁决 17）：每个 id 取 validFrom <= asOf < validTo 的版本，按时间戳比较
      for (const versions of this._versions.values()) {
        let chosen = null;
        for (const v of versions) {
          const vf = Date.parse(String(v.validFrom ?? ''));
          if (Number.isNaN(vf) || vf > asOfMs) continue;
          const vt = v.validTo === null || v.validTo === undefined
            ? Infinity
            : Date.parse(String(v.validTo));
          if (asOfMs < vt) chosen = v;
        }
        if (chosen) picked.push(chosen);
      }
    } else {
      for (const r of this._records.values()) {
        if (!this._statusOk(r, { status, includeDisputed })) continue;
        if (isExpired(r, this.clock)) continue;
        picked.push(r);
      }
    }
    if (kind) {
      const filtered = picked.filter((r) => r.kind === kind);
      picked.length = 0;
      picked.push(...filtered);
    }

    // BM25：复用已注入的主索引 + filter 过滤（裁决 18：不新建索引实例）
    const pickedById = new Map(picked.map((r) => [r.id, r]));
    const filter = (rec) => pickedById.has(rec.id);
    const idxLimit = typeof this.index.size === 'number' ? this.index.size : undefined;
    const hits = this.index.search(query, { limit: idxLimit, filter });

    const nowMs = this.clock.nowMs();
    const halfLife = POLICY.search.recencyHalflifeMs;
    const items = [];
    for (const { id, score } of hits) {
      const rec = pickedById.get(id);
      if (!rec) continue;
      const kw = POLICY.kindWeight[rec.kind] ?? 1.0;
      const ageMs = Math.max(0, nowMs - Date.parse(rec.createdAt));
      const decay = monotonicDecay(ageMs, halfLife);
      const final = score * kw * decay * (typeof rec.confidence === 'number' ? rec.confidence : 0.8);
      if (final > 0) items.push({ record: rec, score: final });
    }
    items.sort((a, b) => b.score - a.score);
    const top = items.slice(0, limit);

    // hits 只增：召回一次记一次（内存累加，flushHits 时一次性落盘，避免检索写盘刷快照）
    if (asOfMs === null) {
      for (const { record } of top) {
        this._extraHits.set(record.id, (this._extraHits.get(record.id) ?? 0) + 1);
      }
    }
    return {
      items: top.map((it) => ({ ...it, record: this._withExtraHits(this._maskSuspicious(it.record, includeSuspicious)) })),
      total: items.length,
      asOf: asOfIso ?? this._nowIso(),
    };
  }

  /** 裁决 16/42：遮蔽实现见 api/mask.js（四个正文字段一起遮，避免 payload 换字段绕过） */
  _maskSuspicious(r, includeSuspicious) {
    return maskSuspiciousRecord(r, includeSuspicious);
  }

  _withExtraHits(r) {
    const extra = this._extraHits.get(r.id);
    return extra ? { ...r, hits: (r.hits ?? 0) + extra } : r;
  }

  /**
   * 把内存中累计的 hits 增量作为新版本快照（v+1）追加落盘，并清空增量。hits 只增。
   * 裁决 21：不得吞错——落盘失败时先恢复未落盘的计数再原样抛出（增量不丢）。
   */
  async flushHits() {
    this._ensureOpen();
    const entries = [...this._extraHits.entries()];
    this._extraHits = new Map();
    const committed = new Set();
    try {
      for (const [id, extra] of entries) {
        const rec = this._records.get(id);
        if (!rec) continue;
        const bumped = withPatch(rec, { hits: (rec.hits ?? 0) + extra });
        const v = validateRecord(bumped);
        if (v.ok) await this._commit(bumped, 'hit', { flushed: extra });
        committed.add(id);
      }
    } catch (e) {
      // 失败恢复计数（只恢复未成功落盘的），再抛
      for (const [id, extra] of entries) {
        if (committed.has(id)) continue;
        const rec = this._records.get(id);
        if (rec) this._extraHits.set(id, (this._extraHits.get(id) ?? 0) + extra);
      }
      throw e;
    }
    return { flushed: entries.length };
  }

  _statusOk(r, { status, includeDisputed }) {
    if (includeDisputed && r.status === 'disputed') return true;
    return r.status === status;
  }

  /** @returns {MemoryRecord|null}（suspicious 默认遮蔽正文，裁决 16） */
  async get(id, { includeSuspicious = false } = {}) {
    this._ensureOpen();
    const r = this._records.get(id);
    return r ? this._withExtraHits(this._maskSuspicious(r, includeSuspicious)) : null;
  }

  /** 确定性 brief：pinned/decision 优先 → 最近 active 事实；suspicious 不进 brief。
   *  裁决 23：末节追加待裁决去重候选数（dedupeCandidates 显式传入则不再现算）。 */
  async brief({ lines = 80, dedupeCandidates } = {}) {
    this._ensureOpen();
    const records = [...this._records.values()].filter(
      (r) => r.status === 'active' && r.validTo === null
        && !isExpired(r, this.clock)
        && !(Array.isArray(r.tags) && r.tags.includes('suspicious')),
    );
    let candidates = dedupeCandidates;
    if (candidates === undefined) {
      const scan = await this.dedupeScan({ limit: 1 });
      candidates = scan.totalClusters;
    }
    return renderBrief({
      scope: this.scope, records, lines, clock: this.clock, dedupeCandidates: candidates,
    });
  }

  /** 人工 supersede：新记录 + 旧记录追加 superseded 版本 */
  async supersede({ oldId, value, text, source, reason }) {
    this._ensureOpen();
    const old = this._records.get(oldId);
    if (!old) throw notFound(`supersede: record ${oldId} not found`);
    const body = text ?? value;
    const record = createRecord({
      text: body,
      value: value ?? old.value,
      subject: old.subject,
      predicate: old.predicate,
      kind: old.kind,
      scope: this.scope,
      source: source ?? old.source,
      confidence: old.confidence,
      tags: old.tags,
      privacy: old.privacy,
      supersedes: oldId,
    }, { clock: this.clock });
    await this._commit(record, 'write', { action: 'supersede', reason: reason ?? 'manual' });
    const closed = withPatch(old, { status: 'superseded', validTo: this._nowIso() });
    await this._commit(closed, 'supersede', { reason: reason ?? 'manual', by: record.id });
    return { record };
  }

  /** 删除：v0.1 只写墓碑（mode='purge' 同样落地为 tombstone，物理删留给整合期） */
  async forget({ id, mode = 'tombstone', reason }) {
    this._ensureOpen();
    const rec = this._records.get(id);
    if (!rec) throw notFound(`forget: record ${id} not found`);
    const tomb = withPatch(rec, {
      status: 'tombstoned',
      validTo: rec.validTo ?? this._nowIso(),
    });
    await this._commit(tomb, 'forget', { mode, reason: reason ?? null });
    return { id, status: 'tombstoned' };
  }

  async stats() {
    this._ensureOpen();
    const all = [...this._records.values()];
    const counts = { active: 0, superseded: 0, disputed: 0, tombstoned: 0 };
    for (const r of all) if (counts[r.status] !== undefined) counts[r.status]++;

    const active = all.filter((r) => r.status === 'active' && r.validTo === null && !isExpired(r, this.clock));
    const totalActive = active.length;
    const uniqueHashes = new Set(active.map((r) => r.contentHash)).size;
    const dupRatio = totalActive === 0 ? 0 : 1 - uniqueHashes / totalActive;

    // conflictRate = disputedPairs / pairsSharingSameSlot（分母 0 → 0）
    const slots = new Map(); // key -> {records, hasDisputed}
    for (const r of all) {
      if (r.status === 'tombstoned') continue;
      const key = `${r.scope}\u0001${r.subject}\u0001${r.predicate}`;
      const s = slots.get(key) ?? { records: 0, hasDisputed: false };
      s.records += 1;
      if (r.status === 'disputed') s.hasDisputed = true;
      slots.set(key, s);
    }
    let pairsSharingSameSlot = 0;
    let disputedPairs = 0;
    for (const s of slots.values()) {
      if (s.records >= 2) {
        pairsSharingSameSlot += 1;
        if (s.hasDisputed) disputedPairs += 1;
      }
    }
    const conflictRate = pairsSharingSameSlot === 0 ? 0 : disputedPairs / pairsSharingSameSlot;
    const avgHits = all.length === 0 ? 0 : all.reduce((a, r) => a + (r.hits ?? 0), 0) / all.length;

    return {
      scope: this.scope,
      total: all.length,
      active: counts.active,
      superseded: counts.superseded,
      disputed: counts.disputed,
      tombstoned: counts.tombstoned,
      dupRatio: Math.round(dupRatio * 1e6) / 1e6,
      conflictRate: Math.round(conflictRate * 1e6) / 1e6,
      avgHits: Math.round(avgHits * 1e6) / 1e6,
    };
  }

  /** 只读真相层重建索引，绝不写 items */
  async reindex() {
    this._ensureOpen();
    const records = await this._reload();
    return { rebuilt: records.length };
  }

  /** 任务 A：从 store 的 E_CORRUPT_JSONL 错误信息里解析 file(:line)。
   *  已知格式：`... at <file>:<line>: ...` / `... at <file>:<line>` /
   *  `... at <file> (offset N, chunk line M): ...`（增量读无绝对行号 → line:null） */
  _parseCorruptLocation(message) {
    const m = String(message).match(/at (\S+?\.jsonl)(?::(\d+))?(?: \(offset \d+(?:, chunk line \d+)?\))?/);
    if (!m) return { file: null, line: null };
    return { file: m[1], line: m[2] !== undefined ? Number(m[2]) : null };
  }

  _corruptIssue(code, e) {
    const { file, line } = this._parseCorruptLocation(e.message);
    return {
      code, severity: 'error', file, line, message: e.message,
      detail: e.message,
    };
  }

  async doctor() {
    this._inDoctor = true; // 必须先于 _ensureOpen：容忍已记录的真相层损坏
    this._ensureOpen();
    try {
      const issues = [];
      // 1. 真相层可解析（任务 A：损坏转结构化 issue，含 file/line，绝不裸抛）
      if (this._loadError) {
        issues.push(this._corruptIssue('corrupt_jsonl', this._loadError));
      } else {
        try {
          await this.store.loadScope(this.scope);
        } catch (e) {
          issues.push(e.code === 'E_CORRUPT_JSONL'
            ? this._corruptIssue('corrupt_jsonl', e)
            : { code: 'store_error', severity: 'error', file: null, line: null, message: e.message, detail: e.message });
        }
      }
      // 2. 索引一致性（裁决 18：用 index.size 比较；实现未暴露 size 则跳过，不假阳性）
      if (typeof this.index.size === 'number' && this.index.size !== this._records.size) {
        issues.push({ code: 'index_inconsistent', severity: 'error', detail: `index=${this.index.size} records=${this._records.size}` });
      }
      // 2b. 未落盘 hits（裁决 21：flush 失败/未 close 时以 warn 呈现）
      if (this._extraHits.size > 0) {
        issues.push({
          code: 'hits_unflushed',
          severity: 'warn',
          detail: `${this._extraHits.size} record(s) with unflushed hit counters`,
        });
      }
      // 2c. 重复 contentHash（任务 B：并发脏库的兜底信号——同 hash 多条 active 记录）
      const byHash = new Map();
      for (const r of this._records.values()) {
        if (r.status !== 'active' || r.validTo !== null || !r.contentHash) continue;
        if (!byHash.has(r.contentHash)) byHash.set(r.contentHash, []);
        byHash.get(r.contentHash).push(r.id);
      }
      for (const [hash, ids] of byHash) {
        if (ids.length < 2) continue;
        issues.push({
          code: 'duplicate_content_hash',
          severity: 'warn',
          count: ids.length,
          ids: ids.slice(0, 5),
          detail: `contentHash ${hash} 出现在 ${ids.length} 条 active 记录: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ' …' : ''}`,
        });
      }
      // 3. 配额：达到上限（>=）即报 warn；发生过配额淘汰（quota 墓碑）也报 —— I6
      const activeNow = [...this._records.values()].filter((r) => r.status === 'active' && r.validTo === null).length;
      const maxActive = this.quota.maxActive ?? POLICY.quota.maxActive;
      const quotaEvicted = [...this._records.values()]
        .some((r) => r.status === 'tombstoned' && Array.isArray(r.tags) && r.tags.includes('quota'));
      if (activeNow >= maxActive || quotaEvicted) {
        issues.push({
          code: 'quota_exceeded',
          severity: 'warn',
          detail: `active=${activeNow} max=${maxActive}${quotaEvicted ? ' (quota evictions present)' : ''}`,
        });
      }
      // 4. 事件流可解析
      try { await this.store.readEvents({ limit: 1 }); }
      catch (e) {
        issues.push(e.code === 'E_CORRUPT_JSONL'
          ? this._corruptIssue('corrupt_events', e)
          : { code: 'events_error', severity: 'error', detail: e.message });
      }
      return { ok: !issues.some((i) => i.severity === 'error'), issues };
    } finally {
      this._inDoctor = false;
    }
  }

  /** 裁决导出：把 disputed 对交给 curate 队列；无候选返回 null */
  async curateExport({ limit = 20 } = {}) {
    this._ensureOpen();
    const disputed = [...this._records.values()].filter((r) => r.status === 'disputed');
    if (disputed.length === 0) return null;
    const pairs = [];
    for (const d of disputed) {
      const prev = [...this._records.values()]
        .filter((r) => r.id !== d.id && r.subject === d.subject && r.predicate === d.predicate && r.scope === d.scope && r.status === 'active')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (prev) pairs.push({ a: prev, b: d, reason: 'same-slot conflict, values not comparable' });
    }
    if (pairs.length === 0) return null;
    return this.queue.exportBatch(pairs, { limit });
  }

  /**
   * 应用裁决并把结果真正落到真相层（append-only，非破坏：败者 superseded，真相层保留）：
   * - a_wins：b → superseded(validTo=now)；a → active(validTo=null, confidence=max(a,b))
   * - b_wins：镜像（a → superseded；b → active）
   * - merge：v0.1 按 a_wins 处理，a 额外打 tag 'merged'（契约未定义 merge 语义，此处为 v0.1 裁决）
   * - keep_both：a、b 均 → active，b 额外打 tag 'coexist'
   * 每条裁决写 events.jsonl（op='curate_apply'）。同一批重复 apply 幂等（applied:false）。
   *
   * 裁决 23 补充：decisions 条目支持 `{ids:[idA, idB, ...], decision, note}` 形状
   * （由 dedupeScan 簇的 item id 驱动，向后兼容 pairIndex 形状）：
   * - a_wins/merge：ids[0] 为胜者，其余全部 superseded（败者打 tag 'merged'）
   * - b_wins：ids[1] 为胜者，其余（含 ids[0]）superseded
   * - keep_both：全部 → active，非首位打 tag 'coexist'
   * ids 形状幂等：所有败者已 superseded 且带对应 tag → applied:false。
   * @param {{batchId?: string, decisions: ({pairIndex: number, decision: string, note?: string}|
   *          {ids: string[], decision: string, note?: string})[]}} args
   * @returns {Promise<{applied: {pairIndex?: number, ids?: string[], applied: boolean,
   *          decision?: string, newRecord: object|null}[]}>}
   */
  async curateApply({ batchId, decisions } = {}) {
    this._ensureOpen();
    if (!Array.isArray(decisions) || decisions.length === 0) {
      throw invalidArg('curateApply: decisions (non-empty array) is required');
    }
    const DECISIONS = new Set(['a_wins', 'b_wins', 'merge', 'keep_both']);
    const idShaped = [];
    const pairShaped = [];
    for (const d of decisions) {
      if (!d || !DECISIONS.has(d.decision)) {
        throw invalidArg(`curateApply: decision must be one of ${[...DECISIONS].join('|')}, got ${JSON.stringify(d?.decision)}`);
      }
      (Array.isArray(d.ids) ? idShaped : pairShaped).push(d);
    }

    const out = [];
    // —— pairIndex 形状（原语义，走 curate 队列批次）——
    if (pairShaped.length > 0) {
      if (!batchId) throw notFound('curateApply: batchId required for pairIndex-shaped decisions');
      const batch = await this.queue.readBatch(batchId);
      const results = await this.queue.applyDecisions(batch, pairShaped);
      for (const res of results) {
        if (!res.applied) {
          out.push({ pairIndex: res.pairIndex, applied: false, newRecord: null });
          continue;
        }
        const pair = batch.pairs[res.pairIndex];
        // 优先取缓存里的最新版本（批导出后可能有新快照）
        const a = this._records.get(pair.a.id) ?? pair.a;
        const b = this._records.get(pair.b.id) ?? pair.b;
        const newRecord = await this._commitPairVerdict(a, b, res.decision, { batchId, pairIndex: res.pairIndex });
        out.push({ pairIndex: res.pairIndex, applied: true, decision: res.decision, newRecord });
      }
    }

    // —— ids 形状（裁决 23：dedupeScan item id -> decision，直接对真相层记录落盘）——
    for (const d of idShaped) out.push(await this._applyIdsDecision(d));
    return { applied: out };
  }

  /** pairIndex 路径的落盘（原 curateApply 主体，抽出复用；非破坏） */
  async _commitPairVerdict(a, b, d, detail) {
    const now = this._nowIso();
    const maxConf = Math.max(a.confidence ?? 0, b.confidence ?? 0);
    let newRecord = null;
    if (d === 'a_wins' || d === 'merge') {
      const winnerTags = d === 'merge' && !(a.tags ?? []).includes('merged')
        ? [...(a.tags ?? []), 'merged'] : a.tags;
      const loser = withPatch(b, { status: 'superseded', validTo: b.validTo ?? now });
      newRecord = withPatch(a, {
        status: 'active', validTo: null, confidence: maxConf, tags: winnerTags,
      });
      await this._commit(loser, 'curate_apply', { ...detail, decision: d, side: 'loser' });
      await this._commit(newRecord, 'curate_apply', { ...detail, decision: d, side: 'winner' });
    } else if (d === 'b_wins') {
      const loser = withPatch(a, { status: 'superseded', validTo: a.validTo ?? now });
      newRecord = withPatch(b, { status: 'active', validTo: null, confidence: maxConf });
      await this._commit(loser, 'curate_apply', { ...detail, decision: d, side: 'loser' });
      await this._commit(newRecord, 'curate_apply', { ...detail, decision: d, side: 'winner' });
    } else { // keep_both
      const bTags = (b.tags ?? []).includes('coexist') ? b.tags : [...(b.tags ?? []), 'coexist'];
      const aNew = withPatch(a, { status: 'active', validTo: null });
      const bNew = withPatch(b, { status: 'active', validTo: null, tags: bTags });
      await this._commit(aNew, 'curate_apply', { ...detail, decision: d, side: 'a' });
      await this._commit(bNew, 'curate_apply', { ...detail, decision: d, side: 'b' });
      newRecord = aNew;
    }
    return newRecord;
  }

  /** ids 形状裁决落盘（裁决 23）：ids[0]=a、ids[1]=b（更多 id 视为同簇其余败者/共存者） */
  async _applyIdsDecision(d) {
    const ids = [...new Set(d.ids.map((x) => String(x)))];
    if (ids.length < 2) {
      throw invalidArg(`curateApply: ids-shaped decision needs >= 2 distinct ids, got ${JSON.stringify(d.ids)}`);
    }
    const recs = ids.map((id) => {
      const r = this._records.get(id);
      if (!r) throw notFound(`curateApply: record ${id} not found`);
      return r;
    });
    const decision = d.decision;
    const loserTag = decision === 'keep_both' ? 'coexist' : 'merged';
    const winnerIdx = decision === 'b_wins' ? 1 : 0;
    const losers = recs.filter((_, i) => (decision === 'keep_both' ? false : i !== winnerIdx));

    // 幂等：keep_both → 全员已 active 且非首位带 coexist；其余 → 所有败者已 superseded
    // 且带对应 tag、胜者已 active → applied:false
    const alreadyApplied = decision === 'keep_both'
      ? recs.every((r, i) => r.status === 'active' && (i === 0 || (r.tags ?? []).includes('coexist')))
      : losers.every((r) => r.status === 'superseded' && (r.tags ?? []).includes(loserTag))
        && recs[winnerIdx].status === 'active';
    if (alreadyApplied) {
      return { ids, applied: false, decision, newRecord: null };
    }

    const now = this._nowIso();
    const maxConf = Math.max(...recs.map((r) => r.confidence ?? 0));
    const detail = { via: 'dedupe_ids', decision, ids, note: d.note ?? null };
    let newRecord = null;
    if (decision === 'keep_both') {
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        const tags = i > 0 && !(r.tags ?? []).includes('coexist')
          ? [...(r.tags ?? []), 'coexist'] : r.tags;
        const patched = withPatch(r, { status: 'active', validTo: null, tags });
        await this._commit(patched, 'curate_apply', { ...detail, side: `item${i}` });
        if (i === 0) newRecord = patched;
      }
    } else {
      for (const loser of losers) {
        const tags = !(loser.tags ?? []).includes(loserTag) ? [...(loser.tags ?? []), loserTag] : loser.tags;
        const patched = withPatch(loser, { status: 'superseded', validTo: loser.validTo ?? now, tags });
        await this._commit(patched, 'curate_apply', { ...detail, side: 'loser' });
      }
      const winner = recs[winnerIdx];
      const wTags = decision === 'merge' && !(winner.tags ?? []).includes('merged')
        ? [...(winner.tags ?? []), 'merged'] : winner.tags;
      newRecord = withPatch(winner, { status: 'active', validTo: null, confidence: maxConf, tags: wTags });
      await this._commit(newRecord, 'curate_apply', { ...detail, side: 'winner' });
    }
    return { ids, applied: true, decision, newRecord };
  }

  /**
   * 裁决 22：去重候选扫描（只读、确定性、内存 records 上跑，不新建索引实例）。
   * 分簇：slot 分组（text/text → unstructured 超组，组内不设 slot 门槛）→ 组内
   * containment ≥ threshold 的并查集聚簇。倒排 token 桶取候选（threshold>0 时
   * 共享 token 是合格对的必要条件，故桶召回完备）；桶无剪枝价值时退全比较（mode:'exact'）。
   * @param {{threshold?: number, limit?: number}} [opts]
   * @returns {Promise<{clusters: {key: string, size: number, maxSimilarity: number,
   *    items: {id: string, text: string, kind: string, validFrom: string, hits: number, status: string}[]}[],
   *    totalClusters: number, scanned: number, threshold: number, mode: 'bucket'|'exact'}>}
   */
  async dedupeScan({
    threshold = POLICY.dedupe?.scanThreshold ?? 0.45,
    diceThreshold = POLICY.dedupe?.scanDiceThreshold ?? 0.15,
    limit = 50,
  } = {}) {
    this._ensureOpen();
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw invalidArg(`dedupeScan: threshold must be in (0,1], got ${JSON.stringify(threshold)}`);
    }
    if (typeof diceThreshold !== 'number' || !Number.isFinite(diceThreshold) || diceThreshold <= 0 || diceThreshold > 1) {
      throw invalidArg(`dedupeScan: diceThreshold must be in (0,1], got ${JSON.stringify(diceThreshold)}`);
    }
    if (!Number.isInteger(limit) || limit < 0) {
      throw invalidArg(`dedupeScan: limit must be a non-negative integer, got ${JSON.stringify(limit)}`);
    }
    const records = [...this._records.values()].filter(
      (r) => (r.status === 'active' || r.status === 'disputed')
        && r.validTo === null
        && !isExpired(r, this.clock),
    );
    const { clusters, mode } = clusterNearDuplicates(records, { threshold, diceThreshold });
    const totalClusters = clusters.length;
    const top = clusters.slice(0, limit).map((c) => ({
      key: c.key,
      size: c.size,
      maxSimilarity: c.maxSimilarity,
      basis: c.basis,
      metrics: c.metrics,
      pairs: c.pairs,
      items: [...c.items]
        .sort((a, b) => {
          const va = String(a.validFrom ?? '');
          const vb = String(b.validFrom ?? '');
          if (va !== vb) return va < vb ? -1 : 1;
          return String(a.id) < String(b.id) ? -1 : 1;
        })
        .map((r) => ({
          id: r.id,
          text: r.text,
          kind: r.kind,
          validFrom: r.validFrom,
          hits: r.hits ?? 0,
          status: r.status,
        })),
    }));
    return { clusters: top, totalClusters, scanned: records.length, threshold, diceThreshold, mode };
  }

  /** 裁决 30：只读事件查询（实现搬到 api/read-only.js，Q2 行数预算） */
  async events(args = {}) {
    return queryEvents(this, args);
  }

  /** 裁决 30：只读记录导出（实现搬到 api/read-only.js） */
  async exportRecords(args = {}) {
    return queryExportRecords(this, args);
  }

  /** 裁决 21：close 不吞错——flushHits 失败原样上抛（hits 增量已在 flushHits 内恢复） */
  async close() {
    try {
      if (!this._closed) await this.flushHits();
    } finally {
      this._closed = true;
    }
  }
}

export { POLICY as _policy };
