// session/transcript.js — 会话转录读取与压缩（W4 / B0）
// 读取 DSH（session.v4.jsonl.zstd，多帧 zstd）与 Codex（rollout-*.jsonl）两类会话记录，
// 抽成统一的 {role, text, ts} turns；compactTranscript 超限时保留头尾、省略中间。
// 零依赖（只用 node 内置）；坏行/坏帧跳过并计数，不抛栈。
//
// B0 修复的三处真实数据不匹配（2026-11 实测）：
//   1. DSH 目录 slug 两侧各有一个 `--`（`--Users-yeager-work-yeager-ldywoker--`）；
//   2. 一个文件内含多帧 zstd（当前会话实测 17k+ 帧），必须按 magic 切帧逐帧解；
//   3. 事件 schema 是 `{type:"user/message", time, data:{content:[{type:"text",text}]}}`
//      （assistant 文本在 `data.message.content`），不是旧的 `user_message` 形状。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as zlib from 'node:zlib';

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/** 跳过的事件类型：这些不是对话 turn（工具调用/审批/沙箱/状态机事件） */
const SKIP_TYPES = new Set(['turn/start', 'turn/end', 'session']);
const SKIP_PREFIXES = [
  'permission/', 'sandbox/', 'approval/', 'model/',
  'agent/inbox/', 'tool/',
];

function isSkippedType(type) {
  if (SKIP_TYPES.has(type)) return true;
  return SKIP_PREFIXES.some((p) => type.startsWith(p));
}

/**
 * cwd → DSH 会话目录名：非 [A-Za-z0-9._-] 折成 '-'，去掉首尾多余的 '-',
 * 再在两侧各加一个 '--'（与 DSH 实际目录命名一致）。
 * 例：绝对路径 `<root>/work/my-project` 折成 `--<root>-work-my-project--`（首尾各加一个 --）
 * @param {string} cwd
 * @returns {string}
 */
export function cwdToSessionSlug(cwd) {
  if (typeof cwd !== 'string' || cwd === '') {
    throw err('E_INVALID_ARG', 'cwdToSessionSlug: cwd 必须是非空字符串');
  }
  const core = cwd.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `--${core}--`;
}

/** 宽松匹配用：去掉所有非字母数字字符并小写（同时抹掉 '-' 与路径分隔符） */
function normalizeForMatch(s) {
  return String(s).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** 时间统一成 ISO 字符串（rec.time 毫秒数）或保留原字符串；取不到返回 undefined */
function normalizeTs(rec) {
  if (typeof rec.time === 'number' && Number.isFinite(rec.time)) {
    return new Date(rec.time).toISOString();
  }
  if (typeof rec.time === 'string' && rec.time !== '') return rec.time;
  for (const key of ['ts', 'timestamp']) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  }
  return undefined;
}

/**
 * 从 content（字符串或块数组）里抽文本：只取 `type:'text'` 的块，join('\n')。
 * 不是 DSH 的 text 块（reasoning / tool-call / image …）一律忽略。
 */
function textFromContent(content) {
  if (typeof content === 'string') return content === '' ? null : content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * 从一条记录里尽力抽 {role, text, ts}；抽不出有效文本返回 null。
 * 新 DSH schema 优先，旧形状（user_message / payload.role）最后兜底。
 */
function recordToTurn(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (type !== '' && isSkippedType(type)) return null;
  const ts = normalizeTs(rec);
  const data = rec.data && typeof rec.data === 'object' ? rec.data : null;

  // 形状 1（DSH v4 真实 schema）：
  //   user/message      → data.content[{type:'text',text}]
  //   assistant/message → data.content 或 data.message.content（真实数据用后者）
  //   agent/message     → 同 assistant 形状（存在时）
  if (type === 'user/message' || type === 'assistant/message' || type === 'agent/message') {
    const role = type === 'user/message' ? 'user' : 'assistant';
    const candidates = [
      data && data.content,
      data && data.message && data.message.content,
      data && data.text,
      data && data.message && data.message.text,
      rec.content,
      rec.message,
    ];
    for (const c of candidates) {
      const text = typeof c === 'string'
        ? (c === '' ? null : c)
        : textFromContent(c);
      if (text) return { role, text, ts };
    }
  }

  // 形状 2（旧 schema）：user_message / assistant_message（message 或 content 字符串）
  if (type === 'user_message' || type === 'assistant_message') {
    const text = typeof rec.message === 'string' ? rec.message
      : (typeof rec.content === 'string' ? rec.content : null);
    if (text) return { role: type === 'user_message' ? 'user' : 'assistant', text, ts };
  }

  // 形状 3（旧 schema 兜底）：response_item / message（payload 或自身携带 role + content）
  const body = rec.payload && typeof rec.payload === 'object' ? rec.payload : rec;
  const role = body.role === 'user' || body.role === 'assistant' ? body.role : null;
  if (role) {
    const c = body.content;
    let text = null;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      // 旧形状不限块类型：取各块的 text / content 字段拼起来
      const parts = c.map((b) => (b && typeof b === 'object'
        && typeof (b.text ?? b.content) === 'string') ? (b.text ?? b.content) : null)
        .filter((s) => s !== null);
      if (parts.length > 0) text = parts.join('\n');
    }
    if (text) return { role, text, ts };
  }
  return null;
}

/**
 * 逐行解析 JSONL 文本，坏行跳过并计数。
 * @param {string} raw
 * @returns {{records: object[], badLines: number}}
 */
export function parseJsonl(raw) {
  const records = [];
  let badLines = 0;
  for (const line of String(raw).split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec === 'object') records.push(rec);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { records, badLines };
}

/** zstd 帧 magic：0x28 0xB5 0x2F 0xFD */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找出 buffer 里所有帧 magic 的起始偏移（Buffer.indexOf 是原生实现，比逐字节快） */
function findFrameStarts(buf) {
  const starts = [];
  let at = buf.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + 4);
  }
  return starts;
}

/**
 * 多帧 zstd → 完整 UTF-8 文本：按 magic 切帧、逐帧解压、数组 push 后 join。
 * 压缩载荷里偶然出现 magic 时先按下一个 magic 切会解压失败；此时把结束点扩到
 * 更后面的 magic 重试，避免把一帧误切成两帧而丢数据。
 * @param {Buffer} buf
 * @returns {{text: string, frames: number, badFrames: number, bytes: number}}
 */
function decompressZstdFrames(buf) {
  let starts = findFrameStarts(buf);
  if (starts.length === 0) starts = [0]; // 没有 magic（旧格式/异常）：整块当一帧试一次
  const chunks = [];
  let frames = 0;
  let badFrames = 0;
  let bytes = 0;
  let i = 0;
  while (i < starts.length) {
    frames++;
    let ok = false;
    // 结束点从「下一个 magic」开始尝试；失败就吞掉后续 magic 继续扩（应对误切）
    for (let j = i + 1; j <= starts.length; j++) {
      const end = j < starts.length ? starts[j] : buf.length;
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(starts[i], end));
        bytes += out.length;
        chunks.push(out.toString('utf8'));
        ok = true;
        i = j;
        break;
      } catch {
        // 该切分不是完整帧，继续尝试更长的切分
      }
    }
    if (!ok) { badFrames++; i++; }
  }
  return { text: chunks.join(''), frames, badFrames, bytes };
}

/**
 * 在 sessionsRoot 下线性扫目录做宽松兜底：目录名归一化后以 cwd 归一化名结尾（或包含）即候选。
 * @returns {string|null} 命中的目录名
 */
function findLooseSessionDir(sessionsRoot, cwd) {
  let entries;
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const cwdKey = normalizeForMatch(cwd);
  if (cwdKey === '') return null;
  let best = null;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const key = normalizeForMatch(ent.name);
    if (key === '') continue;
    if (key === cwdKey) return ent.name; // 归一化后完全一致，最优
    if (key.endsWith(cwdKey) || key.includes(cwdKey)) {
      if (!best || key.length > best.key.length) best = { name: ent.name, key };
    }
  }
  return best ? best.name : null;
}

/**
 * 读 DSH 会话转录：<sessionsRoot>/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd。
 * 先按 cwdToSessionSlug 精确找；找不到再在 sessionsRoot 里线性扫目录做宽松兜底。
 * 多帧 zstd：按 magic 切帧、逐帧解压、拼接；坏帧跳过并计数。
 * @param {{sessionsRoot: string, cwd: string, sessionId: string}} args
 * @returns {{turns: Array<{role: string, text: string, ts?: string}>,
 *            frames: number, badFrames: number, bytes: number, events: number}}
 *   frames=帧候选数，badFrames=解压失败的帧数，bytes=解压后 UTF-8 字节数，
 *   events=解析出的 JSONL 事件条数。
 */
export function readDshTranscript({ sessionsRoot, cwd, sessionId }) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw err('E_TRANSCRIPT_UNAVAILABLE',
      '当前 Node 版本的 node:zlib 不提供 zstdDecompressSync，无法解压 DSH 转录（需 Node >= 22.15）');
  }
  if (!sessionsRoot || !cwd) {
    throw err('E_INVALID_ARG', 'readDshTranscript: sessionsRoot/cwd 必填');
  }
  const fileName = 'session.v4.jsonl.zstd';
  const tried = [];
  // 1) 精确 slug 目录；2) 宽松兜底目录；3) 都没有则给可诊断错误
  let baseDir = path.join(sessionsRoot, cwdToSessionSlug(cwd));
  if (!existsSync(baseDir)) {
    const looseDir = findLooseSessionDir(sessionsRoot, cwd);
    if (looseDir) baseDir = path.join(sessionsRoot, looseDir);
  }
  tried.push(baseDir);
  let resolvedId = sessionId ? String(sessionId) : null;
  if (!resolvedId) {
    // 省略 sessionId：取该 cwd 下最新的会话（按转录文件 mtime 降序）
    const cands = existsSync(baseDir)
      ? readdirSync(baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const f = path.join(baseDir, d.name, fileName);
          let mtime = 0;
          try { mtime = statSync(f).mtimeMs; } catch { /* 没有转录就跳过 */ }
          return { id: d.name, mtime };
        })
        .filter((c) => c.mtime > 0)
        .sort((a, b) => b.mtime - a.mtime)
      : [];
    if (cands.length === 0) {
      throw err('E_TRANSCRIPT_UNAVAILABLE', `DSH 会话目录里没有 ${fileName}: ${baseDir}`);
    }
    resolvedId = cands[0].id;
  }
  const file = path.join(baseDir, resolvedId, fileName);
  if (!existsSync(file)) {
    throw err('E_TRANSCRIPT_UNAVAILABLE',
      `DSH 转录不存在（已尝试 ${tried.join(' ; ')} 下的 ${resolvedId}/${fileName}）`);
  }
  const { text, frames, badFrames, bytes } = decompressZstdFrames(readFileSync(file));
  const { records } = parseJsonl(text);
  const { turns } = toTurns(records);
  return { turns, frames, badFrames, bytes, events: records.length, sessionId: resolvedId, file };
}

/**
 * 读 Codex 会话 rollout：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl。
 * @param {{sessionsRoot: string, date?: string, file?: string}} args
 *   date 形如 'YYYY-MM-DD'（省略 file 时按日期定位目录，取目录里第一个 rollout-*.jsonl）
 * @returns {{records: object[], badLines: number, file: string}}
 */
export function readCodexRollout({ sessionsRoot, date, file }) {
  if (!sessionsRoot) throw err('E_INVALID_ARG', 'readCodexRollout: sessionsRoot 必填');
  let target = file;
  if (!target) {
    const m = typeof date === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) throw err('E_INVALID_ARG', 'readCodexRollout: 需要 file 或形如 YYYY-MM-DD 的 date');
    const dir = path.join(sessionsRoot, m[1], m[2], m[3]);
    if (!existsSync(dir)) throw err('E_TRANSCRIPT_UNAVAILABLE', `Codex rollout 目录不存在: ${dir}`);
    const names = readdirSync(dir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl')).sort();
    if (names.length === 0) throw err('E_TRANSCRIPT_UNAVAILABLE', `目录里没有 rollout-*.jsonl: ${dir}`);
    target = path.join(dir, names[0]);
  }
  if (!existsSync(target)) throw err('E_TRANSCRIPT_UNAVAILABLE', `Codex rollout 不存在: ${target}`);
  const { records, badLines } = parseJsonl(readFileSync(target, 'utf8'));
  return { records, badLines, file: target };
}

/**
 * 从记录集合抽统一 turns：{role, text, ts}；抽不出文本的记录跳过。
 * 有 seq 的按 seq 升序（稳定排序）；没有 seq 的保持原相对顺序。
 * @param {object[]} records
 * @returns {{turns: Array<{role: string, text: string, ts?: string}>}}
 */
export function toTurns(records) {
  const entries = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const turn = recordToTurn(rec);
    if (!turn) continue;
    const seq = rec && typeof rec.seq === 'number' && Number.isFinite(rec.seq) ? rec.seq : null;
    entries.push({ turn, seq, idx: entries.length });
  }
  if (entries.some((e) => e.seq !== null)) {
    entries.sort((a, b) => {
      if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
      return a.idx - b.idx; // 缺 seq 的按原始顺序参与
    });
  }
  return { turns: entries.map((e) => e.turn) };
}

/**
 * 压缩 turns 成一段文本：超 maxChars 时保留头 N 行 + 中间省略说明 + 尾 M 行。
 * @param {Array<{role: string, text: string, ts?: string}>} turns
 * @param {{maxChars?: number}} [opts] maxChars 缺省 12000
 * @returns {string}
 */
export function compactTranscript(turns, { maxChars = 12000 } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const render = (t) => `[${t.role}${t.ts ? ` ${t.ts}` : ''}] ${String(t.text).replace(/\s+/g, ' ').trim()}`;
  const lines = list.map(render);
  let out = lines.join('\n');
  if (out.length <= maxChars) return out;
  // 头 1/3 + 尾 1/3 预算，逐行装填直到逼近上限
  const budget = Math.max(200, maxChars - 200); // 留给省略说明
  const half = Math.floor(budget / 2);
  const head = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > half || head.length >= lines.length) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail = [];
  used = 0;
  for (let i = lines.length - 1; i > head.length; i--) {
    const line = lines[i];
    if (used + line.length + 1 > half) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  return [
    ...head,
    `……（中间省略 ${omitted} 行，原始共 ${lines.length} 行）……`,
    ...tail,
  ].join('\n');
}
