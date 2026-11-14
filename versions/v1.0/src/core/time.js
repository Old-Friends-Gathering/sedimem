// core/time.js — 时间解析 / 比较的单点实现（W2 单点化，行为零变化）。
// parseComparable 原样搬自 src/hygiene/conflict.js（conflict.js 改为 re-export）；
// parseAsOf / nowIso / isExpired / DAY_MS 收敛 src/api/* 里手写的 Date.parse 调用。

/**
 * 把字符串值解析为可比较量（原样搬自 hygiene/conflict.js）。
 * 支持：纯数字（含负数/小数）；ISO 日期时间；m/d、m/d/yyyy、yyyy/m/d 日期。
 * 解析不了 → { type: null }（调用方必须走 dispute 分支）。
 * @returns {{type:'number'|'date'|null, n?:number}}
 */
export function parseComparable(value) {
  if (value === null || value === undefined) return { type: null };
  const s = String(value).trim();
  if (s === '') return { type: null };

  // 数字：123 / -1.5 / 1,000.25
  const numStr = s.replace(/,/g, '');
  if (/^[+-]?\d+(\.\d+)?$/.test(numStr) && Number.isFinite(Number(numStr))) {
    return { type: 'number', n: Number(numStr) };
  }

  // ISO 日期/时间：2026-03-01、2026-03-01T00:00:00Z、2026-03、20260301
  const iso = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ].*)?$/);
  if (iso) {
    const t = Date.parse(s.includes('T') || s.includes(' ') ? s : `${s}T00:00:00Z`);
    if (Number.isFinite(t)) return { type: 'date', n: t };
    // yyyy-mm 形式
    const ym = Date.parse(`${s}-01T00:00:00Z`);
    if (Number.isFinite(ym)) return { type: 'date', n: ym };
  }
  if (/^\d{8}$/.test(s)) {
    const t = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
    if (Number.isFinite(t)) return { type: 'date', n: t };
  }

  // m/d 或 m/d/yyyy（月/日，eval I2 的「截止 3/1 → 4/1」语义）；缺年按 2000 固定锚年，
  // 保证同年内比较单调且与年份无关（两侧同格式时可比）。
  const md = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    const year = md[3] ? Number(md[3]) : 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { type: 'date', n: Date.UTC(year, month - 1, day) };
    }
  }
  // yyyy/m/d
  const ymd = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (ymd) {
    const t = Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    if (Number.isFinite(t)) return { type: 'date', n: t };
  }

  // 其他一切（含自由文本、真布尔语义等）不可解析
  return { type: null };
}

/**
 * 把任意「asOf / 时间戳」字符串按 Date.parse 归一化到 UTC 毫秒（裁决 17）。
 * 非字符串或解析失败 → 抛 Error（code='E_INVALID_ARG'），错误文本由调用方经
 * label 注入（如 'search: asOf'），保持既有 message 逐字不变。
 * @param {string} value
 * @param {string} [label] 错误信息前缀，默认 'asOf'
 * @returns {number} UTC 毫秒
 */
export function parseAsOf(value, label = 'asOf') {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (typeof value !== 'string' || Number.isNaN(ms)) {
    const err = new Error(`${label} must be an ISO-8601 string, got ${JSON.stringify(value)}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  return ms; // 归一化到 UTC（支持 +08:00 等偏移量）
}

/**
 * 有效期判定：validTo 为空（null/undefined/''）→ 未过期；
 * 解析失败 → 未过期（宁不误杀）；validTo <= now → 已过期。
 * @param {string|null|undefined} validTo
 * @param {number} now 当前毫秒
 * @returns {boolean}
 */
export function isExpired(validTo, now) {
  if (validTo === null || validTo === undefined || validTo === '') return false;
  const ms = Date.parse(String(validTo));
  if (!Number.isFinite(ms)) return false;
  return ms <= now;
}

/**
 * 当前时间的 ISO-8601 UTC 串。优先 clock.nowMs()，缺省系统时间。
 * 与 createClock().now() 输出完全一致。
 * @param {{nowMs?: Function, now?: Function}} [clock]
 * @returns {string}
 */
export function nowIso(clock) {
  const ms = typeof clock?.nowMs === 'function' ? clock.nowMs() : Date.now();
  return new Date(ms).toISOString();
}

/** 一天的毫秒数（purge 宽限期等常量的单一来源）。 */
export const DAY_MS = 86_400_000;
