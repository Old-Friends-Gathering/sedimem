// web/api/read.js — 只读端点：summary / brief / records / graph / timeline（从 web/handlers.js 拆出）。

import { defaultPolicy as POLICY } from '../../config/policy.js';
import { appVersion, intArg, invalidArg, dayWindow, parseTzOffset, todayInTz, decisionKey, readMetrics, MERGE_OPS, dateShift, makeLabel } from './shared.js';

async function apiSummary(service) {
  const stats = await service.stats();
  return {
    scope: service.scope,
    memoHome: service.memoHome,
    version: appVersion(),
    // W7：UI 用这个决定编辑页是否可提交（默认只读）
    writeEnabled: process.env.MEMO_WRITE === '1',
    policy: {
      // kinds 随摘要下发给图谱页取色（issue #33：颜色唯一真相在 policy）
      kinds: POLICY.kinds ?? null,
      maxActive: POLICY.quota?.maxActive ?? null,
      nearDupThreshold: POLICY.dedupe?.nearDupThreshold ?? null,
      scanThreshold: POLICY.dedupe?.scanThreshold ?? null,
      scanDiceThreshold: POLICY.dedupe?.scanDiceThreshold ?? null,
    },
    stats,
  };
}

async function apiBrief(service, query) {
  const lines = intArg(query, 'lines', { min: 1, max: 500, fallback: 80 });
  const text = await service.brief({ lines });
  return { text: String(text), generatedAt: new Date().toISOString() };
}

const RECORD_STATUS = new Set(['active', 'superseded', 'disputed', 'tombstoned', 'all']);

async function apiRecords(service, query) {
  const status = query.get('status') || 'active';
  if (!RECORD_STATUS.has(status)) {
    throw invalidArg(`status must be one of ${[...RECORD_STATUS].join('|')}, got ${JSON.stringify(status)}`);
  }
  const kind = query.get('kind') || undefined;
  const since = query.get('since') || undefined;
  if (since !== undefined && since !== '' && Number.isNaN(Date.parse(since))) {
    throw invalidArg(`since must be an ISO-8601 string, got ${JSON.stringify(since)}`);
  }
  const limit = intArg(query, 'limit', { min: 1, max: 100000, fallback: 2000 });
  const q = (query.get('q') || '').toLowerCase();
  const out = await service.exportRecords({ status, kind, since, limit, includeSuspicious: false });
  let records = out.records;
  if (q) {
    records = records.filter((r) => (
      String(r.text ?? '').toLowerCase().includes(q)
        || String(r.value ?? '').toLowerCase().includes(q)
        || String(r.subject ?? '').toLowerCase().includes(q)
        || String(r.predicate ?? '').toLowerCase().includes(q)
    ));
  }
  return { records, total: out.total, limited: out.limited };
}

/** 裁决 33/40：图谱服务端派生。节点 active/superseded/disputed，createdAt 降序 + hits 降序取前 limit。 */
async function apiGraph(service, query) {
  const limit = intArg(query, 'limit', { min: 1, max: 1000, fallback: 300 });
  const days = intArg(query, 'days', { min: 1, max: 3650, fallback: 90 });
  const cutoffIso = new Date(Date.now() - days * 86400000).toISOString();

  const all = await service.exportRecords({ status: 'all', limit: 1000000 });
  // 裁决 40：节点集含 disputed——否则 disputed-with 边的 from 端恒不在节点集里，冲突红线永远画不出来
  const NODE_STATUS = new Set(['active', 'superseded', 'disputed']);
  const eligible = all.records.filter(
    (r) => NODE_STATUS.has(r.status) && String(r.createdAt) >= cutoffIso,
  );
  eligible.sort((a, b) => (
    String(b.createdAt).localeCompare(String(a.createdAt))
      || (b.hits ?? 0) - (a.hits ?? 0)
      || String(a.id).localeCompare(String(b.id))
  ));
  const picked = eligible.slice(0, limit);
  const idSet = new Set(picked.map((r) => r.id));

  // 全量记录（含 disputed，取 slot 关系与 supersedes 链）；get() 为内存读，suspicious 正文已遮蔽
  const fullById = new Map();
  for (const r of all.records) {
    const got = service.get(r.id);
    if (got) fullById.set(r.id, got);
  }

  // 节点聚合（裁决 60）：同一 subject 的多条记录合并成一个点，用 ×N 表示条数。
  // 起因：实测 118 条记录里 51% 的节点与人重名（同 subject 写 7 条 → 7 个一模一样的标签），
  // 图上看起来像「重复沉淀」，其实是一个主题的不同 predicate。合并后 predicate 进详情。
  const groupOf = new Map(); // groupKey → node
  const nodeIdOf = new Map(); // recordId → node.id
  for (const r of picked) {
    const structured = typeof r.subject === 'string' && r.subject !== '' && r.subject !== 'text';
    const key = structured ? `S:${r.subject}` : `R:${r.id}`;
    let node = groupOf.get(key);
    if (!node) {
      node = {
        // 聚合节点 id 不能借首条记录的 id：同组内「旧→新」时间链的两端会解析成
        // 同一个点（a === b），全部被 continue，图谱一条边都不剩。用组 key 派生，
        // 保证与任何 recordId 都不同源。
        id: key.startsWith('S:') ? `AGG:${r.subject}` : `AGG:${r.id}`,
        label: makeLabel(r),
        kind: r.kind,
        status: r.status,
        subject: r.subject,
        createdAt: r.createdAt,
        hits: 0,
        degree: 0,
        count: 0,
        predicates: [],
        chain: [],
      };
      groupOf.set(key, node);
    }
    node.count += 1;
    node.hits += r.hits ?? 0;
    // 组内任一记录带 title，就用它当这个聚合点的标签（title 是写入方给的「人能读懂的一句话」）
    if (!node.title && typeof r.title === 'string' && r.title.trim() !== '') node.title = r.title.trim();
    nodeIdOf.set(r.id, node.id);
    const full = fullById.get(r.id);
    const pred = full?.predicate ?? r.predicate;
    if (pred && pred !== 'text' && !node.predicates.includes(pred) && node.predicates.length < 8) {
      node.predicates.push(pred);
    }
    // 代表记录取最老的（版本链起点），status/kind 用它；只要组内有 active 就显示 active
    if (!node.reprId || String(r.createdAt) < String(node.createdAt)) {
      node.reprId = r.id;
      node.createdAt = r.createdAt;
      node.kind = r.kind;
      node.subject = r.subject;
      node.text = r.text;
      node.value = r.value;
    }
    if (r.status === 'active') node.status = 'active';
    else if (node.status !== 'active' && r.status === 'superseded') node.status = 'superseded';
    // 组内演化时间线（详情面板展示；聚合图上组内自环没有信息，这里是关联性的正确载体）
    if (node.chain.length < 6) {
      node.chain.push({ id: r.id, title: r.title ?? null, createdAt: r.createdAt, status: r.status });
    }
  }
  const nodes = [...groupOf.values()];
  for (const n of nodes) {
    if (n.title) n.label = makeLabel({ title: n.title, subject: n.subject, predicate: n.predicates[0] });
    delete n.title;
  }
  const nodeId = (recId) => nodeIdOf.get(recId) ?? null;

  const edges = [];
  const degree = new Map();
  const bump = (id) => degree.set(id, (degree.get(id) ?? 0) + 1);

  // 1) same-entity（裁决 60 终版）：同 subject 已聚合为一个点，「组内连线」在聚合语义下
  //    是自环（首尾都是同一个 AGG 点），画出来只会是一圈圈没有信息的环。
  //    组的时间深度由 count + 详情面板表达；版本演化由 supersedes 边表达（跨组或组内，
  //    只要首尾 id 不同就会画）。这是「聚合不造假边」的取舍。

  // 2) supersedes：旧 id → 新 id 有向边。两个来源：
  //    a) 记录自身 supersedes 字段（人工 supersede 路径会写入）；
  //    b) 审计事件 op='supersede'（detail.by = 新 id，ev.id = 旧 id；write-gate 的
  //       slot 取代路径不落 supersedes 字段，只在事件流里体现）。仅当两侧都进入采样集。
  {
    const seen = new Set();
    const addSupersedes = (oldId, newId) => {
      if (!oldId || !idSet.has(oldId) || !idSet.has(newId)) return;
      const a = nodeId(oldId);
      const b = nodeId(newId);
      if (!a || !b || a === b) return;
      const key = `${a}\u0001${b}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from: a, to: b, type: 'supersedes', weight: 1 });
      bump(a); bump(b);
    };
    for (const n of nodes) {
      const full = fullById.get(n.id);
      const oldId = full?.supersedes ?? null;
      if (oldId) addSupersedes(oldId, n.id);
    }
    try {
      const { events } = await service.events({ limit: 1000000 });
      for (const ev of events) {
        if (ev.op === 'supersede' && ev.detail?.by) addSupersedes(ev.id, ev.detail.by);
      }
    } catch { /* 事件流不可读不拖垮图谱 */ }
  }

  // 3) duplicate-of：dedupeScan 的 pairs，weight = score
  try {
    const scan = await service.dedupeScan({ limit: 50 });
    for (const cluster of scan.clusters) {
      for (const pair of cluster.pairs ?? []) {
        const a = nodeId(pair.aId);
        const b = nodeId(pair.bId);
        if (idSet.has(pair.aId) && idSet.has(pair.bId) && a && b && a !== b) {
          const e = { from: a, to: b, type: 'duplicate-of', weight: pair.score };
          if (pair.strength !== undefined) e.strength = pair.strength;
          edges.push(e);
          bump(a); bump(b);
        }
      }
    }
  } catch { /* dedupeScan 失败不拖垮整个图谱 */ }

  // 3.5) shared-entity（裁决 61）：跨主题的实体共现——工单号、MR 号、commit SHA、
  //    设备/工具名等在两条记录里同时出现，就画一条细线。这是聚合后仍然可见的
  //    「跨主题关联」载体；组内共现（同 AGG 点）没有意义，跳过。
  //    提取规则刻意保守：只认强锚点（#1234、MR299、9 位 hex、白名单名词），
  //    单条记录命中的实体数封顶 4，避免一个 hub 拖出毛球。
  {
    const ENTITY_RE = /(#\d{3,6}|\bMR\s?\d{2,6}\b|\b[0-9a-f]{9,10}\b|Mac mini|Terra|Sol me\d*|Kibana|Codex|Claude|Pages|grafana|launchd|FTS5)/g;
    const byEntity = new Map();
    for (const r of picked) {
      const hay = `${r.title ?? ''} ${r.subject} ${r.predicate} ${r.text ?? ''}`;
      const hits = new Set();
      for (const m of hay.matchAll(ENTITY_RE)) {
        const t = m[0].replace(/\s+/g, '').toLowerCase();
        hits.add(t);
        if (hits.size >= 5) break; // 单条封顶：防 hub
      }
      for (const t of hits) {
        if (!byEntity.has(t)) byEntity.set(t, []);
        byEntity.get(t).push(r.id);
      }
    }
    const pairSeen = new Set();
    for (const [ent, ids] of byEntity) {
      if (ids.length < 2 || ids.length > 12) continue; // 太冷的词不连，太热的词是毛球
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = nodeId(ids[i]);
          const b = nodeId(ids[j]);
          if (!a || !b || a === b) continue; // 同一聚合点内的共现不画
          const key = `${a}\u0001${b}`;
          if (pairSeen.has(key)) continue;
          pairSeen.add(key);
          edges.push({ from: a, to: b, type: 'same-entity', weight: 0.75, entity: ent });
          bump(a); bump(b);
        }
      }
    }
  }

  // 4) disputed-with：disputed 记录与同 slot 的 active 记录
  for (const [, full] of fullById) {
    if (full.status !== 'disputed') continue;
    for (const [, peer] of fullById) {
      if (peer.id === full.id || peer.status !== 'active') continue;
      if (peer.scope !== full.scope || peer.subject !== full.subject || peer.predicate !== full.predicate) continue;
      if (!idSet.has(peer.id) || !idSet.has(full.id)) continue;
      const a = nodeId(full.id);
      const b = nodeId(peer.id);
      if (!a || !b || a === b) continue;
      edges.push({ from: a, to: b, type: 'disputed-with', weight: 1 });
      bump(a); bump(b);
    }
  }

  for (const n of nodes) {
    n.degree = degree.get(n.id) ?? 0;
    if (n.reprId) n.repr = n.reprId; // 代表记录 id（前端可拿去 /api/records 深挖）
    delete n.reprId;
    n.chain.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  return { nodes, edges, sampled: { shown: nodes.length, total: eligible.length, records: picked.length } };
}

async function apiTimeline(service, query) {
  const days = intArg(query, 'days', { min: 1, max: 365, fallback: 30 });
  const tzOffset = parseTzOffset(query);
  const today = todayInTz(tzOffset);
  const first = dayWindow(dateShift(today, -(days - 1)), tzOffset).from;
  const lastWindow = dayWindow(today, tzOffset);
  const { events } = await service.events({
    since: new Date(first).toISOString(),
    until: lastWindow.toIso,
    limit: 1000000,
  });

  // 按自然日（tz 偏移后）分桶
  const seenMergedKeys = new Set();
  const byDate = new Map();
  for (let i = 0; i < days; i++) byDate.set(dateShift(today, -i), { created: 0, superseded: 0, merged: 0 });
  for (const ev of events) {
    const d = new Date(Date.parse(ev.ts) - tzOffset * 60000).toISOString().slice(0, 10);
    const bucket = byDate.get(d);
    if (!bucket) continue;
    if (ev.op === 'write' && ev.detail?.action === 'created') bucket.created++;
    else if (ev.op === 'supersede') bucket.superseded++;
    else if (MERGE_OPS.has(ev.op)) {
      if (ev.detail?.side === 'loser') continue;
      const key = decisionKey(ev);
      if (seenMergedKeys.has(key)) continue;
      seenMergedKeys.add(key);
      bucket.merged++;
    }
  }

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dateShift(today, -i);
    const m = await readMetrics(service.memoHome, service.scope, date);
    const b = byDate.get(date);
    series.push({
      date,
      active: m?.active ?? null,
      total: m?.total ?? null,
      created: b.created,
      superseded: b.superseded,
      merged: b.merged,
      dupRatio: m?.dupRatio ?? null,
      conflictRate: m?.conflictRate ?? null,
      // 检索健康指标透传（issue #36）：卫生页趋势优先吃 /timeline 的 series，这里同样透传
      searchCount: m?.searchCount ?? null,
      noHitRate: m?.noHitRate ?? null,
      staleHitRate: m?.staleHitRate ?? null,
      avgTopScore: m?.avgTopScore ?? null,
    });
  }
  return { series };
}

export { apiSummary, apiBrief, apiRecords, apiGraph, apiTimeline };
