// api/maintenance.js — 维护路径承接模块（车道 A，issue #32）
// stats/reindex/doctor/curate*/dedupeScan 的原方法体搬到此，this → svc，语义零改动。
// 注意（施工图 §3）：波次 2 的 C/D 车道会在本文件「末尾追加 curateAuto 段」与
// 「stats/doctor 之后插 compact 段」，因此这里不得重排既有函数顺序。

import { withPatch } from '../core/record.js';
import { clusterNearDuplicates } from '../hygiene/conflict.js';
import { isExpired } from '../hygiene/decay.js';
import { defaultPolicy as POLICY } from '../config/policy.js';
// 错误工厂从 service.js 反向引用（错误文本被测试断言，必须单一来源）。
import { invalidArg, notFound } from './service.js';

export async function stats(svc) {
  svc._ensureOpen();
  const all = [...svc._records.values()];
  const counts = { active: 0, superseded: 0, disputed: 0, tombstoned: 0 };
  for (const r of all) if (counts[r.status] !== undefined) counts[r.status]++;

  const active = all.filter((r) => r.status === 'active' && r.validTo === null && !isExpired(r, svc.clock));
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
    scope: svc.scope,
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
export async function reindex(svc) {
  svc._ensureOpen();
  const records = await svc._reload();
  return { rebuilt: records.length };
}

/** 任务 A：从 store 的 E_CORRUPT_JSONL 错误信息里解析 file(:line)。
 *  已知格式：`... at <file>:<line>: ...` / `... at <file>:<line>` /
 *  `... at <file> (offset N, chunk line M): ...`（增量读无绝对行号 → line:null） */
export function parseCorruptLocation(svc, message) {
  const m = String(message).match(/at (\S+?\.jsonl)(?::(\d+))?(?: \(offset \d+(?:, chunk line \d+)?\))?/);
  if (!m) return { file: null, line: null };
  return { file: m[1], line: m[2] !== undefined ? Number(m[2]) : null };
}

export function corruptIssue(svc, code, e) {
  const { file, line } = parseCorruptLocation(svc, e.message);
  return {
    code, severity: 'error', file, line, message: e.message,
    detail: e.message,
  };
}

export async function doctor(svc) {
  svc._inDoctor = true; // 必须先于 _ensureOpen：容忍已记录的真相层损坏
  svc._ensureOpen();
  try {
    const issues = [];
    // 1. 真相层可解析（任务 A：损坏转结构化 issue，含 file/line，绝不裸抛）
    if (svc._loadError) {
      issues.push(corruptIssue(svc, 'corrupt_jsonl', svc._loadError));
    } else {
      try {
        await svc.store.loadScope(svc.scope);
      } catch (e) {
        issues.push(e.code === 'E_CORRUPT_JSONL'
          ? corruptIssue(svc, 'corrupt_jsonl', e)
          : { code: 'store_error', severity: 'error', file: null, line: null, message: e.message, detail: e.message });
      }
    }
    // 2. 索引一致性（裁决 18：用 index.size 比较；实现未暴露 size 则跳过，不假阳性）
    if (typeof svc.index.size === 'number' && svc.index.size !== svc._records.size) {
      issues.push({ code: 'index_inconsistent', severity: 'error', detail: `index=${svc.index.size} records=${svc._records.size}` });
    }
    // 2b. 未落盘 hits（裁决 21：flush 失败/未 close 时以 warn 呈现）
    if (svc._extraHits.size > 0) {
      issues.push({
        code: 'hits_unflushed',
        severity: 'warn',
        detail: `${svc._extraHits.size} record(s) with unflushed hit counters`,
      });
    }
    // 2c. 重复 contentHash（任务 B：并发脏库的兜底信号——同 hash 多条 active 记录）
    const byHash = new Map();
    for (const r of svc._records.values()) {
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
    const activeNow = [...svc._records.values()].filter((r) => r.status === 'active' && r.validTo === null).length;
    const maxActive = svc.quota.maxActive ?? POLICY.quota.maxActive;
    const quotaEvicted = [...svc._records.values()]
      .some((r) => r.status === 'tombstoned' && Array.isArray(r.tags) && r.tags.includes('quota'));
    if (activeNow >= maxActive || quotaEvicted) {
      issues.push({
        code: 'quota_exceeded',
        severity: 'warn',
        detail: `active=${activeNow} max=${maxActive}${quotaEvicted ? ' (quota evictions present)' : ''}`,
      });
    }
    // 4. 事件流可解析
    try { await svc.store.readEvents({ limit: 1 }); }
    catch (e) {
      issues.push(e.code === 'E_CORRUPT_JSONL'
        ? corruptIssue(svc, 'corrupt_events', e)
        : { code: 'events_error', severity: 'error', detail: e.message });
    }
    return { ok: !issues.some((i) => i.severity === 'error'), issues };
  } finally {
    svc._inDoctor = false;
  }
}

/** 裁决导出：把 disputed 对交给 curate 队列；无候选返回 null */
export async function curateExport(svc, { limit = 20 } = {}) {
  svc._ensureOpen();
  const disputed = [...svc._records.values()].filter((r) => r.status === 'disputed');
  if (disputed.length === 0) return null;
  const pairs = [];
  for (const d of disputed) {
    const prev = [...svc._records.values()]
      .filter((r) => r.id !== d.id && r.subject === d.subject && r.predicate === d.predicate && r.scope === d.scope && r.status === 'active')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (prev) pairs.push({ a: prev, b: d, reason: 'same-slot conflict, values not comparable' });
  }
  if (pairs.length === 0) return null;
  return svc.queue.exportBatch(pairs, { limit });
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
export async function curateApply(svc, { batchId, decisions } = {}) {
  svc._ensureOpen();
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
    const batch = await svc.queue.readBatch(batchId);
    const results = await svc.queue.applyDecisions(batch, pairShaped);
    for (const res of results) {
      if (!res.applied) {
        out.push({ pairIndex: res.pairIndex, applied: false, newRecord: null });
        continue;
      }
      const pair = batch.pairs[res.pairIndex];
      // 优先取缓存里的最新版本（批导出后可能有新快照）
      const a = svc._records.get(pair.a.id) ?? pair.a;
      const b = svc._records.get(pair.b.id) ?? pair.b;
      const newRecord = await commitPairVerdict(svc, a, b, res.decision, { batchId, pairIndex: res.pairIndex });
      out.push({ pairIndex: res.pairIndex, applied: true, decision: res.decision, newRecord });
    }
  }

  // —— ids 形状（裁决 23：dedupeScan item id -> decision，直接对真相层记录落盘）——
  for (const d of idShaped) out.push(await applyIdsDecision(svc, d));
  return { applied: out };
}

/** pairIndex 路径的落盘（原 curateApply 主体，抽出复用；非破坏） */
export async function commitPairVerdict(svc, a, b, d, detail) {
  const now = svc._nowIso();
  const maxConf = Math.max(a.confidence ?? 0, b.confidence ?? 0);
  let newRecord = null;
  if (d === 'a_wins' || d === 'merge') {
    const winnerTags = d === 'merge' && !(a.tags ?? []).includes('merged')
      ? [...(a.tags ?? []), 'merged'] : a.tags;
    const loser = withPatch(b, { status: 'superseded', validTo: b.validTo ?? now });
    newRecord = withPatch(a, {
      status: 'active', validTo: null, confidence: maxConf, tags: winnerTags,
    });
    await svc._commit(loser, 'curate_apply', { ...detail, decision: d, side: 'loser' });
    await svc._commit(newRecord, 'curate_apply', { ...detail, decision: d, side: 'winner' });
  } else if (d === 'b_wins') {
    const loser = withPatch(a, { status: 'superseded', validTo: a.validTo ?? now });
    newRecord = withPatch(b, { status: 'active', validTo: null, confidence: maxConf });
    await svc._commit(loser, 'curate_apply', { ...detail, decision: d, side: 'loser' });
    await svc._commit(newRecord, 'curate_apply', { ...detail, decision: d, side: 'winner' });
  } else { // keep_both
    const bTags = (b.tags ?? []).includes('coexist') ? b.tags : [...(b.tags ?? []), 'coexist'];
    const aNew = withPatch(a, { status: 'active', validTo: null });
    const bNew = withPatch(b, { status: 'active', validTo: null, tags: bTags });
    await svc._commit(aNew, 'curate_apply', { ...detail, decision: d, side: 'a' });
    await svc._commit(bNew, 'curate_apply', { ...detail, decision: d, side: 'b' });
    newRecord = aNew;
  }
  return newRecord;
}

/** ids 形状裁决落盘（裁决 23）：ids[0]=a、ids[1]=b（更多 id 视为同簇其余败者/共存者） */
export async function applyIdsDecision(svc, d) {
  const ids = [...new Set(d.ids.map((x) => String(x)))];
  if (ids.length < 2) {
    throw invalidArg(`curateApply: ids-shaped decision needs >= 2 distinct ids, got ${JSON.stringify(d.ids)}`);
  }
  const recs = ids.map((id) => {
    const r = svc._records.get(id);
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

  const now = svc._nowIso();
  const maxConf = Math.max(...recs.map((r) => r.confidence ?? 0));
  const detail = { via: 'dedupe_ids', decision, ids, note: d.note ?? null };
  let newRecord = null;
  if (decision === 'keep_both') {
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const tags = i > 0 && !(r.tags ?? []).includes('coexist')
        ? [...(r.tags ?? []), 'coexist'] : r.tags;
      const patched = withPatch(r, { status: 'active', validTo: null, tags });
      await svc._commit(patched, 'curate_apply', { ...detail, side: `item${i}` });
      if (i === 0) newRecord = patched;
    }
  } else {
    for (const loser of losers) {
      const tags = !(loser.tags ?? []).includes(loserTag) ? [...(loser.tags ?? []), loserTag] : loser.tags;
      const patched = withPatch(loser, { status: 'superseded', validTo: loser.validTo ?? now, tags });
      await svc._commit(patched, 'curate_apply', { ...detail, side: 'loser' });
    }
    const winner = recs[winnerIdx];
    const wTags = decision === 'merge' && !(winner.tags ?? []).includes('merged')
      ? [...(winner.tags ?? []), 'merged'] : winner.tags;
    newRecord = withPatch(winner, { status: 'active', validTo: null, confidence: maxConf, tags: wTags });
    await svc._commit(newRecord, 'curate_apply', { ...detail, side: 'winner' });
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
export async function dedupeScan(svc, {
  threshold = POLICY.dedupe?.scanThreshold ?? 0.45,
  diceThreshold = POLICY.dedupe?.scanDiceThreshold ?? 0.15,
  limit = 50,
} = {}) {
  svc._ensureOpen();
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw invalidArg(`dedupeScan: threshold must be in (0,1], got ${JSON.stringify(threshold)}`);
  }
  if (typeof diceThreshold !== 'number' || !Number.isFinite(diceThreshold) || diceThreshold <= 0 || diceThreshold > 1) {
    throw invalidArg(`dedupeScan: diceThreshold must be in (0,1], got ${JSON.stringify(diceThreshold)}`);
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw invalidArg(`dedupeScan: limit must be a non-negative integer, got ${JSON.stringify(limit)}`);
  }
  const records = [...svc._records.values()].filter(
    (r) => (r.status === 'active' || r.status === 'disputed')
      && r.validTo === null
      && !isExpired(r, svc.clock),
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
