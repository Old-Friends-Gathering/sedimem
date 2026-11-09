// core/record.js — 记录构造 / 校验 / 补丁（契约：docs/02 §2、§3）

import { newId, isId } from './ids.js';
import { contentHash } from './hash.js';
import { systemClock } from './clock.js';
// kind 清单唯一真相在 config/policy.json 的 kinds 段（issue #33 / 裁决 D2）；
// 依赖方向必须是 record → policy（policy.js 只校验数据形状，绝不反向 import 本文件，否则成环）。
import { defaultPolicy, kindNames } from '../config/policy.js';

const STATUSES = new Set(['active', 'superseded', 'disputed', 'tombstoned']);
// 已知 agent 只是「带颜色的标签」，不是白名单（裁决 25：允许任意新客户端接入，避免写死）
export const KNOWN_AGENTS = new Set(['dsh', 'codex', 'claude', 'cli', 'test', 'unknown']);
// 保留名：冒充系统身份一律拒绝（对抗审核「伪造身份」用例必须继续通过）
export const RESERVED_AGENTS = new Set(['root', 'system', 'admin', 'sudo', 'superuser']);
export const AGENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MAX_TEXT = 4000;
// 标题长度（issue #61 / 裁决 59）：图谱与 brief 都要靠它，太长等于没标题。
export const MAX_TITLE = 40;

/**
 * 标题归一化：折成单行、去首尾空白、超长截断（39 字符 + `…`）。
 * 空串表示「没有标题」，调用方不得写入空 title 字段（那会让 label 回落到 subject 时看不出差别）。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeTitle(raw) {
  const oneLine = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine === '') return '';
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine;
}

/**
 * 创建 MemoryRecord（version=1）。非法输入抛 err.code='E_INVALID_RECORD'。
 * @param {object} input {text, kind, subject, predicate, value, confidence, source, tags, privacy, validFrom}
 * @param {{clock?: object, kinds?: Iterable<string>}} deps kinds 缺省回落 defaultPolicy.kinds（裁决 D2）
 * @returns {MemoryRecord}
 */
export function createRecord(input, deps = {}) {
  const clock = deps?.clock ?? systemClock;
  // kind 注册表数据化：合法集合由调用方注入或取自 policy，本文件不再持清单
  const kinds = deps?.kinds ?? kindNames(defaultPolicy);
  if (!input || typeof input !== 'object') {
    throw invalid(`createRecord: input must be an object, got ${typeof input}`);
  }
  const text = String(input.text ?? '');
  const tags = Array.isArray(input.tags) ? [...input.tags] : [];
  const finalText = text.length > MAX_TEXT ? (text.slice(0, MAX_TEXT - 1) + '…') : text;
  if (text.length > MAX_TEXT && !tags.includes('truncated')) tags.push('truncated');

  // 缺失即拒绝（01-architecture §3）：不得静默填默认 agent
  const rawSource = input.source && typeof input.source === 'object' ? { ...input.source } : null;
  if (!rawSource || typeof rawSource.agent !== 'string' || rawSource.agent.trim() === '') {
    throw invalid(`createRecord: source.agent (non-empty string) is required, got ${JSON.stringify(rawSource?.agent)}`);
  }
  const agent = rawSource.agent.trim();
  if (!AGENT_PATTERN.test(agent) || RESERVED_AGENTS.has(agent)) {
    throw invalid(`createRecord: source.agent must match ${AGENT_PATTERN} and not be reserved (${[...RESERVED_AGENTS].join('|')}), got ${JSON.stringify(agent)}`);
  }
  const source = { ...rawSource, agent };

  const title = normalizeTitle(input.title);
  const record = {
    id: input.id ?? newId(clock.nowMs()),
    v: 1,
    scope: String(input.scope ?? ''),
    kind: input.kind ?? 'fact',
    subject: String(input.subject ?? 'text'),
    predicate: String(input.predicate ?? 'text'),
    value: String(input.value ?? finalText),
    text: finalText,
    validFrom: input.validFrom ?? clock.now(),
    validTo: input.validTo ?? null,
    createdAt: input.createdAt ?? clock.now(),
    expiredAt: input.expiredAt ?? null,
    status: input.status ?? 'active',
    supersedes: input.supersedes ?? null,
    confidence: input.confidence ?? 0.8,
    source,
    contentHash: input.contentHash ?? contentHash({ text: finalText, subject: input.subject, predicate: input.predicate, value: input.value ?? finalText }),
    hits: input.hits ?? 0,
    privacy: input.privacy ?? 'private',
    // L3 溯源（issue #52 / 裁决 54）：只有「派生于其它记录」的记录才带；
    // 普通记录保持不含该字段（不是 null 空数组），避免真相层被无意义的键撑大。
    ...(input.sourceRefs !== undefined ? { sourceRefs: input.sourceRefs } : {}),
    // 标题（裁决 59）：没有就不写这个键——空字符串会让「没有标题」和「标题是空」分不开
    ...(title !== '' ? { title } : {}),
    tags,
  };

  const v = validateRecord(record, kinds);
  if (!v.ok) throw invalid(`createRecord: ${v.errors.join('; ')}`);
  return record;
}

/**
 * 逐条校验不变式（docs/02 §2）。返回 {ok, errors[]}，不抛错。
 * @param {MemoryRecord} r
 * @param {Iterable<string>} [kinds] 合法 kind 集合，缺省回落 defaultPolicy.kinds
 */
export function validateRecord(r, kinds = kindNames(defaultPolicy)) {
  const kindList = [...kinds];
  const errors = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['record: not an object'] };
  if (!isId(r.id)) errors.push(`id: invalid ULID ${JSON.stringify(r.id)}`);
  if (!r.source || typeof r.source.agent !== 'string' || !AGENT_PATTERN.test(r.source.agent) || RESERVED_AGENTS.has(r.source.agent)) {
    errors.push(`source.agent: must match ${AGENT_PATTERN} and not be reserved, got ${JSON.stringify(r.source?.agent)}`);
  }
  const validTo = r.validTo ?? null;
  if ((r.validFrom ?? '') > (validTo ?? '9999')) errors.push('validFrom > validTo');
  if (r.status === 'active' && validTo !== null) errors.push('active record must have validTo=null');
  if (r.status === 'superseded' && validTo === null) errors.push('superseded record must have validTo!=null');
  if (typeof r.contentHash !== 'string' || !r.contentHash.startsWith('sha256:')) {
    errors.push(`contentHash: must start with 'sha256:', got ${JSON.stringify(r.contentHash)}`);
  }
  if (!Number.isInteger(r.v) || r.v < 1) errors.push(`v: must be integer >= 1, got ${r.v}`);
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
    errors.push(`confidence: must be in [0,1], got ${r.confidence}`);
  }
  if (typeof r.text !== 'string' || r.text.length === 0) errors.push('text: must be non-empty');
  if (r.text.length > MAX_TEXT) errors.push(`text: length ${r.text.length} exceeds ${MAX_TEXT}`);
  if (!kindList.includes(r.kind)) errors.push(`kind: must be one of ${kindList.join('|')}, got ${r.kind}`);
  if (!STATUSES.has(r.status)) errors.push(`status: must be one of ${[...STATUSES].join('|')}, got ${r.status}`);
  if (typeof r.hits !== 'number' || r.hits < 0) errors.push(`hits: must be >= 0, got ${r.hits}`);
  if (r.privacy !== 'private' && r.privacy !== 'shared') errors.push(`privacy: must be private|shared, got ${r.privacy}`);
  // 标题（裁决 59）：出现就必须是单行、非空、≤MAX_TITLE，且已归一化（首尾无空白）
  if (r.title !== undefined) {
    if (typeof r.title !== 'string') errors.push(`title: must be a string, got ${typeof r.title}`);
    else if (r.title === '') errors.push('title: must not be empty when present');
    else if (/[\r\n]/.test(r.title)) errors.push('title: must be single-line');
    else if (r.title !== r.title.trim()) errors.push('title: must not have leading/trailing whitespace');
    else if (r.title.length > MAX_TITLE) errors.push(`title: length ${r.title.length} exceeds ${MAX_TITLE}`);
  }
  // 溯源字段（裁决 54）：出现就必须是非空 ULID 数组且去重；空数组等于「假装有出处」，直接拒
  if (r.sourceRefs !== undefined) {
    if (!Array.isArray(r.sourceRefs) || r.sourceRefs.length === 0) {
      errors.push('sourceRefs: must be a non-empty array of ULIDs when present');
    } else {
      const seen = new Set();
      for (const ref of r.sourceRefs) {
        if (!isId(ref)) errors.push(`sourceRefs: invalid ULID ${JSON.stringify(ref)}`);
        else if (seen.has(ref)) errors.push(`sourceRefs: duplicate ${ref}`);
        else seen.add(ref);
      }
      if (r.sourceRefs.includes(r.id)) errors.push('sourceRefs: record may not cite itself');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 返回补丁后的新对象（v+1），不修改入参。
 * @param {MemoryRecord} r
 * @param {object} patch
 */
export function withPatch(r, patch) {
  if (!r || typeof r !== 'object') throw invalid('withPatch: record must be an object');
  return { ...r, ...patch, v: (r.v ?? 1) + 1 };
}

function invalid(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_RECORD';
  return err;
}
