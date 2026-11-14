// api/search-path.js — 检索路径承接模块（车道 A，issue #32）
// search/get/brief/flushHits 及其私有辅助的原方法体搬到此，this → svc，语义零改动。

import { createHash } from 'node:crypto';

import { validateRecord, withPatch } from '../core/record.js';
import { monotonicDecay } from '../hygiene/conflict.js';
import { isExpired } from '../hygiene/decay.js';
import { renderBrief } from '../render/brief.js';
import { defaultPolicy as POLICY, kindMeta } from '../config/policy.js';
import { maskSuspiciousRecord } from './mask.js';
// 错误工厂从 service.js 反向引用（错误文本被测试断言，必须单一来源）。
import { invalid } from '../core/errors.js';
import { parseAsOf, nowIso } from '../core/time.js';

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
export async function searchRecords(svc, query, {
  limit = POLICY.search.limitDefault ?? 10,
  kind, asOf, includeDisputed = false, status = 'active', includeSuspicious = false,
} = {}) {
  svc._ensureOpen();
  if (typeof query !== 'string' || query.length === 0) {
    throw invalid('search: query (non-empty string) is required');
  }
  let asOfMs = null;
  let asOfIso = null;
  if (asOf !== undefined && asOf !== null) {
    asOfMs = parseAsOf(asOf, 'search: asOf');
    asOfIso = new Date(asOfMs).toISOString(); // 归一化到 UTC（支持 +08:00 等偏移量）
  }

  // 选出参与检索的记录
  const picked = [];
  if (asOfMs !== null) {
    // asOf 查询（裁决 17）：每个 id 取 validFrom <= asOf < validTo 的版本，按时间戳比较
    for (const versions of svc._versions.values()) {
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
    for (const r of svc._records.values()) {
      if (!statusOk(svc, r, { status, includeDisputed })) continue;
      if (isExpired(r, svc.clock)) continue;
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
  const idxLimit = typeof svc.index.size === 'number' ? svc.index.size : undefined;
  // 语义道包装（hybrid-index）的 search 是 async（要跑 embedder）；await 对同步索引是零成本。
  const hits = await svc.index.search(query, { limit: idxLimit, filter });

  const nowMs = svc.clock.nowMs();
  const halfLife = POLICY.search.recencyHalflifeMs;
  const items = [];
  for (const { id, score, basis } of hits) {
    const rec = pickedById.get(id);
    if (!rec) continue;
    // 裁决 49：kind 的唯一真相是 policy.kinds（kindMeta 内部 kinds 优先、旧 kindWeight 兜底），
    // 这里不能再直接读 POLICY.kindWeight —— 否则新加的 kind 会静默按 1.0 计权。
    const kw = kindMeta(POLICY, rec.kind)?.weight ?? 1.0;
    const ageMs = Math.max(0, nowMs - Date.parse(rec.createdAt));
    const decay = monotonicDecay(ageMs, halfLife);
    const final = score * kw * decay * (typeof rec.confidence === 'number' ? rec.confidence : 0.8);
    if (final > 0) items.push({ record: rec, score: final, basis: basis ?? null });
  }
  items.sort((a, b) => b.score - a.score);
  const top = items.slice(0, limit);

  // 检索健康事件（issue #36，裁决 52）：只记统计，绝不写 query 原文——
  // 真相层的 events.jsonl 是审计面，不是查询日志；qHash 取 sha256 前 12 位仅供聚合影射。
  // 走 svc._event 既有批量通道（与 hit 相同的 appendEvent 路径），不逐条 fsync。
  // staleHits 统计口径：命中里 status!=='active' 或 isExpired 的条数
  // （默认检索路径过滤后通常为 0，includeDisputed / asOf 查询时才可能非零）。
  const staleHits = top.reduce((n, { record }) => (
    record.status !== 'active' || isExpired(record, svc.clock) ? n + 1 : n
  ), 0);
  await svc._event('search', null, {
    hits: top.length,
    topScore: top.length > 0 ? top[0].score : null,
    staleHits,
    qHash: createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 12),
  });

  // hits 只增：召回一次记一次（内存累加，flushHits 时一次性落盘，避免检索写盘刷快照）
  if (asOfMs === null) {
    for (const { record } of top) {
      svc._extraHits.set(record.id, (svc._extraHits.get(record.id) ?? 0) + 1);
    }
  }
  const out = {
    items: top.map((it) => ({ ...it, record: withExtraHits(svc, maskSuspicious(svc, it.record, includeSuspicious)) })),
    total: items.length,
    asOf: asOfIso ?? nowIso(svc.clock),
  };
  // 语义道状态要显式可见（D1）：调用方（/api/search、CLI、MCP）据此提示「这次是纯词法」。
  // 两种情形都算降级，但原因不同：
  //  - 已启用但运行期不可用（embedder 挂了 / 维度漂移）→ hybrid 索引自带 degraded + reason；
  //  - 从未启用（policy.search.embedder.kind='none'）→ 索引没被包装，这里按策略补齐，
  //    避免「配置关闭」被误读成「检索正常但没结果」。
  const semanticKind = ((svc.policy ?? POLICY).search?.embedder?.kind) ?? 'none';
  if (svc.index?.degraded) {
    out.degraded = true;
    out.degradedReason = svc.index.degradedReason ?? 'unknown';
  } else if (semanticKind === 'none') {
    out.degraded = true;
    out.degradedReason = 'semantic-disabled';
  }
  return out;
}

/** 裁决 16/42：遮蔽实现见 api/mask.js（四个正文字段一起遮，避免 payload 换字段绕过） */
export function maskSuspicious(svc, r, includeSuspicious) {
  return maskSuspiciousRecord(r, includeSuspicious);
}

export function withExtraHits(svc, r) {
  const extra = svc._extraHits.get(r.id);
  return extra ? { ...r, hits: (r.hits ?? 0) + extra } : r;
}

/**
 * 把内存中累计的 hits 增量作为新版本快照（v+1）追加落盘，并清空增量。hits 只增。
 * 裁决 21：不得吞错——落盘失败时先恢复未落盘的计数再原样抛出（增量不丢）。
 */
export async function flushHits(svc) {
  svc._ensureOpen();
  const entries = [...svc._extraHits.entries()];
  svc._extraHits = new Map();
  const committed = new Set();
  try {
    for (const [id, extra] of entries) {
      const rec = svc._records.get(id);
      if (!rec) continue;
      const bumped = withPatch(rec, { hits: (rec.hits ?? 0) + extra });
      const v = validateRecord(bumped);
      if (v.ok) await svc._commit(bumped, 'hit', { flushed: extra });
      committed.add(id);
    }
  } catch (e) {
    // 失败恢复计数（只恢复未成功落盘的），再抛
    for (const [id, extra] of entries) {
      if (committed.has(id)) continue;
      const rec = svc._records.get(id);
      if (rec) svc._extraHits.set(id, (svc._extraHits.get(id) ?? 0) + extra);
    }
    throw e;
  }
  return { flushed: entries.length };
}

export function statusOk(svc, r, { status, includeDisputed }) {
  if (includeDisputed && r.status === 'disputed') return true;
  return r.status === status;
}

/** @returns {MemoryRecord|null}（suspicious 默认遮蔽正文，裁决 16） */
export async function getRecord(svc, id, { includeSuspicious = false } = {}) {
  svc._ensureOpen();
  const r = svc._records.get(id);
  return r ? withExtraHits(svc, maskSuspicious(svc, r, includeSuspicious)) : null;
}

/** 确定性 brief：pinned/decision 优先 → 最近 active 事实；suspicious 不进 brief。
 *  裁决 23：末节追加待裁决去重候选数（dedupeCandidates 显式传入则不再现算）。 */
export async function briefRecords(svc, { lines = 80, dedupeCandidates, blocks } = {}) {
  svc._ensureOpen();
  const records = [...svc._records.values()].filter(
    (r) => r.status === 'active' && r.validTo === null
      && !isExpired(r, svc.clock)
      && !(Array.isArray(r.tags) && r.tags.includes('suspicious')),
  );
  let candidates = dedupeCandidates;
  if (candidates === undefined) {
    const scan = await svc.dedupeScan({ limit: 1 });
    candidates = scan.totalClusters;
  }
  // 分层 brief（#51）：只有在视图**新鲜**时才启用，否则静默走扁平路径。
  // 判定用 sourceCount vs 真相层条数（视图是派生物，陈旧视图比没有视图更糟：
  // 架构审核 S5 实测，陈旧视图会让 L2 目录把死记录数展示给 Agent）。
  let viewBlocks = blocks;
  if (viewBlocks === undefined) {
    try {
      const { readL2 } = await import('../views/l2.js');
      const view = readL2(svc.memoHome, svc.scope);
      viewBlocks = view && view.sourceCount === svc._records.size ? view.blocks : null;
    } catch {
      viewBlocks = null; // 视图模块缺失/损坏不影响 brief 主路径（降级为扁平）
    }
  }
  // v1.0 W3：有 ok 派生时用 LLM 生成的 title 覆盖规则字段（缺失/失败自动回落，不改变条数）
  let shaped = records;
  if (svc.llmPort && svc.llmPort.ready) {
    await svc._loadDerived();
    shaped = records.map((r) => {
      const d = svc._derived.get(`${r.id}@${r.validFrom}`);
      return d && d.deriveStatus === 'ok' && d.title ? { ...r, title: d.title } : r;
    });
  }
  return renderBrief({
    scope: svc.scope, records: shaped, lines, clock: svc.clock, dedupeCandidates: candidates,
    blocks: viewBlocks,
  });
}
