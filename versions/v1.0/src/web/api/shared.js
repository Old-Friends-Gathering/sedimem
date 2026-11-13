// web/api/shared.js — 端点实现共享的参数解析/label/metrics 工具（从 web/handlers.js 拆出）。
// 只 import 同层或更底层（config/views），禁止 mcp/cli。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsFileName, legacyMetricsFileName } from '../../config/paths.js';

export const V0_1_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

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

export function invalidArg(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_ARG';
  return err;
}

/** 整数参数校验：返回 number 或抛 E_INVALID_ARG。 */
export function intArg(query, name, { min = 1, max = 10000, fallback } = {}) {
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
export function todayInTz(tzOffset, nowMs = Date.now()) {
  return new Date(nowMs - tzOffset * 60000).toISOString().slice(0, 10);
}

export function parseTzOffset(query) {
  const raw = query.get('tzOffset');
  if (raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || Math.abs(n) > 1440) {
    throw invalidArg(`tzOffset must be an integer of minutes in [-1440, 1440], got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function parseDateArg(query, { required = false, fallback } = {}) {
  const raw = query.get('date');
  if (raw === null || raw === '') {
    if (required) throw invalidArg('missing required query param: date');
    return fallback;
  }
  if (!validDate(raw)) throw invalidArg(`date must be a valid YYYY-MM-DD, got ${JSON.stringify(raw)}`);
  return raw;
}

/** 版本号：读 package.json 的 version（只读一次，缓存）。 */
let cachedVersion = null;
export function appVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = JSON.parse(fs.readFileSync(path.join(V0_1_ROOT, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

/**
 * 事件 → 记录索引（id → 投影记录）。
 * 缺陷修复（审查 L5）：原实现 `service.get(ev.id)` 是 async，未 await 直接 makeLabel → 永久空 label。
 * 改为一次性 exportRecords({status:'all'}) 建索引，顺带避免 N 次读。
 */
export async function recordIndex(service) {
  const { records } = await service.exportRecords({ status: 'all', limit: 1000000, includeSuspicious: false });
  return new Map(records.map((r) => [r.id, r]));
}

/** 一次裁决（curate_apply）在事件流里会写 loser + winner 两条，这里按「裁决键」聚合。 */
export function decisionKey(ev) {
  const d = ev.detail ?? {};
  if (d.batchId) {
    const pairKey = Array.isArray(d.ids) ? [...d.ids].map(String).sort().join(',') : '';
    return `${d.batchId}#${d.pairIndex ?? pairKey}`;
  }
  if (Array.isArray(d.ids)) return `ids:${[...d.ids].map(String).sort().join(',')}`;
  return `ev:${ev.id ?? ''}:${ev.ts}`;
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

export const MERGE_OPS = new Set(['curate_apply']);

export function dateShift(date, deltaDays) {
  const ms = Date.parse(`${date}T00:00:00Z`) + deltaDays * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
