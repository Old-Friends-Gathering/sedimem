// session/expand.js — 账本段展开（B2，契约：versions/v1.2/docs/SEGMENT-SPEC.md §6）
//
// 只允许本地 CLI 调用（MCP 只回简报，不提供 expand）：按段的 anchor 重新读原始转录，
// 把 [anchor.fromSeq, anchor.toSeq) 区间内的 turn 还原成 `[seq] role: text` 行文本。
// 为什么重读转录而不在段里存原文：段是「不可变摘要」，转录才是真相层；展开必须与当时看到的一致，
// 且能跟随转录的 zstd 多帧格式（每帧独立压缩）。
//
// 错误契约（SPEC §7）：
//   - 任务/段不存在 → E_NOT_FOUND
//   - 转录缺失/无 zstd/锚点失效 → E_TRANSCRIPT_UNAVAILABLE
//   - 参数非法（segmentId、toFile、sessionsRoot）→ E_INVALID_ARG

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { readSegments } from './ledger.js';
import { parseJsonl, toTurns } from './transcript.js';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SEGMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TRANSCRIPT_FILENAME = 'session.v4.jsonl.zstd';

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * zstd 多帧解码（与 transcript.js 的内部实现同构；那边没导出，这里保留一份 ~25 行的最小实现）。
 * 帧 = 以 magic 28 b5 2f fd 开头的一段；rollout 里每帧独立压缩，逐帧解压再拼接。
 * 单帧解压失败时尝试把切点后移到下一个 magic，容忍损坏帧（与 transcript.js 的容错策略一致）。
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeZstdFrames(buf) {
  const starts = [];
  for (let at = buf.indexOf(ZSTD_MAGIC, 0); at !== -1; at = buf.indexOf(ZSTD_MAGIC, at + 4)) {
    starts.push(at);
  }
  if (starts.length === 0) return buf.toString('utf8');

  const chunks = [];
  let i = 0;
  while (i < starts.length) {
    let ok = false;
    for (let j = i + 1; j <= starts.length; j++) {
      const end = j < starts.length ? starts[j] : buf.length;
      try {
        chunks.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'));
        ok = true;
        i = j;
        break;
      } catch {
        // 切点太早 → 尝试把下一帧也包进来
      }
    }
    if (!ok) i++; // 彻底解不开的帧跳过（下一轮从下一个 magic 开始）
  }
  return chunks.join('');
}

/**
 * 读转录文本。识别「整体 zstd」（magic 开头）与「多帧 zstd」；不是 zstd 时按 UTF-8 纯 JSONL 读。
 * @param {string} file
 * @returns {{text: string, zstd: boolean}}
 */
function readTranscriptText(file) {
  const buf = readFileSync(file);
  const headIsZstd = buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
  if (typeof zlib.zstdDecompressSync !== 'function') {
    if (headIsZstd) {
      throw err('E_TRANSCRIPT_UNAVAILABLE', `expand: 当前 Node 不支持 zstd（需 ≥22 内置 zlib），无法读 ${file}`);
    }
    return { text: buf.toString('utf8'), zstd: false };
  }
  if (headIsZstd) return { text: decodeZstdFrames(buf), zstd: true };
  // 非 zstd：可能整块就是一帧（无 magic 变体），试一次，失败按纯文本
  try {
    return { text: zlib.zstdDecompressSync(buf).toString('utf8'), zstd: true };
  } catch {
    return { text: buf.toString('utf8'), zstd: false };
  }
}

/**
 * 解析 anchor.path 到真实转录文件。
 * 解析顺序：绝对路径 → sessionsRoot 相对 → <memoHome>/sessions/<taskId>/ 相对 → <memoHome> 相对。
 * 如果解析结果是个目录，找目录下的 session.v4.jsonl.zstd。
 * @param {string} anchorPath
 * @param {{memoHome: string, taskId: string, sessionsRoot?: string}} ctx
 * @returns {string}
 */
function resolveAnchorFile(anchorPath, { memoHome, taskId, sessionsRoot }) {
  const tried = [];
  const candidates = [];
  if (path.isAbsolute(anchorPath)) {
    candidates.push(anchorPath);
  } else {
    if (typeof sessionsRoot === 'string' && sessionsRoot !== '') {
      candidates.push(path.resolve(sessionsRoot, anchorPath));
    }
    candidates.push(path.resolve(memoHome, 'sessions', taskId, anchorPath));
    candidates.push(path.resolve(memoHome, anchorPath));
  }
  for (const candidate of candidates) {
    tried.push(candidate);
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      continue;
    }
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const nested = path.join(candidate, TRANSCRIPT_FILENAME);
      tried.push(nested);
      if (existsSync(nested)) return nested;
    }
  }
  throw err('E_TRANSCRIPT_UNAVAILABLE',
    `expand: 找不到段 anchor 指向的转录文件 ${JSON.stringify(anchorPath)}（已尝试：${tried.join(' , ')}）`);
}

/**
 * 从 JSONL 记录还原「带 seq 的 turn」。transcript.js 的 toTurns 会丢掉 rec.seq，
 * 而展开必须对齐 seq，所以逐条记录跑 toTurns([rec])：一个记录最多产出一个 turn。
 * 记录没有数字 seq 时（旧格式/Codex）退回「第 N 个产生 turn 的记录」的序号，保证区间过滤仍可用。
 * @param {object[]} records
 * @returns {Array<{seq: number, role: string, text: string}>}
 */
function turnsWithSeq(records) {
  const out = [];
  let ordinal = 0;
  for (const rec of records) {
    let turns;
    try {
      ({ turns } = toTurns([rec]));
    } catch {
      continue; // 单条坏记录不影响整段展开
    }
    if (!Array.isArray(turns) || turns.length === 0) continue;
    const t = turns[0];
    const text = typeof t.text === 'string' ? t.text : String(t.text ?? '');
    if (text === '') continue;
    const seq = Number.isFinite(rec.seq) ? rec.seq : ordinal;
    ordinal++;
    out.push({ seq, role: typeof t.role === 'string' && t.role !== '' ? t.role : 'unknown', text });
  }
  return out;
}

/**
 * 展开一个账本段（SPEC §6）。
 *
 * @param {object} args
 * @param {string} args.memoHome $MEMO_HOME
 * @param {string} args.taskId 任务 id
 * @param {string} args.segmentId 段 id（seg_ 前缀 ULID 风格）
 * @param {boolean|string} [args.toFile] true → 写到 sessions/<taskId>/expanded/<segmentId>.txt；字符串 → 显式输出路径
 * @param {string} [args.sessionsRoot] 转录根目录（anchor.path 为相对路径时的第一基准）
 * @returns {{text: string, chars: number, file?: string}}
 */
export function expandSegment({ memoHome, taskId, segmentId, toFile = false, sessionsRoot } = {}) {
  if (typeof memoHome !== 'string' || memoHome === '') {
    throw err('E_INVALID_ARG', `expandSegment: memoHome 必须是非空字符串，收到 ${JSON.stringify(memoHome)}`);
  }
  if (typeof taskId !== 'string' || taskId === '') {
    throw err('E_INVALID_ARG', `expandSegment: taskId 必须是非空字符串，收到 ${JSON.stringify(taskId)}`);
  }
  if (typeof segmentId !== 'string' || !SEGMENT_ID_RE.test(segmentId)) {
    throw err('E_INVALID_ARG',
      `expandSegment: segmentId 必须是 1-64 位 [A-Za-z0-9_-]，收到 ${JSON.stringify(segmentId)}`);
  }
  let wantsFile = null;
  if (toFile === true) wantsFile = 'auto';
  else if (typeof toFile === 'string' && toFile !== '') wantsFile = 'explicit';
  else if (toFile === false || toFile === undefined || toFile === null) wantsFile = null;
  else throw err('E_INVALID_ARG', `expandSegment: toFile 必须是 boolean 或非空路径字符串，收到 ${JSON.stringify(toFile)}`);

  // ---- 找段（readSegments 是唯一真相层；坏行由 ledger 层跳过）----
  let segments = [];
  try {
    const res = readSegments({ memoHome, taskId });
    segments = Array.isArray(res?.segments) ? res.segments : [];
  } catch (e) {
    if (e && (e.code === 'E_NOT_FOUND' || e.code === 'ENOENT')) {
      throw err('E_NOT_FOUND', `expandSegment: 任务 ${taskId} 不存在（${path.join(memoHome, 'sessions', taskId)}）`);
    }
    throw e;
  }
  const segment = segments.find((s) => s && typeof s === 'object' && s.id === segmentId);
  if (!segment) {
    throw err('E_NOT_FOUND', `expandSegment: 任务 ${taskId} 下不存在段 ${segmentId}`);
  }

  const anchor = segment.anchor;
  if (!anchor || typeof anchor !== 'object' || typeof anchor.path !== 'string' || anchor.path === '') {
    throw err('E_TRANSCRIPT_UNAVAILABLE',
      `expandSegment: 段 ${segmentId} 缺 anchor.path，无法定位转录（段契约被破坏）`);
  }
  const fromSeq = Number.isFinite(anchor.fromSeq) ? anchor.fromSeq : segment.fromSeq;
  const toSeq = Number.isFinite(anchor.toSeq) ? anchor.toSeq : segment.toSeq;
  if (!Number.isFinite(fromSeq) || !Number.isFinite(toSeq) || !(fromSeq < toSeq)) {
    throw err('E_TRANSCRIPT_UNAVAILABLE',
      `expandSegment: 段 ${segmentId} 的 anchor 区间非法 (${fromSeq}, ${toSeq})`);
  }

  // ---- 重读转录 → 取 [fromSeq, toSeq) 的 turn ----
  const file = resolveAnchorFile(anchor.path, { memoHome, taskId, sessionsRoot });
  let text;
  try {
    text = readTranscriptText(file).text;
  } catch (e) {
    if (e && e.code === 'E_TRANSCRIPT_UNAVAILABLE') throw e;
    throw err('E_TRANSCRIPT_UNAVAILABLE', `expandSegment: 读转录失败 ${file}：${e && e.message ? e.message : e}`);
  }
  const { records } = parseJsonl(text);
  const turns = turnsWithSeq(records);
  const inRange = turns.filter((t) => t.seq >= fromSeq && t.seq < toSeq);
  const body = inRange.map((t) => `[${t.seq}] ${t.role}: ${t.text}`).join('\n');

  // ---- 可选写文件（本地 CLI 默认行为；MCP 永不走到这里）----
  if (wantsFile !== null) {
    let filePath;
    if (wantsFile === 'auto') {
      const dir = path.join(memoHome, 'sessions', taskId, 'expanded');
      mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, `${segmentId}.txt`);
    } else {
      filePath = toFile;
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    writeFileSync(filePath, body);
    return { text: body, chars: body.length, file: filePath };
  }
  return { text: body, chars: body.length };
}
