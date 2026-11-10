// web/handlers.js — 只读 HTTP 端点实现（契约：docs/08-web-ui.md §4.2 + docs/02 §3.9 裁决 30–34）
// 职责：参数解析/校验（E_INVALID_ARG → 400）、把 MemoryService 的结果投影成 JSON、
// 服务端生成 label（裁决 33：UI 不拼接语义）。禁止写操作、禁止 import hygiene/storage/index。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPolicy as POLICY } from '../config/policy.js';
import { metricsFileName, legacyMetricsFileName } from '../config/paths.js';

const V0_1_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 生成节点 label（裁决 33）：有结构用 `subject/predicate`，否则 text 前 60 字（+…）。
 *  withValue=true 时结构化记录追加「：值前 40 字」——用于时间线与清理史行（图谱节点保持短标签）。 */
const LABEL_MAX = 24;
// 口语开头：真人写记忆时常带这些前缀，label 里留着只会占掉有限的显示宽度
// 允许口语前缀后面再跟 ≤6 个字（「我刚刚看到，」「就是那个，」），连逗号一起删掉
const LABEL_FILLER = /^(?:我刚刚|刚才|你看一下|你看|就是|另外|顺便|其实|对了|嗯+)(?:[^，,。！？!?；;\s]{0,6})?[，,、 ]*/;

/** subject 人性化：下划线/连字符折成空格，连续空白归一。 */
function humanize(s) {
  return String(s ?? '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 非结构化记录的首句：去掉口语前缀，取到第一个句读/换行为止。 */
function firstSentence(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(LABEL_FILLER, '');
  const cut = t.split(/[。！？!?；;\n]/)[0] ?? t;
  return (cut || t).trim();
}

function clipLabel(t) {
  const x = String(t ?? '').trim();
  return x.length > LABEL_MAX ? `${x.slice(0, LABEL_MAX - 1)}…` : x;
}

/**
 * 生成节点 label（裁决 33 由服务端生成；裁决 59 改为「标题优先」）。
 *
 * 为什么不再拼 `subject/predicate`：实测同一个知识库 118 条记录里，服务端 label 平均 48 字符，
 * 图谱只画得下 16 字符，结果 51% 的节点与别人重名，predicate（真正区分它们的那半截）一个像素都露不出来。
 * 现在的规则：
 *   1) 有 title 用 title（写入方给的「人能读懂的一句话」，≤40 字）
 *   2) 结构化记录退回 subject（下划线折空格）
 *   3) 非结构化记录退回正文首句（去口语前缀）
 * predicate 不再进 label，改由图谱节点 payload 的 predicates 字段带到详情面板。
 * @param {object} r
 * @param {{withValue?: boolean}} [opts] withValue：时间线/清理史需要「标题：值」的形态
 */
export function makeLabel(r, { withValue = false } = {}) {
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const s = typeof r.subject === 'string' ? r.subject : '';
  const p = typeof r.predicate === 'string' ? r.predicate : '';
  const structured = s && p && !(s === 'text' && p === 'text');
  const base = clipLabel(title || (structured ? humanize(s) : firstSentence(r.text)));
  if (!base) return structured ? `${s}/${p}` : String(r.id ?? '');
  if (!withValue) return base;
  const v = String(r.value ?? r.text ?? '').replace(/\s+/g, ' ').trim();
  if (!v || v === base) return base;
  return `${base}：${v.length > 40 ? `${v.slice(0, 40)}…` : v}`;
}

function invalidArg(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_ARG';
  return err;
}

/** 整数参数校验：返回 number 或抛 E_INVALID_ARG。 */
function intArg(query, name, { min = 1, max = 10000, fallback } = {}) {
  const raw = query.get(name);
  if (raw === null || raw === '') {
    if (fallback === undefined) throw invalidArg(`missing required query param: ${name}`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalidArg(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验 YYYY-MM-DD 且为真实日历日（Date.parse 归一化后回串相等）。 */
function validDate(date) {
  if (!DATE_RE.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

/** 裁决 32：自然日窗口。tzOffset 分钟、东为正；from/to 为 UTC ISO8601，[from, to) 半开。 */
export function dayWindow(date, tzOffset) {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) throw invalidArg(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const from = base - tzOffset * 60000;
  return { from, to: from + 86400000, fromIso: new Date(from).toISOString(), toIso: new Date(from + 86400000).toISOString() };
}

/** 今天（按 tzOffset 时区的自然日）→ YYYY-MM-DD。 */
function todayInTz(tzOffset, nowMs = Date.now()) {
  return new Date(nowMs - tzOffset * 60000).toISOString().slice(0, 10);
}

function parseTzOffset(query) {
  const raw = query.get('tzOffset');
  if (raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || Math.abs(n) > 1440) {
    throw invalidArg(`tzOffset must be an integer of minutes in [-1440, 1440], got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseDateArg(query, { required = false, fallback } = {}) {
  const raw = query.get('date');
  if (raw === null || raw === '') {
    if (required) throw invalidArg('missing required query param: date');
    return fallback;
  }
  if (!validDate(raw)) throw invalidArg(`date must be a valid YYYY-MM-DD, got ${JSON.stringify(raw)}`);
  return raw;
}

/** 版本号：读 versions/v0.3/package.json 的 version（只读一次，缓存）。 */
let cachedVersion = null;
function appVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = JSON.parse(fs.readFileSync(path.join(V0_1_ROOT, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

// ---------------------------------------------------------------- 端点实现

async function apiSummary(service) {
  const stats = await service.stats();
  return {
    scope: service.scope,
    memoHome: service.memoHome,
    version: appVersion(),
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

/**
 * 事件 → 记录索引（id → 投影记录）。
 * 缺陷修复（审查 L5）：原实现 `service.get(ev.id)` 是 async，未 await 直接 makeLabel → 永久空 label。
 * 改为一次性 exportRecords({status:'all'}) 建索引，顺带避免 N 次读。
 */
async function recordIndex(service) {
  const { records } = await service.exportRecords({ status: 'all', limit: 1000000, includeSuspicious: false });
  return new Map(records.map((r) => [r.id, r]));
}

/** 一次裁决（curate_apply）在事件流里会写 loser + winner 两条，这里按「裁决键」聚合。 */
function decisionKey(ev) {
  const d = ev.detail ?? {};
  if (d.batchId) {
    const pairKey = Array.isArray(d.ids) ? [...d.ids].map(String).sort().join(',') : '';
    return `${d.batchId}#${d.pairIndex ?? pairKey}`;
  }
  if (Array.isArray(d.ids)) return `ids:${[...d.ids].map(String).sort().join(',')}`;
  return `ev:${ev.id ?? ''}:${ev.ts}`;
}

/** 把事件投影成 timeline 行（label 服务端生成；裁决类事件只保留一行）。 */
function toTimelineRows(events, index) {
  const rows = [];
  const seenDecision = new Set();
  for (const ev of events) {
    const d = ev.detail ?? {};
    // search 事件是「检索统计」不是「库的变化」（#43）：它没有记录 id、也没有分类含义，
    // 放进时间线只会多一行空 label。nightly 直接读事件流算指标，不受这里过滤影响。
    if (ev.op === 'search') continue;
    // 人工 supersede 会额外写一条 write(action='supersede')，以 op='supersede' 那行为准，避免重复
    if (ev.op === 'write' && d.action === 'supersede') continue;
    if (ev.op === 'curate_apply') {
      const side = d.side;
      if (side === 'loser') continue; // 只保留胜者行
      const key = decisionKey(ev);
      if (seenDecision.has(key)) continue;
      seenDecision.add(key);
    }
    const rec = ev.id ? index.get(ev.id) : null;
    // retitle/retitle_apply 是「改标题」动作：label 只给标题本身，再拼正文会把一行撑成两句
    const titleOnly = ev.op === 'retitle' || ev.op === 'retitle_apply';
    rows.push({
      ts: ev.ts,
      op: ev.op,
      id: ev.id ?? null,
      label: rec ? makeLabel(rec, { withValue: !titleOnly }) : String(ev.op),
      action: d.action ?? d.decision ?? null,
      reason: d.reason ?? null,
    });
  }
  return rows;
}

/** 统计一天的动作数（裁决类按「一次裁决」计，而不是按写盘条数）。 */
function countActions(events) {
  const counts = { created: 0, superseded: 0, forgotten: 0, merged: 0, hit: 0 };
  const seenDecision = new Set();
  for (const ev of events) {
    const d = ev.detail ?? {};
    if (ev.op === 'write' && d.action === 'created') counts.created++;
    else if (ev.op === 'supersede') counts.superseded++;
    else if (ev.op === 'forget') counts.forgotten++;
    else if (ev.op === 'curate_apply') {
      if (d.side === 'loser') continue;
      const key = decisionKey(ev);
      if (seenDecision.has(key)) continue;
      seenDecision.add(key);
      counts.merged++;
    } else if (ev.op === 'hit') counts.hit++;
  }
  return counts;
}

async function apiToday(service, query) {
  const tzOffset = parseTzOffset(query);
  const date = parseDateArg(query, { fallback: todayInTz(tzOffset) });
  const { fromIso, toIso } = dayWindow(date, tzOffset);
  const { events } = await service.events({ since: fromIso, until: toIso, limit: 100000 });
  const index = await recordIndex(service);
  return { date, counts: countActions(events), timeline: toTimelineRows(events, index) };
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

/** 裁决 31：metrics 读取——新名 <date>.<scopeKey>.json 优先，回退旧 <date>.json。 */
export async function readMetrics(memoHome, scope, date) {
  const dir = path.join(memoHome, 'metrics');
  for (const name of [metricsFileName(date, scope), legacyMetricsFileName(date)]) {
    try {
      return JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
    } catch { /* 尝试下一个名字 */ }
  }
  return null;
}

const MERGE_OPS = new Set(['curate_apply']);

async function apiHygiene(service) {
  const scan = await service.dedupeScan({ limit: 50 });
  const until = new Date().toISOString();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { events } = await service.events({ since, until, limit: 100000 });

  const merged = [];
  const superseded = [];
  const decisions = new Map(); // 裁决键 → {ts, loser, winner, decision}
  for (const ev of events) {
    if (ev.op === 'curate_apply') {
      const d = ev.detail ?? {};
      const key = decisionKey(ev);
      const slot = decisions.get(key) ?? { ts: ev.ts, loserId: null, winnerId: null, decision: d.decision ?? null };
      if (d.side === 'loser') slot.loserId = ev.id ?? null;
      else slot.winnerId = ev.id ?? null;
      // 兼容：旧事件没有 side 时按 ids 推断（ids[0] 胜者，b_wins 时 ids[1] 胜者）
      if (d.side === undefined && Array.isArray(d.ids)) {
        const winnerIdx = d.decision === 'b_wins' ? 1 : 0;
        slot.winnerId = d.ids[winnerIdx] ?? null;
        slot.loserId = ev.id ?? null;
      }
      if (!slot.decision) slot.decision = d.decision ?? null;
      decisions.set(key, slot);
    } else if (ev.op === 'supersede') {
      superseded.push({ ts: ev.ts, loserId: ev.id ?? null, winnerId: ev.detail?.by ?? null });
    }
  }

  const labels = await recordIndex(service);
  const labelOf = (id) => (id && labels.get(id) ? makeLabel(labels.get(id), { withValue: true }) : null);
  for (const slot of decisions.values()) {
    merged.push({
      ts: slot.ts,
      loserId: slot.loserId,
      winnerId: slot.winnerId,
      loserLabel: labelOf(slot.loserId),
      winnerLabel: labelOf(slot.winnerId),
      decision: slot.decision,
    });
  }
  for (const row of superseded) {
    row.loserLabel = labelOf(row.loserId);
    row.winnerLabel = labelOf(row.winnerId);
  }
  merged.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
  superseded.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));

  const all = await service.exportRecords({ status: 'all', limit: 1000000 });
  const suspiciousCount = all.records.filter(
    (r) => Array.isArray(r.tags) && r.tags.includes('suspicious'),
  ).length;

  // series：近 30 天 metrics 快照，按日期升序
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const m = await readMetrics(service.memoHome, service.scope, date);
    if (m) {
      const maxActive = Number(m.maxActive) > 0 ? Number(m.maxActive) : 5000;
      series.push({
        date,
        dupRatio: m.dupRatio ?? null,
        conflictRate: m.conflictRate ?? null,
        active: m.active ?? null,
        maxActive,
        activeRatio: Number.isFinite(Number(m.active)) ? Number(m.active) / maxActive : null,
        total: m.total ?? null,
        // 检索健康指标透传（issue #36，裁决 52）：metrics 文件里没有（旧快照）→ null，
        // UI 端 null 点跳过不画，绝不折算成 0。
        searchCount: m.searchCount ?? null,
        noHitRate: m.noHitRate ?? null,
        staleHitRate: m.staleHitRate ?? null,
        avgTopScore: m.avgTopScore ?? null,
      });
    }
  }

  const doctor = await service.doctor();
  return { candidates: scan.clusters, merged, superseded, suspicious: { count: suspiciousCount }, series, doctor };
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

function dateShift(date, deltaDays) {
  const ms = Date.parse(`${date}T00:00:00Z`) + deltaDays * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 路由

const ROUTES = new Map([
  ['/api/summary', apiSummary],
  ['/api/brief', apiBrief],
  ['/api/today', apiToday],
  ['/api/records', apiRecords],
  ['/api/graph', apiGraph],
  ['/api/hygiene', apiHygiene],
  ['/api/timeline', apiTimeline],
]);

/** 从 E_CORRUPT_JSONL 的 message 解析 file/line（与 service._parseCorruptLocation 同格式）。 */
function parseCorruptLocation(message) {
  const m = String(message).match(/at (\S+?\.jsonl)(?::(\d+))?/);
  if (!m) return {};
  return { file: m[1], line: m[2] !== undefined ? Number(m[2]) : null };
}

/**
 * 处理一个 /api/* 请求（不含静态资源）。
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleApi(service, url) {
  const route = ROUTES.get(url.pathname);
  if (!route) {
    return { status: 404, body: { ok: false, code: 'E_NOT_FOUND', message: `unknown endpoint: ${url.pathname}` } };
  }
  try {
    const payload = await route(service, url.searchParams);
    return { status: 200, body: { ok: true, ...payload } };
  } catch (err) {
    const code = err?.code ?? 'E_INTERNAL';
    const message = err?.message ?? String(err);
    if (code === 'E_INVALID_ARG') return { status: 400, body: { ok: false, code, message } };
    if (code === 'E_CORRUPT_JSONL') {
      return { status: 500, body: { ok: false, code, message, ...parseCorruptLocation(message) } };
    }
    return { status: 500, body: { ok: false, code, message } };
  }
}

export const ENDPOINTS = [...ROUTES.keys()];
