// llm/derive.js — LLM 派生：prompt 构造 + 输出应用（契约：docs/plans/v1.0.0-refactor.md §2.x）
//
// 本模块是纯逻辑层：不 import storage / api，LLM 通过 port 端口注入（测试不联网）。
// 端口形状（对接 src/llm/port.js 的 createLlmPort，这里只依赖鸭子类型）：
//   port = {
//     ready: boolean,                       // false → deriveStatus='no-provider'
//     model?: string,                       // 写进派生记录做审计
//     allowPrivate?: boolean,               // false 且 record.privacy==='private' → 'privacy-blocked'
//     async complete({purpose, system, user}):
//       Promise<{ok: true, text: string} |
//               {ok: false, blocked?: boolean, error?: {code: string, message: string}}>
//   }
// 预算被拒（budget.js 返回 blocked:true / error.code='E_LLM_BUDGET_EXCEEDED'）→ 'budget-exceeded'。
//
// 硬规则：
// - 输出 schema 只允许 title/summary/tags/spo/kindHint；
//   出现 kind/text/value/status/validTo 等真相字段 → 非法输出，deriveStatus='failed'，
//   且结果里不得写入任何真相字段（失败兜底内容只来自 record 自身的安全子集）；
// - title 超 40 字截断标 titleTruncated；summary 超 80 字同理；tags 最多 5 个；
// - kindHint 只做审计：与 record.kind 不同记 kindMismatch:true，不改 kind；
// - 本函数永不抛异常，任何失败都返回一条 deriveStatus 非 ok 的派生记录。

import { createHash } from 'node:crypto';

export const DERIVE_PROMPT_VERSION = 'd1-v1';

const MAX_TITLE = 40;
const MAX_SUMMARY = 80;
const MAX_TAGS = 5;

/** 禁止出现在 LLM 输出里的真相层字段（出现即判非法） */
const FORBIDDEN_KEYS = new Set(['kind', 'text', 'value', 'status', 'validTo', 'validFrom', 'id']);

/** 规则兜底标题：record.title → subject+predicate → text 前 24 字 */
function fallbackTitle(record) {
  if (typeof record.title === 'string' && record.title.trim() !== '') return record.title.trim();
  const sp = [record.subject, record.predicate]
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .join(' ').trim();
  if (sp !== '') return sp;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  return text.slice(0, 24);
}

/** 规则兜底摘要：text 前 60 字（无 text 用 value，再退空串） */
function fallbackSummary(record) {
  const text = typeof record.text === 'string' && record.text.trim() !== ''
    ? record.text
    : (typeof record.value === 'string' ? record.value : '');
  return text.trim().slice(0, 60);
}

/**
 * 从 LLM 输出文本里提取第一个 JSON 对象（容忍代码围栏 / 前后废话）。
 * @returns {object|null} 解析失败返回 null
 */
function extractJson(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  // 从每个 '{' 起尝试配平括号取完整对象（简单计数，容忍字符串内的花括号）
  for (let i = start; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const obj = JSON.parse(raw.slice(i, j + 1));
            return obj && typeof obj === 'object' ? obj : null;
          } catch { break; /* 该起点非法，尝试下一个 '{' */ }
        }
      }
    }
  }
  return null;
}

/** tags 清洗：字符串数组、去空、去重、最多 MAX_TAGS 个 */
function cleanTags(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const v = t.trim();
    if (v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 失败 / 兜底结果的统一构造：内容只来自 record 安全子集，绝不带真相字段 */
function failedRecord({ record, deriveStatus, model, promptVersion, clock, reason }) {
  return {
    id: record.id,
    validFrom: record.validFrom,
    promptVersion,
    model,
    title: fallbackTitle(record),
    summary: fallbackSummary(record),
    tags: [],
    deriveStatus,
    ts: clock.now(),
    ...(reason ? { reason } : {}),
  };
}

/**
 * 构造派生 prompt（system + user）。user 里明确声明输出 schema 与禁止字段。
 * @param {{record: object}} args
 * @returns {{system: string, user: string}}
 */
export function buildDerivePrompt({ record } = {}) {
  if (!record || typeof record !== 'object') {
    const err = new Error('buildDerivePrompt: record is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const system = [
    '你是记忆条目的派生摘要器。只输出一个 JSON 对象，不要输出任何其他文字。',
    '允许的字段：title（不超过 40 字）、summary（不超过 80 字）、tags（最多 5 个字符串）、',
    'spo 建议（可选对象）、kindHint（可选，你猜测的条目类型）。',
    '禁止输出以下字段：kind、text、value、status、validTo、validFrom、id。',
    '这些字段属于真相层，派生层永远不得改写或伪造它们。',
  ].join('\n');
  const user = JSON.stringify({
    kind: record.kind,
    title: record.title,
    subject: record.subject,
    predicate: record.predicate,
    value: record.value,
    text: record.text,
    tags: record.tags,
  });
  return { system, user };
}

/**
 * 应用派生：调用 port 完成一次 LLM 派生并返回派生记录。永不抛异常。
 * @param {{port: object|null, record: object, promptVersion?: string, clock: object}} args
 * @returns {Promise<object>} derived 记录（含 deriveStatus）
 */
export async function applyDerivation({ port, record, promptVersion = DERIVE_PROMPT_VERSION, clock } = {}) {
  const safeClock = (clock && typeof clock.now === 'function') ? clock : { now: () => new Date().toISOString() };
  const emptyRecord = record && typeof record === 'object'
    ? record
    : { id: 'unknown', validFrom: '', text: '', title: '', subject: '', predicate: '' };
  try {
    if (!record || typeof record !== 'object') {
      return failedRecord({ record: emptyRecord, deriveStatus: 'failed', model: 'none', promptVersion, clock: safeClock, reason: 'invalid-record' });
    }
    // 隐私门禁：仅当端口显式声明 allowPrivate:false 且记录为 private 时阻断
    // （常规隐私治理在 port.js 的 egress=local-only 构造期校验里）
    if (record.privacy === 'private' && port && port.allowPrivate === false) {
      return failedRecord({ record, deriveStatus: 'privacy-blocked', model: port?.model ?? 'none', promptVersion, clock: safeClock });
    }
    // 端口未就绪：契约 ready 是布尔属性；容忍函数形态（测试用）
    const ready = typeof port?.ready === 'function' ? port.ready() : port?.ready;
    if (!port || ready !== true) {
      return failedRecord({ record, deriveStatus: 'no-provider', model: port?.model ?? 'none', promptVersion, clock: safeClock });
    }
    const { system, user } = buildDerivePrompt({ record });
    let res;
    try {
      res = await port.complete({ purpose: 'derive', system, user, record });
    } catch (e) {
      return failedRecord({ record, deriveStatus: 'failed', model: port?.model ?? 'none', promptVersion, clock: safeClock, reason: `port-threw:${e?.code ?? e?.name ?? 'Error'}` });
    }
    // 预算 blocked（契约：预算被拒记 budget-exceeded；budget.js 返回 blocked:true + E_LLM_BUDGET_EXCEEDED）
    if (!res || res.ok !== true) {
      const status = (res?.blocked === true || res?.budgetBlocked === true
        || res?.error?.code === 'E_LLM_BUDGET_EXCEEDED') ? 'budget-exceeded' : 'failed';
      return failedRecord({ record, deriveStatus: status, model: port?.model ?? 'none', promptVersion, clock: safeClock, reason: res?.error?.code });
    }
    const parsed = extractJson(res.text);
    if (!parsed) {
      return failedRecord({ record, deriveStatus: 'failed', model: port?.model ?? 'none', promptVersion, clock: safeClock, reason: 'unparseable-output' });
    }
    // 真相字段泄漏检测：出现即判非法，结果不得携带任何真相字段
    const leaked = [...FORBIDDEN_KEYS].filter((k) => Object.prototype.hasOwnProperty.call(parsed, k));
    if (leaked.length > 0) {
      return failedRecord({
        record, deriveStatus: 'failed', model: port?.model ?? 'none', promptVersion, clock: safeClock,
        reason: `forbidden-fields:${leaked.join(',')}`,
      });
    }
    // 白名单字段清洗 + 截断
    let title = typeof parsed.title === 'string' ? parsed.title.replace(/\s+/g, ' ').trim() : '';
    let titleTruncated = false;
    if (title.length > MAX_TITLE) {
      title = title.slice(0, MAX_TITLE);
      titleTruncated = true;
    }
    let summary = typeof parsed.summary === 'string' ? parsed.summary.replace(/\s+/g, ' ').trim() : '';
    let summaryTruncated = false;
    if (summary.length > MAX_SUMMARY) {
      summary = summary.slice(0, MAX_SUMMARY);
      summaryTruncated = true;
    }
    const tags = cleanTags(parsed.tags);
    const kindHint = typeof parsed.kindHint === 'string' && parsed.kindHint.trim() !== ''
      ? parsed.kindHint.trim()
      : undefined;
    const kindMismatch = kindHint !== undefined && kindHint !== record.kind;
    return {
      id: record.id,
      validFrom: record.validFrom,
      promptVersion,
      model: port?.model ?? 'unknown',
      title,
      summary,
      tags,
      ...(parsed.spo && typeof parsed.spo === 'object' && !Array.isArray(parsed.spo) ? { spo: parsed.spo } : {}),
      ...(kindHint !== undefined ? { kindHint } : {}),
      ...(kindMismatch ? { kindMismatch: true } : {}),
      deriveStatus: 'ok',
      ts: safeClock.now(),
      ...(titleTruncated ? { titleTruncated: true } : {}),
      ...(summaryTruncated ? { summaryTruncated: true } : {}),
    };
  } catch (e) {
    // 双保险：任何未预期异常也转成 failed 记录，绝不向上抛
    return failedRecord({
      record: emptyRecord, deriveStatus: 'failed', model: 'none', promptVersion, clock: safeClock,
      reason: `unexpected:${e?.code ?? e?.name ?? 'Error'}`,
    });
  }
}

/** 派生内容指纹（审计用，非契约必需）：promptVersion + id + validFrom 的 sha256 前 16 位 */
export function deriveFingerprint({ promptVersion, id, validFrom } = {}) {
  return createHash('sha256').update(`${promptVersion}\u0001${id}\u0001${validFrom}`).digest('hex').slice(0, 16);
}
