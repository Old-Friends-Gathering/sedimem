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
// 写侧粒度契约（W1）：超硬上限不再静默截断，而是报错让调用方自己拆。
// 默认值仅作 policy 缺 write 段时的兜底；真相单一来源是 config/policy.json 的 write 段。
export const MAX_TEXT = 4000;
// B-01（adv）：value 面此前无上限，结构化长文绕过 text 契约。默认硬上限 2000。
export const MAX_VALUE = 2000;
const DEFAULT_VALUE_RECOMMEND_CHARS = 300;
const DEFAULT_TITLE_REQUIRED_KINDS = ['fact', 'pref', 'decision', 'gotcha'];
// 标题长度（issue #61 / 裁决 59）：图谱与 brief 都要靠它，太长等于没标题。
export const MAX_TITLE = 40;

/** 归一 write 段：policy.write 缺失或部分缺键时逐键兜底（不整体覆盖）。 */
function writePolicyOf(policy) {
  const w = (policy && typeof policy.write === 'object' && !Array.isArray(policy.write)) ? policy.write : {};
  return {
    textHardMaxChars: Number.isFinite(w.textHardMaxChars) && w.textHardMaxChars > 0 ? w.textHardMaxChars : MAX_TEXT,
    // B-01：value 面硬上限（缺键兜底 2000）。arch 严重项 ④：上限只能调小不能调大，
    // 所以实际生效值 = min(policy 值, 内建天花板 MAX_TEXT / MAX_VALUE)。
    valueHardMaxChars: Number.isFinite(w.valueHardMaxChars) && w.valueHardMaxChars > 0 ? w.valueHardMaxChars : MAX_VALUE,
    valueRecommendChars: Number.isFinite(w.valueRecommendChars) && w.valueRecommendChars > 0 ? w.valueRecommendChars : DEFAULT_VALUE_RECOMMEND_CHARS,
    titleRequiredKinds: Array.isArray(w.titleRequiredKinds) ? w.titleRequiredKinds : DEFAULT_TITLE_REQUIRED_KINDS,
    // 是否**强制**（false = 只给 E_TITLE_MISSING 警告，v0.6 默认；v0.7 可翻成 true）
    titleEnforce: w.titleEnforce === true,
  };
}

// arch 严重项 ④：写侧硬上限只能调小不能调大——policy 值超过内建天花板时按天花板算。
export function effectiveWriteCaps(policy) {
  const wp = writePolicyOf(policy);
  return {
    text: Math.min(wp.textHardMaxChars, MAX_TEXT),
    value: Math.min(wp.valueHardMaxChars, MAX_VALUE),
  };
}

/**
 * 标题归一化：折成单行、去首尾空白、超长截断（39 字符 + `…`）。
 * 空串表示「没有标题」，调用方不得写入空 title 字段（那会让 label 回落到 subject 时看不出差别）。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeTitle(raw) {
  // S-03（adv）：先剔除零宽与方向控制字符——它们不占视觉宽度但会让不同标题在
  // 图谱/brief 里看起来相同实则不同（spoof），且能藏 prompt 注入痕迹。先删再折空白。
  const stripped = String(raw ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '');
  const oneLine = stripped.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return '';
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine;
}

/**
 * 创建 MemoryRecord（version=1）。非法输入抛 err.code='E_INVALID_RECORD'。
 * @param {object} input {text, kind, subject, predicate, value, confidence, source, tags, privacy, validFrom}
 * @param {{clock?: object, kinds?: Iterable<string>, policy?: object}} deps
 *   kinds 缺省回落 defaultPolicy.kinds（裁决 D2）；policy 缺省回落 defaultPolicy（W1 写侧契约从 policy 读）
 * @returns {MemoryRecord}
 */
export function createRecord(input, deps = {}) {
  const clock = deps?.clock ?? systemClock;
  // kind 注册表数据化：合法集合由调用方注入或取自 policy，本文件不再持清单
  const kinds = deps?.kinds ?? kindNames(defaultPolicy);
  const wp = writePolicyOf(deps?.policy ?? defaultPolicy);
  if (!input || typeof input !== 'object') {
    throw invalid(`createRecord: input must be an object, got ${typeof input}`);
  }
  const text = String(input.text ?? '');
  const value = String(input.value ?? text);
  const tags = Array.isArray(input.tags) ? [...input.tags] : [];
  // W1：超硬上限报错而非静默截断——截断会把不可恢复的信息丢进真相层，还让调用方误以为写全了。
  // arch 严重项 ④：生效上限 = min(policy 值, 内建天花板)，只能调小不能调大。
  const caps = effectiveWriteCaps(deps?.policy ?? defaultPolicy);
  if (text.length > caps.text) {
    throw invalid(
      `createRecord: text length ${text.length} exceeds write.textHardMaxChars=${caps.text}`
      + `（请拆成多条记录再写，可先截取前 ${caps.text} 字定位主题：text.slice(0, ${caps.text})）`,
    );
  }
  // B-01（adv）：value 面同样硬限——此前结构化长文全从 value 绕过 text 契约。
  if (value.length > caps.value) {
    throw invalid(
      `createRecord: value length ${value.length} exceeds write.valueHardMaxChars=${caps.value}`
      + `（value 应是可扫读的结构化值，请改写更短的 value 或拆成多条记录）`,
    );
  }
  const finalText = text;

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
  // W1 契约：结构化记录必须能一句话扫读。默认只警告（titleEnforce=false），
  // 需要硬约束的部署把 policy.write.titleEnforce 打开即可（v0.7 计划默认开）。
  if (wp.titleEnforce && wp.titleRequiredKinds.includes(String(input.kind ?? 'fact')) && title === '') {
    throw invalid(
      `createRecord: kind=${input.kind ?? 'fact'} 必须带 title（≤${MAX_TITLE} 字单行，策略 write.titleEnforce=true）；`
      + `最小正确形状：{ text, kind: '${input.kind ?? 'fact'}', title: '一句话主题', source: { agent: '${agent}' } }`,
    );
  }
  const record = {
    id: input.id ?? newId(clock.nowMs()),
    v: 1,
    scope: String(input.scope ?? ''),
    kind: input.kind ?? 'fact',
    subject: String(input.subject ?? 'text'),
    predicate: String(input.predicate ?? 'text'),
    value,
    text: finalText,
    validFrom: input.validFrom ?? clock.now(),
    validTo: input.validTo ?? null,
    createdAt: input.createdAt ?? clock.now(),
    expiredAt: input.expiredAt ?? null,
    status: input.status ?? 'active',
    supersedes: input.supersedes ?? null,
    confidence: input.confidence ?? 0.8,
    source,
    contentHash: input.contentHash ?? contentHash({ text: finalText, subject: input.subject, predicate: input.predicate, value }),
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
 * @param {object} [policy] 写侧硬上限来源，缺省回落 defaultPolicy（arch 严重项 ④：读 policy 且只能调小）
 */
export function validateRecord(r, kinds = kindNames(defaultPolicy), policy = defaultPolicy) {
  const kindList = [...kinds];
  const caps = effectiveWriteCaps(policy);
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
  // arch 严重项 ④：硬上限从 policy 读（生效值 = min(policy, 内建天花板)），不再硬编码 4000。
  if (r.text.length > caps.text) errors.push(`text: length ${r.text.length} exceeds ${caps.text}`);
  // B-01（adv）：value 面同样硬校验，堵住「结构化长文绕过 text 契约」的旁路。
  if (typeof r.value === 'string' && r.value.length > caps.value) {
    errors.push(`value: length ${r.value.length} exceeds ${caps.value}`);
  }
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
 * 写侧粒度契约告警（W1）：不抛错、不改记录，只提示调用方「该拆了 / 缺标题」。
 * - E_RECORD_LONG：text 超过 write.valueRecommendChars（默认 300），附 splitSuggestion（按中英句号/换行切句，
 *   丢空段，最多 3 段、每段 ≤valueRecommendChars 字，超长段硬切）。
 * - E_TITLE_MISSING：kind ∈ write.titleRequiredKinds（默认除 state 外全部）且无 title。
 * @param {MemoryRecord} record
 * @param {object} [policy] 缺省回落 defaultPolicy
 * @returns {{code: string, message: string, splitSuggestion?: string[]}[]}
 */
export function recordWarnings(record, policy = defaultPolicy) {
  const wp = writePolicyOf(policy);
  const warnings = [];
  if (!record || typeof record !== 'object') return warnings;
  // 长文可能落在 text（自由文本）或 value（结构化值）任一面，两面都要看
  const text = String(record.text ?? '');
  const value = String(record.value ?? '');
  const longest = text.length >= value.length ? text : value;
  if (longest.length > wp.valueRecommendChars) {
    warnings.push({
      code: 'E_RECORD_LONG',
      message: `${text.length >= value.length ? 'text' : 'value'} length ${longest.length} 超过建议值 ${wp.valueRecommendChars} 字，请按句拆成多条记录（splitSuggestion 为切分示例）`,
      splitSuggestion: splitSentences(longest, wp.valueRecommendChars),
    });
  }
  const kind = String(record.kind ?? '');
  const hasTitle = typeof record.title === 'string' && record.title.trim() !== '';
  if (wp.titleRequiredKinds.includes(kind) && !hasTitle) {
    warnings.push({
      code: 'E_TITLE_MISSING',
      message: `kind=${kind} 的记录必须带 title（≤${MAX_TITLE} 字单行），否则图谱与 brief 无法扫读。`
        + `最小正确形状：{ text, kind: '${kind}', title: '一句话主题', source: { agent: '<调用方>' } }`,
    });
  }
  return warnings;
}

/** 按中英句号/换行切句：丢空段，最多 3 段，每段硬切到 maxChars 字。 */
function splitSentences(text, maxChars) {
  return text
    .split(/(?<=[。.])\s*|\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 3)
    .map((s) => (s.length > maxChars ? s.slice(0, maxChars) : s));
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
