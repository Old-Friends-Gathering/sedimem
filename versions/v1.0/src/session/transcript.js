// session/transcript.js — 会话转录读取与压缩（W4）
// 读取 DSH（session.v4.jsonl.zstd）与 Codex（rollout-*.jsonl）两类会话记录，
// 抽成统一的 {role, text, ts} turns；compactTranscript 超限时保留头尾、省略中间。
// 零依赖（只用 node 内置）；坏行跳过并计数，不抛栈。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as zlib from 'node:zlib';

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/** 从一行记录里尽力抽 {role, text, ts}；抽不出有效文本返回 null */
function recordToTurn(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const ts = typeof rec.ts === 'string' ? rec.ts
    : (typeof rec.timestamp === 'string' ? rec.timestamp : undefined);
  // 形状 1：user_message / assistant_message（带 message 或 content 字段）
  const kind = rec.type ?? rec.role ?? '';
  if (typeof kind === 'string') {
    if (kind === 'user_message' || kind === 'assistant_message') {
      const text = typeof rec.message === 'string' ? rec.message
        : typeof rec.content === 'string' ? rec.content : null;
      if (text) return { role: kind === 'user_message' ? 'user' : 'assistant', text, ts };
    }
    // 形状 2：response_item / message（payload 或自身携带 role + content 数组/字符串）
    const body = rec.payload && typeof rec.payload === 'object' ? rec.payload : rec;
    const role = body.role === 'user' || body.role === 'assistant' ? body.role : null;
    if (role) {
      const c = body.content;
      let text = null;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        // content 数组：取各块的 text / content 字段拼起来
        const parts = c.map((b) => (b && typeof b === 'object'
          && typeof (b.text ?? b.content) === 'string') ? (b.text ?? b.content) : null)
          .filter((s) => s !== null);
        if (parts.length > 0) text = parts.join('\n');
      }
      if (text) return { role, text, ts };
    }
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

/**
 * 读 DSH 会话转录：~/.dsh/sessions/<cwd-slug>/<uuid>/session.v4.jsonl.zstd。
 * node:zlib 没有 zstdDecompressSync（Node 版本不够）时抛 E_TRANSCRIPT_UNAVAILABLE。
 * @param {{sessionsRoot: string, cwd: string, sessionId: string}} args
 * @returns {{records: object[], badLines: number, file: string}}
 */
export function readDshTranscript({ sessionsRoot, cwd, sessionId }) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw err('E_TRANSCRIPT_UNAVAILABLE',
      '当前 Node 版本的 node:zlib 不提供 zstdDecompressSync，无法解压 DSH 转录（需 Node >= 22.15）');
  }
  if (!sessionsRoot || !cwd || !sessionId) {
    throw err('E_INVALID_ARG', 'readDshTranscript: sessionsRoot/cwd/sessionId 均必填');
  }
  // cwd → slug：非字母数字折成 '-'（与 DSH 的目录命名一致，宽松匹配）
  const slug = String(cwd).replace(/[^A-Za-z0-9._-]+/g, '-');
  const dir = path.join(sessionsRoot, slug, String(sessionId));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  if (!existsSync(file)) {
    throw err('E_TRANSCRIPT_UNAVAILABLE', `DSH 转录不存在: ${file}`);
  }
  const zipped = readFileSync(file);
  const raw = zlib.zstdDecompressSync(zipped).toString('utf8');
  const { records, badLines } = parseJsonl(raw);
  return { records, badLines, file };
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
 * @param {object[]} records
 * @returns {{turns: Array<{role: string, text: string, ts?: string}>}}
 */
export function toTurns(records) {
  const turns = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const turn = recordToTurn(rec);
    if (turn) turns.push(turn);
  }
  return { turns };
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
