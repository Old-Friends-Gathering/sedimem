// session/checkpoint.js — 8 段 checkpoint 模板与落盘（v0.6 W2，契约：docs/plans/v0.6 §2.2/§2.3）
// 设计取向（§8 明确不做）：不自动总结会话——checkpoint 由 agent 或人写，
// 我们只提供模板校验、DSH 摘要解析和追加落盘三个动作。

import { systemClock } from '../core/clock.js';
import { createRecord } from '../core/record.js';
import { withLock } from '../storage/lock.js';
import { assertWritableKind, isSessionScope } from './lifecycle.js';

/** 8 段 checkpoint 的段名（冻结清单，顺序即渲染顺序） */
export const CHECKPOINT_SECTIONS = [
  'intent', 'concepts', 'files', 'errorsAndFixes',
  'pendingJobs', 'currentState', 'nextSteps', 'criticalContext',
];

/** 数组型段：其余（intent/currentState/criticalContext）是字符串 */
export const ARRAY_SECTIONS = new Set(['concepts', 'files', 'errorsAndFixes', 'pendingJobs', 'nextSteps']);

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * 校验并归一化 checkpoint：8 段必须齐、类型必须对（数组型五段 / 字符串型三段），
 * 数组元素折成字符串。非法抛 E_INVALID_ARG。多余键丢弃（模板冻结）。
 * @param {object} input
 * @returns {object} 归一化后的 8 段对象（新对象，不改入参）
 */
export function normalizeCheckpoint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw err('E_INVALID_ARG', `normalizeCheckpoint: 需要 8 段对象，收到 ${typeof input}`);
  }
  const out = {};
  const errors = [];
  for (const section of CHECKPOINT_SECTIONS) {
    const raw = input[section];
    if (ARRAY_SECTIONS.has(section)) {
      if (raw === undefined || raw === null) {
        out[section] = [];
      } else if (Array.isArray(raw)) {
        out[section] = raw.map((x) => String(x));
      } else {
        out[section] = null;
        errors.push(`${section}: 需要数组，收到 ${typeof raw}`);
      }
    } else {
      if (raw === undefined || raw === null) {
        out[section] = '';
      } else if (typeof raw === 'string') {
        out[section] = raw;
      } else {
        out[section] = null;
        errors.push(`${section}: 需要字符串，收到 ${typeof raw}`);
      }
    }
  }
  if (errors.length > 0) {
    throw err('E_INVALID_ARG', `normalizeCheckpoint: 段类型错误 — ${errors.join('; ')}`);
  }
  return out;
}

/**
 * 从 DSH 的 compaction/summary 事件 JSON 抽 checkpoint 初稿。
 * payload 形如 {compactionId, summary: ContentBlock[], shadowedTokenCount, ...}；
 * 只拼 intent/currentState 的草稿，缺字段留空——**不编造**（§8：不做自动总结）。
 * @param {object|string} json 事件 payload 对象或其 JSON 文本
 * @returns {{checkpoint: object, dsh: {compactionId: string|null, shadowedTokenCount: number|null}}}
 */
export function parseDshSummary(json) {
  let payload = json;
  if (typeof json === 'string') {
    try { payload = JSON.parse(json); } catch {
      throw err('E_INVALID_ARG', 'parseDshSummary: 入参不是合法 JSON');
    }
  }
  if (!payload || typeof payload !== 'object') {
    throw err('E_INVALID_ARG', `parseDshSummary: 需要 compaction/summary payload 对象，收到 ${typeof payload}`);
  }
  const blocks = Array.isArray(payload.summary) ? payload.summary : [];
  // ContentBlock 里只有 text 块能进草稿；其余类型（tool_use 等）没有可读文本
  const texts = blocks
    .filter((b) => b && typeof b === 'object' && typeof b.text === 'string' && b.text !== '')
    .map((b) => b.text);
  const joined = texts.join('\n\n');
  return {
    checkpoint: normalizeCheckpoint({
      // 摘要里没有可靠的「意图」字段——不编造，由 agent 补写
      intent: '',
      currentState: joined,
    }),
    dsh: {
      compactionId: typeof payload.compactionId === 'string' ? payload.compactionId : null,
      shadowedTokenCount: Number.isFinite(payload.shadowedTokenCount) ? payload.shadowedTokenCount : null,
    },
  };
}

/**
 * 追加一条 checkpoint（kind=state, subject=session, predicate=checkpoint，value=8 段 JSON）。
 * value 里附 recordedAt / compactionId：同内容多次 checkpoint 也能追加成新版本
 * （否则 write 门禁会按 contentHash 判 noop_duplicate，「每次压缩都追加」就失效了）。
 * @param {{service: object, scope?: string, checkpoint: object, compactionId?: string, clock?: object}} args
 * @returns {Promise<{action: string, record: object, checkpoint: object}>}
 */
export async function writeCheckpoint({ service, scope, checkpoint, compactionId, clock = systemClock }) {
  if (!service) throw err('E_INVALID_ARG', 'writeCheckpoint: service is required');
  const targetScope = scope ?? service.scope;
  if (!isSessionScope(targetScope)) {
    throw err('E_INVALID_ARG',
      `writeCheckpoint: 只能写进 session scope（session:<id>），收到 ${JSON.stringify(targetScope)}`);
  }
  if (targetScope !== service.scope) {
    throw err('E_INVALID_ARG',
      `writeCheckpoint: service.scope (${service.scope}) 与目标 scope (${targetScope}) 不一致，请开绑定该 scope 的服务`);
  }
  const normalized = normalizeCheckpoint(checkpoint);
  assertWritableKind(targetScope, 'state'); // 恒过，仅保形式一致（checkpoint 是 state）
  const recordedAt = clock.now();
  const value = JSON.stringify({
    ...normalized,
    recordedAt,
    ...(compactionId !== undefined ? { compactionId } : {}),
  });
  // checkpoint 是「追加新版本」语义（§2.2），不走 write 门禁——同 slot 的两次 checkpoint
  // 文本必然高度相似，decideWrite 的近重复防线会把它判成 noop_same_value，
  // 「每次压缩/手动都追加」就失效了。这里在 scope 锁内直接 _commit（与 write-path 同款临界区）。
  const record = createRecord({
    text: `checkpoint @ ${recordedAt}`,
    kind: 'state',
    subject: 'session',
    predicate: 'checkpoint',
    value,
    scope: service.scope,
    source: { agent: 'cli' },
  }, { clock: service.clock });
  await withLock(service.memoHome, async () => {
    service._inScopeLock = true;
    try {
      await service._refreshIncremental();
      await service._commit(record, 'write', { action: 'checkpoint', reason: 'session-checkpoint-append' });
    } finally {
      service._inScopeLock = false;
    }
  });
  return { action: 'created', record, checkpoint: normalized };
}
