// session/ledger.js — 任务账本段存储（v1.2 B1，契约：versions/v1.2/docs/SEGMENT-SPEC.md §1–§3）
//
// 磁盘布局（真相层 + 派生层）：
//   $MEMO_HOME/sessions/<taskId>/segments.jsonl   append-only，一行一段（真相）
//   $MEMO_HOME/sessions/<taskId>/index.json       派生，可重建（{version,builtAt,segments,coveredSeqs}）
//   $MEMO_HOME/sessions/<taskId>.json             既有 meta（lifecycle 写；archive 时移入归档目录）
//
// 不变式（SPEC §2 / 裁决 118-121）：
//   - 段区间半开 [fromSeq, toSeq)，两两不相交；重叠追加抛 E_ALREADY_CAPTURED（幂等）。
//   - 段只追加，不重写历史；index.json 由 segments.jsonl 重建，同输入 + 同 clock → 逐字节相同。
//   - 写段必须持 <memoHome>/.lock（复用 storage/lock.js，同一把锁，不新开锁文件）。
//
// 零运行时依赖：只 import node: 内置与同仓模块。

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { systemClock } from '../core/clock.js';
import { newId } from '../core/ids.js';
import { withLock } from '../storage/lock.js';
import { MEMO_DIR_MODE, MEMO_FILE_MODE } from '../config/perms.js';

/** index.json 的版本号（结构变更时递增） */
export const INDEX_VERSION = 1;

/** segments.jsonl 文件名 */
const SEGMENTS_FILE = 'segments.jsonl';
/** index.json 文件名 */
const INDEX_FILE = 'index.json';
/** 段记录上限（SPEC §2；appendSegment 只校验结构性字段，截断由 capture 负责） */
export const SEGMENT_LIMITS = Object.freeze({
  summary: 400,
  factItem: 200,
  facts: 12,
  decisions: 8,
  gotchas: 8,
  pendingJobs: 8,
  files: 20,
  nextSteps: 5,
});

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

function requireMemoHome(memoHome) {
  if (typeof memoHome !== 'string' || memoHome === '') {
    throw err('E_INVALID_ARG', `memoHome 必须是非空字符串，收到 ${JSON.stringify(memoHome)}`);
  }
}

/** taskId 只允许单段目录名（防路径穿越 / 绝对路径） */
function requireTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId === '' || taskId === '.' || taskId === '..'
    || /[/\\\0]/.test(taskId)) {
    throw err('E_INVALID_ARG', `taskId 必须是单段目录名，收到 ${JSON.stringify(taskId)}`);
  }
}

function taskDir(memoHome, taskId) {
  requireMemoHome(memoHome);
  requireTaskId(taskId);
  return path.join(memoHome, 'sessions', taskId);
}

/**
 * segments.jsonl 绝对路径。
 * @param {string} memoHome
 * @param {string} taskId
 * @returns {string}
 */
export function segmentsFile(memoHome, taskId) {
  return path.join(taskDir(memoHome, taskId), SEGMENTS_FILE);
}

/** index.json 绝对路径（内部用） */
function indexFilePath(memoHome, taskId) {
  return path.join(taskDir(memoHome, taskId), INDEX_FILE);
}

/** 段记录结构性校验：区间合法 + anchor 指向真实文件 + summary 非空（SPEC §2 不变式） */
function validateSegment(segment) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
    throw err('E_INVALID_ARG', `appendSegment: segment 必须是对象，收到 ${typeof segment}`);
  }
  const { fromSeq, toSeq, anchor, summary } = segment;
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq)) {
    throw err('E_INVALID_ARG',
      `appendSegment: fromSeq/toSeq 必须是整数，收到 ${JSON.stringify(fromSeq)} / ${JSON.stringify(toSeq)}`);
  }
  if (fromSeq < 0 || fromSeq >= toSeq) {
    throw err('E_INVALID_ARG', `appendSegment: 需要 0 <= fromSeq < toSeq，收到 [${fromSeq}, ${toSeq})`);
  }
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)
    || typeof anchor.path !== 'string' || anchor.path === '') {
    throw err('E_INVALID_ARG', 'appendSegment: anchor 必填且必须指向真实文件（anchor.path 非空字符串）');
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    throw err('E_INVALID_ARG', 'appendSegment: summary 必填且非空（规则模式也要有兜底摘要）');
  }
}

/** 一行解析出的对象是否是可用的段（坏行判定；只要求区间合法，其余字段宽容） */
function isSegmentShape(seg) {
  return seg !== null && typeof seg === 'object' && !Array.isArray(seg)
    && Number.isInteger(seg.fromSeq) && Number.isInteger(seg.toSeq)
    && seg.fromSeq >= 0 && seg.fromSeq < seg.toSeq;
}

/**
 * 读全部段。逐行 JSON.parse；坏行（非 JSON / 形状不合法）计入 badLines 并跳过，不抛。
 * 文件缺失按空账本处理。
 * @param {{memoHome: string, taskId: string}} args
 * @returns {{segments: object[], badLines: number}}
 */
export function readSegments({ memoHome, taskId } = {}) {
  const file = segmentsFile(memoHome, taskId);
  if (!existsSync(file)) return { segments: [], badLines: 0 };
  const raw = readFileSync(file, 'utf8');
  const segments = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    let seg;
    try {
      seg = JSON.parse(t);
    } catch {
      badLines++;
      continue;
    }
    if (!isSegmentShape(seg)) { badLines++; continue; }
    segments.push(seg);
  }
  return { segments, badLines };
}

/**
 * 合并相邻/重叠区间并升序（[1,3)+[3,5) → [1,5)）。
 * @param {object[]} segments
 * @returns {Array<[number, number]>}
 */
function mergeCovered(segments) {
  const ranges = segments
    .map((s) => [s.fromSeq, s.toSeq])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [from, to] of ranges) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) {
      if (to > last[1]) last[1] = to;
    } else {
      out.push([from, to]);
    }
  }
  return out;
}

/**
 * 由段集合构造 index（纯函数，唯一的外部输入是 clock）。键顺序固定 → 可逐字节重建。
 * @param {object[]} segments
 * @param {{now: () => string}} clock
 * @returns {{version: number, builtAt: string, segments: object[], coveredSeqs: Array<[number, number]>}}
 */
function buildIndex(segments, clock) {
  return {
    version: INDEX_VERSION,
    builtAt: clock.now(),
    segments: segments.map((s) => ({
      id: typeof s.id === 'string' ? s.id : null,
      fromSeq: s.fromSeq,
      toSeq: s.toSeq,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : null,
      mode: typeof s.mode === 'string' ? s.mode : 'rules',
      quarantined: s.quarantined === true,
    })),
    coveredSeqs: mergeCovered(segments),
  };
}

/** 原子写 index.json：先写 .tmp 再 rename（同目录，rename 是原子的） */
function writeIndex(memoHome, taskId, index) {
  const file = indexFilePath(memoHome, taskId);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n');
  renameSync(tmp, file);
  return index;
}

/**
 * 从 segments.jsonl 重建 index.json 并返回。逐字节确定：同段集合 + 同 clock → 同字节。
 * clock 由调用方注入（缺省系统时钟），因此测试可固定 builtAt。
 * @param {{memoHome: string, taskId: string, clock?: {now: () => string}}} args
 * @returns {object} index
 */
export function rebuildIndex({ memoHome, taskId, clock = systemClock } = {}) {
  const { segments } = readSegments({ memoHome, taskId });
  return writeIndex(memoHome, taskId, buildIndex(segments, clock));
}

/**
 * 读 index.json；缺失 / 损坏 / 形状明显不对 → null（派生层不可信时由调用方 rebuild）。
 * @param {{memoHome: string, taskId: string}} args
 * @returns {object|null}
 */
export function readIndex({ memoHome, taskId } = {}) {
  const file = indexFilePath(memoHome, taskId);
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * 已覆盖区间（index 优先；index 缺失/损坏时从段文件现算，不写盘）。
 * @param {{memoHome: string, taskId: string}} args
 * @returns {Array<[number, number]>}
 */
export function coveredSeqs({ memoHome, taskId } = {}) {
  // 真相是 segments.jsonl：index.json 只是派生缓存。若两者不一致（例如手动删了段文件、
  // 或上次写入中途崩溃），以段文件为准 —— 否则会「以为覆盖了」而静默漏捕获。
  const { segments, badLines } = readSegments({ memoHome, taskId });
  const fromSegments = mergeCovered(segments);
  const idx = readIndex({ memoHome, taskId });
  const idxCovered = idx && Array.isArray(idx.coveredSeqs) ? idx.coveredSeqs.length : 0;
  if (segments.length === 0 && badLines === 0 && idxCovered > 0) {
    // 段文件空了但索引还在 → 索引不可信，按「未覆盖」处理，让 capture 重新折
    return [];
  }
  if (idx && Array.isArray(idx.coveredSeqs) && idxCovered === fromSegments.length) {
    return idx.coveredSeqs
      .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] < r[1])
      .map((r) => [r[0], r[1]]);
  }
  return fromSegments;
}

/**
 * 绑定宿主会话（issue #225 后续）：把 hostSessionId 写进 sessions/<taskId>/meta.json，
 * 供 auto-capture 的 probeTranscript 精确定位转录——DSH_SESSION_ID 在 agent 的 bash env 里有、
 * 在宿主 spawn 的 MCP server 进程 env 里没有，server 进程 cwd 也不是会话目录，cwd slug 兜底
 * 会跟错文件。幂等：重复绑定同 id = 重写同值；换 id = 覆盖（一个任务同时只锚一个会话，
 * 换会话续做时由 agent 重新 bind）。
 * @param {{memoHome: string, taskId: string, hostSessionId: string, clock?: object}} args
 * @returns {{file: string, previous: string|null, meta: object}}
 */
export function bindSession({ memoHome, taskId, hostSessionId, clock = systemClock } = {}) {
  requireMemoHome(memoHome);
  requireTaskId(taskId);
  if (typeof hostSessionId !== 'string' || hostSessionId.trim() === '') {
    const e = new Error('bindSession: hostSessionId 必须是非空字符串');
    e.code = 'E_INVALID_ARG';
    throw e;
  }
  const sid = hostSessionId.trim();
  if (/[\r\n\0]/.test(sid) || sid.length > 200) {
    const e = new Error('bindSession: hostSessionId 含非法字符或超长（>200）');
    e.code = 'E_INVALID_ARG';
    throw e;
  }
  const dir = path.join(memoHome, 'sessions', taskId);
  const metaFile = path.join(dir, 'meta.json');
  const legacyFile = path.join(memoHome, 'sessions', `${taskId}.json`);
  const exists = existsSync(metaFile) || existsSync(path.join(dir, 'segments.jsonl')) || existsSync(legacyFile);
  if (!exists) {
    const e = new Error(`bindSession: 任务 ${taskId} 不存在（sessions/ 下无 meta、segments 与登记文件）`);
    e.code = 'E_NOT_FOUND';
    throw e;
  }
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  } catch {
    meta = {}; // 坏 meta → 重写为合法对象（绑定本身是显式维护动作）
  }
  const previous = typeof meta.hostSessionId === 'string' && meta.hostSessionId !== '' ? meta.hostSessionId : null;
  meta.taskId = taskId;
  if (typeof meta.title !== 'string' || meta.title === '') meta.title = taskId;
  if (typeof meta.status !== 'string' || meta.status === '') meta.status = 'open';
  if (typeof meta.startedAt !== 'string' || meta.startedAt === '') {
    meta.startedAt = new Date(clock.nowMs()).toISOString();
  }
  meta.hostSessionId = sid;
  meta.boundAt = new Date(clock.nowMs()).toISOString();
  mkdirSync(dir, { recursive: true, mode: MEMO_DIR_MODE });
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, { mode: MEMO_FILE_MODE });
  return { file: metaFile, previous, meta };
}

/**
 * 追加一段（锁内：判重叠 → append 一行 → 重建 index）。
 * 语义是幂等的：区间与已有段相交即抛 E_ALREADY_CAPTURED，且零写入（fail-closed）。
 * @param {{memoHome: string, taskId: string, segment: object, clock?: object}} args
 * @returns {Promise<{segment: object, index: object}>}
 */
export async function appendSegment({ memoHome, taskId, segment, clock = systemClock } = {}) {
  requireMemoHome(memoHome);
  requireTaskId(taskId);
  validateSegment(segment);

  return withLock(memoHome, async () => {
    const { segments } = readSegments({ memoHome, taskId });
    const fromSeq = segment.fromSeq;
    const toSeq = segment.toSeq;
    // 半开区间相交：a.from < b.to && b.from < a.to
    for (const ex of segments) {
      if (fromSeq < ex.toSeq && ex.fromSeq < toSeq) {
        throw err('E_ALREADY_CAPTURED',
          `区间 [${fromSeq}, ${toSeq}) 与已有段 ${ex.id ?? '<no-id>'} [${ex.fromSeq}, ${ex.toSeq}) 重叠，` +
          '该段已被捕获（E_ALREADY_CAPTURED）；重复 capture 是幂等的。');
      }
    }

    // 归一化键顺序：段文件一行一段，键序固定便于人工排查
    const record = {
      id: typeof segment.id === 'string' && segment.id !== '' ? segment.id : newId(clockMs(clock)),
      taskId: typeof segment.taskId === 'string' && segment.taskId !== '' ? segment.taskId : taskId,
      fromSeq,
      toSeq,
      createdAt: typeof segment.createdAt === 'string' && segment.createdAt !== ''
        ? segment.createdAt
        : clock.now(),
      source: segment.source ?? null,
      anchor: segment.anchor,
      summary: segment.summary,
      facts: Array.isArray(segment.facts) ? segment.facts : [],
      decisions: Array.isArray(segment.decisions) ? segment.decisions : [],
      gotchas: Array.isArray(segment.gotchas) ? segment.gotchas : [],
      pendingJobs: Array.isArray(segment.pendingJobs) ? segment.pendingJobs : [],
      files: Array.isArray(segment.files) ? segment.files : [],
      nextSteps: Array.isArray(segment.nextSteps) ? segment.nextSteps : [],
      tokens: segment.tokens ?? null,
      trust: typeof segment.trust === 'string' ? segment.trust : 'T1',
      taint: Array.isArray(segment.taint) ? segment.taint : [],
      quarantined: segment.quarantined === true,
      mode: typeof segment.mode === 'string' ? segment.mode : 'rules',
    };
    // LLM 回落原因等扩展字段保留（不参与 index）
    if (typeof segment.fallbackReason === 'string' && segment.fallbackReason !== '') {
      record.fallbackReason = segment.fallbackReason;
    }

    const file = segmentsFile(memoHome, taskId);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + '\n');
    // 追加后再重建派生层：段文件是真相，index 即使写失败也可后续 rebuild
    const index = writeIndex(memoHome, taskId, buildIndex([...segments, record], clock));
    return { segment: record, index };
  });
}

/** clock 的毫秒读数（兼容只实现 now() 的时钟端口） */
function clockMs(clock) {
  if (clock && typeof clock.nowMs === 'function') return clock.nowMs();
  if (clock && typeof clock.now === 'function') return Date.parse(clock.now());
  return Date.now();
}

/** 时间戳名：yyyymmdd-HHMMSS（本地时间，与 lifecycle.createSessionId 口径一致） */
function formatStamp(nowMs) {
  const d = new Date(nowMs);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * 归档任务：把 sessions/<taskId>/ 整个目录与 sessions/<taskId>.json meta 移到
 * $MEMO_HOME/archive/<taskId>-<yyyymmdd-HHMMSS>/（目录内 meta.json + segments.jsonl + index.json）。
 * 只移动、不删除（SPEC「归档不删」）。任务既无目录也无 meta → E_NOT_FOUND。
 * @param {{memoHome: string, taskId: string, clock?: object}} args
 * @returns {Promise<{movedTo: string, name: string}>} movedTo 绝对路径，name 为归档目录名
 */
export async function archiveTask({ memoHome, taskId, clock = systemClock } = {}) {
  requireMemoHome(memoHome);
  requireTaskId(taskId);

  return withLock(memoHome, async () => {
    const dir = taskDir(memoHome, taskId);
    const metaFile = path.join(memoHome, 'sessions', `${taskId}.json`);
    const hasDir = existsSync(dir);
    const hasMeta = existsSync(metaFile);
    if (!hasDir && !hasMeta) {
      throw err('E_NOT_FOUND', `archiveTask: 任务 ${taskId} 不存在（sessions/${taskId}/ 与 sessions/${taskId}.json 均缺失）`);
    }

    const name = `${taskId}-${formatStamp(clockMs(clock))}`;
    const archiveRoot = path.join(memoHome, 'archive');
    mkdirSync(archiveRoot, { recursive: true });
    const dest = path.join(archiveRoot, name);

    // 先整目录 rename（内容原样保留），再把同级 meta 放进去
    if (hasDir) renameSync(dir, dest);
    else mkdirSync(dest, { recursive: true });
    if (hasMeta) renameSync(metaFile, path.join(dest, 'meta.json'));

    return { movedTo: dest, name };
  });
}
