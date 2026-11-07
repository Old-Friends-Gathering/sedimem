// views/l2.js — L2 场景块（issue #50，施工图 §3 A 路）
// 为什么这样做：L2 是「同主题记录的确定性聚合」，转换层零 LLM（决策 D1）——
// 聚哪些记录由 slot 分组 + clusterNearDuplicates（并查集）决定，LLM 只可能出现在
// L3 的表述层。视图是派生物不是真相（D2）：整个 views/ 目录删掉后用同一真相层
// 重建必须得到字节相同的结果，因此 buildL2 是纯函数（不读盘、不碰时钟），
// builtAt 取自记录本身（max createdAt）而不是 Date.now()——这是「删目录 → 逐字节
// 复原」（I21）的关键约束。写入走 tmp + fsync + rename，崩溃不留半个视图文件。

import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scopeKeyOf } from '../config/paths.js';
import { normalizeText } from '../core/hash.js';
import { clusterNearDuplicates, dedupeSlotKey } from '../hygiene/conflict.js';

// unstructured 超组键与 conflict.js 保持同一来源，避免两处各写一遍判定而漂移
const UNSTRUCTURED_MARKER = '\u0000unstructured';

/**
 * L2 视图目录：<memoHome>/views/<scopeKey>/。
 * scopeKeyOf 是 scope → 文件名片段的单一来源（契约裁决 39）。
 * @param {string} memoHome
 * @param {string} scope
 * @returns {string}
 */
export function viewDir(memoHome, scope) {
  return join(String(memoHome), 'views', scopeKeyOf(scope));
}

/** sha256(key) 前 12 个十六进制字符 —— blockId 必须由 key 单值决定，保证稳定 */
function blockIdOf(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 与视图相关的 policy 子集哈希：views + dedupe 两段。这两段任一变化都会改变
 * 聚类/切片结果，调用方据 policyHash 判断视图是否过期（§6 风险对策）。
 * 缺失的段记为 null（而不是省略键），保证「无配置」与「有配置」哈希不同。
 */
function policyHashOf(policy) {
  const subset = {
    views: policy?.views ?? null,
    dedupe: policy?.dedupe ?? null,
  };
  return createHash('sha256').update(JSON.stringify(subset), 'utf8').digest('hex');
}

/** createdAt 升序、同刻按 id（ULID 字典序即时间序）——块内排序与切片的唯一次序 */
function byCreatedAsc(a, b) {
  const ca = String(a.createdAt ?? '');
  const cb = String(b.createdAt ?? '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : 1;
}

/** key → {key, recordIds, stats} 的完整块（含切片编号），每片独立 blockId */
function emitBlocks(key, members, maxBlockSize, out) {
  const sorted = [...members].sort(byCreatedAsc);
  const ids = sorted.map((r) => String(r.id));
  if (sorted.length <= maxBlockSize) {
    out.push(makeBlock(key, sorted, ids));
    return;
  }
  // 超上限：按 createdAt 升序切成 key#1、key#2…（key 本体让位给切片编号）
  for (let i = 0; i < sorted.length; i += maxBlockSize) {
    const chunk = sorted.slice(i, i + maxBlockSize);
    out.push(makeBlock(`${key}#${Math.floor(i / maxBlockSize) + 1}`, chunk, ids.slice(i, i + maxBlockSize)));
  }
}

function makeBlock(key, records, ids) {
  const kinds = {};
  // kind 名排序保证 kinds 键序确定（否则 JSON 键序随插入顺序漂移，破坏字节重建）
  for (const k of [...new Set(records.map((r) => String(r.kind ?? 'fact')))].sort()) {
    kinds[k] = records.filter((r) => String(r.kind ?? 'fact') === k).length;
  }
  const times = records.map((r) => String(r.createdAt ?? ''));
  return {
    blockId: blockIdOf(key),
    key,
    recordIds: ids,
    stats: {
      count: records.length,
      // 块里可能含 superseded/tombstoned（trace 需要它们），但注入目录只该看活记录数
      activeCount: records.filter((r) => r.status === 'active').length,
      firstAt: times[0] ?? null,
      lastAt: times[times.length - 1] ?? null,
      kinds,
    },
  };
}

/**
 * 构建 L2 场景块（纯函数：只读 records，不读盘、不取系统时间）。
 * 聚类次序：先进 slot 块（subject/predicate 非 text/text），剩下的 unstructured
 * 才进 cluster 块——一条记录只出现在一个块里。cluster 的 key 用块内最小 recordId
 * （ULID 字典序即时间序），未聚上任何簇的单条 unstructured 也自成一块（key 同形），
 * 保证 sum(recordIds.length) === sourceCount 恒成立。
 * @param {import('../core/record.js').MemoryRecord[]} records 调用方传入的真相层记录
 * @param {{scope: string, policy?: object}} opts
 * @returns {{blocks: object[], builtAt: string|null, sourceCount: number, policyHash: string}}
 */
export function buildL2(records, { scope, policy } = {}) {
  if (typeof scope !== 'string' || scope === '') {
    const err = new Error('buildL2: scope is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (!Array.isArray(records)) {
    const err = new Error('buildL2: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const maxBlockSize = Number.isInteger(policy?.views?.maxBlockSize) && policy.views.maxBlockSize > 0
    ? policy.views.maxBlockSize
    : 64;
  const threshold = policy?.dedupe?.scanThreshold ?? 0.45;
  const diceThreshold = policy?.dedupe?.scanDiceThreshold ?? 0.15;

  // 分区：slot 块与 unstructured 超组（判定复用 dedupeSlotKey，不重写第二遍）
  const slotGroups = new Map(); // 归一化 slot 键 → records[]
  const unstructured = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const slotKey = dedupeSlotKey(r);
    if (slotKey === UNSTRUCTURED_MARKER) {
      unstructured.push(r);
    } else {
      // key 用 \u0001 分隔（与 dedupeSlotKey 同型）：'/' 会让 subject 含 '/' 的
      // 不同 slot 撞键，安静地合并两个不相干的块
      const s = normalizeText(String(r.subject ?? ''));
      const p = normalizeText(String(r.predicate ?? ''));
      const groupKey = `slot:${s}\u0001${p}`;
      if (!slotGroups.has(groupKey)) slotGroups.set(groupKey, []);
      slotGroups.get(groupKey).push(r);
    }
  }

  // unstructured 聚类：只做候选发现（宁多不漏），一个 record 只进一个簇（并查集保证）。
  // 性能护栏（架构审核 S3 实测：5000 条 unstructured 会走 O(n²) 全对比较，耗时 14.6s）：
  // 超过 maxClusterRecords 就退化为「每条自成一块」——结构仍然正确（守恒不变式成立），
  // 只是不聚类。宁可少聚，不能让 `memo view build` 卡死。
  const maxClusterRecords = Number.isInteger(policy?.views?.maxClusterRecords) && policy.views.maxClusterRecords > 0
    ? policy.views.maxClusterRecords
    : 2000;
  const clustered = new Set(); // 已进 ≥2 簇的 recordId
  const clusterGroups = [];
  const { clusters } = unstructured.length > maxClusterRecords
    ? { clusters: [] }
    : clusterNearDuplicates(unstructured, { threshold, diceThreshold });
  for (const c of clusters) {
    const members = c.items.filter((r) => !clustered.has(String(r.id)));
    if (members.length === 0) continue;
    for (const r of members) clustered.add(String(r.id));
    clusterGroups.push({ key: `cluster:${minRecordId(members)}`, members });
  }
  for (const r of unstructured) {
    if (clustered.has(String(r.id))) continue;
    clusterGroups.push({ key: `cluster:${String(r.id)}`, members: [r] });
  }

  const blocks = [];
  for (const [key, members] of slotGroups) emitBlocks(key, members, maxBlockSize, blocks);
  for (const g of clusterGroups) emitBlocks(g.key, g.members, maxBlockSize, blocks);
  // 块按 key 升序：输出顺序确定，同一真相层两次构建字节相同
  blocks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // builtAt 取记录本身的最晚 createdAt（不用 Date.now()，见文件头注释）
  let builtAt = null;
  for (const r of records) {
    const t = String(r?.createdAt ?? '');
    if (t && (builtAt === null || t > builtAt)) builtAt = t;
  }

  return {
    blocks,
    builtAt,
    sourceCount: records.length,
    policyHash: policyHashOf(policy),
  };
}

/** 块内最小 recordId（ULID 字典序即时间序） */
function minRecordId(members) {
  let min = null;
  for (const r of members) {
    const id = String(r.id);
    if (min === null || id < min) min = id;
  }
  return min;
}

/** 原子写单文件：tmp → fsync → rename。崩溃时最多留下 tmp 残骸，正式文件不会是半个 */
function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, content, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

/**
 * 写 L2 视图：L2.jsonl（每块一行 JSON）+ meta.json（builtAt/sourceCount/policyHash）。
 * @param {string} memoHome
 * @param {string} scope
 * @param {{blocks: object[], builtAt: string|null, sourceCount: number, policyHash: string}} built
 */
export function writeL2(memoHome, scope, built) {
  if (!built || typeof built !== 'object' || !Array.isArray(built.blocks)) {
    const err = new Error('writeL2: built must be a buildL2 result');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const dir = viewDir(memoHome, scope);
  mkdirSync(dir, { recursive: true });
  const jsonl = built.blocks.map((b) => JSON.stringify(b)).join('\n') + (built.blocks.length ? '\n' : '');
  writeFileAtomic(join(dir, 'L2.jsonl'), jsonl);
  writeFileAtomic(
    join(dir, 'meta.json'),
    `${JSON.stringify({
      builtAt: built.builtAt,
      sourceCount: built.sourceCount,
      policyHash: built.policyHash,
      blockCount: built.blocks.length,
    }, null, 2)}\n`,
  );
}

/**
 * 读 L2 视图，返回与 buildL2 同形状的对象；目录或任一文件不存在返回 null（不抛）。
 * @param {string} memoHome
 * @param {string} scope
 * @returns {{blocks: object[], builtAt: string|null, sourceCount: number, policyHash: string}|null}
 */
export function readL2(memoHome, scope) {
  const dir = viewDir(memoHome, scope);
  const jsonlPath = join(dir, 'L2.jsonl');
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(jsonlPath) || !existsSync(metaPath)) return null;
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return null; // meta 损坏视同无视图，调用方 rebuild 即可（视图是派生物）
  }
  const blocks = [];
  const raw = readFileSync(jsonlPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      blocks.push(JSON.parse(line));
    } catch {
      // 视图是派生物：坏行视同「没有视图」，让调用方 rebuild，而不是把 SyntaxError 抛给 Agent
      // （对抗审核 S1/⑤ 实测：半行会让 memo view show 直接 E_UNKNOWN 崩掉）
      return null;
    }
  }
  // 空文件但 meta 声称有记录 → 也是损坏（否则「0 块 / N 条」静默误导）
  if (blocks.length === 0 && Number(meta.sourceCount ?? 0) > 0) return null;
  return {
    blocks,
    builtAt: meta.builtAt ?? null,
    sourceCount: Number(meta.sourceCount ?? 0),
    policyHash: String(meta.policyHash ?? ''),
  };
}

/**
 * 溯源 + 漂移检测：定位 recordId 所在块，并对账视图与当前真相层。
 * - blockId/sourceRefs：recordId 所在块的 id 与该块全部 recordIds（证据链）
 * - missing：当前 records 有、视图没有（新增后未 rebuild）
 * - stale：视图有、当前 records 没有（删除/失效后未 rebuild）
 * 视图不存在时 blockId 为 null、missing 列出全部当前记录。
 * @param {string} memoHome
 * @param {string} scope
 * @param {string} recordId
 * @param {import('../core/record.js').MemoryRecord[]} records 当前真相层记录
 * @returns {{blockId: string|null, sourceRefs: string[], missing: string[], stale: string[]}}
 */
export function traceRecord(memoHome, scope, recordId, records) {
  if (typeof recordId !== 'string' || recordId === '') {
    const err = new Error('traceRecord: recordId is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (!Array.isArray(records)) {
    const err = new Error('traceRecord: records must be an array');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const currentIds = records.map((r) => String(r?.id ?? '')).filter((id) => id !== '');
  const view = readL2(memoHome, scope);
  if (!view) {
    return { blockId: null, sourceRefs: [], missing: [...currentIds], stale: [] };
  }
  const viewIds = [];
  let blockId = null;
  let sourceRefs = [];
  for (const b of view.blocks) {
    for (const id of b.recordIds) {
      viewIds.push(id);
      if (id === recordId) {
        blockId = b.blockId;
        sourceRefs = [...b.recordIds];
      }
    }
  }
  const currentSet = new Set(currentIds);
  const viewSet = new Set(viewIds);
  return {
    blockId,
    sourceRefs,
    missing: currentIds.filter((id) => !viewSet.has(id)),
    stale: viewIds.filter((id) => !currentSet.has(id)),
  };
}
