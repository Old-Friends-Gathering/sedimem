// session/lifecycle.js — 会话临时库生命周期（v0.6 W2，契约：docs/plans/v0.6-memory-quality-and-session.md §2.2/§2.3）
// session 是「可丢弃、可晋升」的中间层：scope 前缀 session:<id>，只有 state/checkpoint 与
// 白名单 kind（decision/gotcha）有意义；close 时白名单晋升主库，其余 tombstone。
// 本模块只做数据层，不自动触发（不做自动建库/自动压缩/自动关闭）。

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../core/clock.js';
import { itemsFileName, scopeFromItemsFileName } from '../config/paths.js';
// 只取形状常量，scope-state.js 无反向依赖（无循环）
import { SCOPE_PATTERN } from '../core/scope-state.js';

/** session scope 前缀 */
export const SESSION_PREFIX = 'session:';

/** session 下禁止写入的 kind（临时库里 fact 没有意义：close 时不会被晋升，等于写了就丢） */
export const SCRATCH_FORBIDDEN_KINDS = new Set(['fact']);

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * 生成 session id：YYYYMMDD-HHmm-<4hex>（hex 来自 crypto.randomBytes，同一分钟内也不撞）。
 * @param {{nowMs?: Function}} [clock] 时钟端口（测试可注入固定值）
 * @returns {string}
 */
export function createSessionId(clock = systemClock) {
  const d = new Date(clock.nowMs ? clock.nowMs() : Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const hex = randomBytes(2).toString('hex');
  return `${stamp}-${hex}`;
}

/**
 * 判断 scope 是否是 session 临时库。
 * @param {string} scope
 * @returns {boolean}
 */
export function isSessionScope(scope) {
  return typeof scope === 'string' && scope.startsWith(SESSION_PREFIX)
    && scope.length > SESSION_PREFIX.length;
}

/**
 * 写入门禁：session scope 下禁 fact（E_SCRATCH_KIND_FORBIDDEN）；
 * 且禁止普通写入 subject=session & predicate=meta（E_SESSION_META_PROTECTED，对抗审核 B-02：
 * 伪造 meta 可把 close 晋升重定向到任意库——meta 真相移到记忆流之外后，
 * 记忆流里的 meta 只允许 lifecycle 内部写，走 opts.internal 旁路）。
 * @param {string} scope
 * @param {string} kind
 * @param {{internal?: boolean, input?: object}} [opts] internal=true 为 lifecycle 自身写 meta 的旁路
 */
export function assertWritableKind(scope, kind, opts = {}) {
  if (!isSessionScope(scope)) return;
  if (!opts.internal && opts.input
    && opts.input.subject === 'session' && opts.input.predicate === 'meta') {
    throw err('E_SESSION_META_PROTECTED',
      `session meta（subject=session & predicate=meta）是生命周期内部记录，普通写入被禁止` +
      `（防伪造 meta 重定向晋升目标）；请通过 session start / close 管理。`);
  }
  if (SCRATCH_FORBIDDEN_KINDS.has(kind)) {
    throw err('E_SCRATCH_KIND_FORBIDDEN',
      `session scope (${scope}) 下禁止写 kind=${kind}：临时库里的 fact 不会被晋升，` +
      `close 时只保留 decision/gotcha。要写长期事实请写主库。`);
  }
}

// ===== 会话登记文件（真相在记忆流之外，对抗 B-02 / B-03）=====
// startSession 写 meta 的同时写 <memoHome>/sessions/<id>.json；close / status 以该文件为准，
// 文件缺失才回落 meta（回落时只接受非 session 型且匹配 SCOPE_PATTERN 的 parentScope）。
// meta 仍在记忆流里保留（brief/图谱可见 session 骨架），但不再是晋升目标的真相源。

/** 登记文件路径：<memoHome>/sessions/<sessionId>.json */
export function sessionRegistryPath(memoHome, sessionId) {
  return path.join(memoHome, 'sessions', `${sessionId}.json`);
}

/** 读登记文件；scope 非 session / 文件缺失 / 损坏 → null（缺失按 open 处理） */
export function readSessionRegistry(memoHome, scope) {
  if (!isSessionScope(scope)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(sessionRegistryPath(memoHome, scope.slice(SESSION_PREFIX.length)), 'utf8'),
    );
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 写/覆盖登记文件（startSession 与 close 用） */
export function writeSessionRegistry(memoHome, scope, data) {
  if (!isSessionScope(scope)) {
    throw err('E_INVALID_ARG', `writeSessionRegistry: scope 必须是 ${SESSION_PREFIX}<id>，收到 ${JSON.stringify(scope)}`);
  }
  const file = sessionRegistryPath(memoHome, scope.slice(SESSION_PREFIX.length));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

/** 增量更新登记文件（如 close 置 status='closed'）；无登记文件 → 返回 null 不新建 */
export function updateSessionRegistry(memoHome, scope, patch) {
  const cur = readSessionRegistry(memoHome, scope);
  if (!cur) return null;
  return writeSessionRegistry(memoHome, scope, { ...cur, ...patch });
}

/**
 * 解析 close 的晋升目标（parentScope）：登记文件优先；文件缺失回落 meta，
 * 回落时只接受非 session 型且匹配 SCOPE_PATTERN 的 parentScope（对抗 B-02 重定向）。
 * @returns {{parentScope: string|null, source: 'registry'|'meta-fallback'|'none'}}
 */
export function resolveParentScope(memoHome, scope, meta) {
  const reg = readSessionRegistry(memoHome, scope);
  if (reg && typeof reg.parentScope === 'string' && SCOPE_PATTERN.test(reg.parentScope)) {
    return { parentScope: reg.parentScope, source: 'registry' };
  }
  const ps = meta?.parentScope;
  if (typeof ps === 'string' && !isSessionScope(ps) && SCOPE_PATTERN.test(ps)) {
    return { parentScope: ps, source: 'meta-fallback' };
  }
  return { parentScope: null, source: 'none' };
}

/**
 * 写路径门禁（B-03）：session 状态为 closed 时拒绝写入（E_SESSION_CLOSED）。
 * 状态以 sessions/<id>.json 为准，缺失则按 open（兼容修复前创建的 session）。
 */
export function assertSessionOpen(memoHome, scope) {
  const reg = readSessionRegistry(memoHome, scope);
  if (reg && reg.status === 'closed') {
    throw err('E_SESSION_CLOSED',
      `session ${scope} 已关闭，不再接受写入；被 close 后写入的记录既不会晋升也不会被清理。` +
      `请重新 session start 开新会话临时库。`);
  }
}

/**
 * 从记录集合里取 session meta（subject=session & predicate=meta 的最后一个版本）。
 * @param {Iterable<object>} records
 * @returns {object|null} 解析后的 meta JSON；无 → null
 */
function readMetaFrom(records) {
  let last = null;
  for (const r of records) {
    if (r.subject === 'session' && r.predicate === 'meta') {
      if (!last || (r.createdAt ?? '') >= (last.createdAt ?? '')) last = r;
    }
  }
  if (!last) return null;
  try {
    const parsed = JSON.parse(last.value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 现开一个 session-scoped 服务。
 * 依赖注入：工厂由调用方给（CLI / MCP 各持一把），本模块**不 import api/service.js**——
 * 否则 api/write-path → session/lifecycle → api/service → … 会形成环（W1 用状态机解析器抓到的真环）。
 * @param {(opts: {memoHome: string, scope: string, clock: object}) => Promise<object>} factory
 */
async function openSessionService(factory, memoHome, scope, clock) {
  if (typeof factory !== 'function') {
    throw err('E_INVALID_ARG',
      'startSession: 未提供 serviceFactory；生成新 session 需要工厂来现开 session-scoped 服务' +
      '（请传 serviceFactory，或直接传 sessionScope 让调用方自行绑定）');
  }
  return factory({ memoHome, scope, clock });
}

/**
 * 开始一个 session：生成 id、写 meta（kind=state, subject=session, predicate=meta）。
 * 传入的 service 必须绑定主库 scope（close 时晋升目标）；传入 sessionScope 可显式指定
 * 临时库 scope，否则生成新 id 并用 service.memoHome 现开一个 session-scoped 服务。
 * meta 里记录 parentScope = service.scope（主库 scope），close 时据此开主库服务做晋升，
 * 避免「入口 service 因 MEMO_SCOPE 被切到 session 库」导致晋升落错库（v0.6 修复）。
 * @param {{service: object, title?: string, repo?: string, clock?: object, sessionScope?: string}} args
 * @returns {Promise<{scope: string, meta: object, parentScope: string}>}
 */
export async function startSession({
  service, title, repo, clock = systemClock, sessionScope, serviceFactory,
}) {
  if (!service) throw err('E_INVALID_ARG', 'startSession: service is required');
  if (sessionScope !== undefined && !isSessionScope(sessionScope)) {
    throw err('E_INVALID_ARG',
      `startSession: sessionScope 必须形如 ${SESSION_PREFIX}<id>，收到 ${JSON.stringify(sessionScope)}`);
  }
  // 对抗审核 B1（session-in-session 静默丢数据）：入口 service 绑定的是 session scope 时，
  // parentScope 会指向 session 自身，close 晋升写回自身后被 tombstone 循环当场丢弃。
  // 直接拒绝——要求用绑定主库（repo:/dir:）的服务执行 session start。
  if (isSessionScope(service.scope)) {
    throw err('E_INVALID_ARG',
      `startSession: 入口 service 绑定的是 session scope (${service.scope})，不能作为晋升目标；` +
      `请用绑定主库（repo:/dir:）的服务执行 session start`);
  }
  const id = sessionScope ? sessionScope.slice(SESSION_PREFIX.length) : createSessionId(clock);
  const scope = SESSION_PREFIX + id;
  const svc = await openSessionService(serviceFactory, service.memoHome, scope, clock);
  // 晋升目标：调用方保证 service 绑主库；记录进 meta，close 时反查
  const parentScope = service.scope;
  const startedAt = clock.now();
  const meta = {
    id,
    title: title ?? '',
    startedAt,
    cwd: process.cwd(),
    repo: repo ?? null,
    status: 'open',
    parentScope,
  };
  try {
    await svc.write({
      text: `session ${id}${title ? `: ${title}` : ''} 开始`,
      kind: 'state',
      subject: 'session',
      predicate: 'meta',
      value: JSON.stringify(meta),
      source: { agent: 'cli' },
      _sessionInternal: true, // 内部旁路：meta 只允许 lifecycle 写（E_SESSION_META_PROTECTED）
    });
    // 真相源（B-02）：parentScope/status 写进记忆流之外的登记文件，close 以此为准
    writeSessionRegistry(service.memoHome, scope, {
      id,
      parentScope,
      title: title ?? '',
      startedAt,
      cwd: process.cwd(),
      repo: repo ?? null,
      status: 'open',
    });
  } finally {
    await svc.close();
  }
  return { scope, meta, parentScope };
}

/**
 * session 概况：meta / checkpoint 数 / 期间事实数 / 最后一次 checkpoint 时间。
 * @param {{service: object}} args service 必须绑定在该 session scope 上
 * @returns {{scope: string, sessionId: string, meta: object|null, checkpoints: number,
 *            facts: number, lastCheckpointAt: string|null, status: string}}
 */
export function sessionStatus({ service }) {
  if (!service) throw err('E_INVALID_ARG', 'sessionStatus: service is required');
  if (!isSessionScope(service.scope)) {
    throw err('E_INVALID_ARG',
      `sessionStatus: service.scope 必须是 ${SESSION_PREFIX}<id>，收到 ${JSON.stringify(service.scope)}`);
  }
  const records = [...service._records.values()];
  const meta = readMetaFrom(records);
  // 状态以登记文件为准（B-03：别的进程 close 过，这里不能仍显示 open）；缺失回落 meta
  const registry = readSessionRegistry(service.memoHome, service.scope);
  // 计数口径保持「非 tombstoned」（含被 supersede 的历史版本，即 checkpoint 次数）；
  // brief 渲染面只有 1 条 active（writeCheckpoint 保证，arch S1 修复）
  const checkpoints = records.filter(
    (r) => r.subject === 'session' && r.predicate === 'checkpoint' && r.status !== 'tombstoned',
  );
  const facts = records.filter(
    (r) => !(r.subject === 'session' && (r.predicate === 'meta' || r.predicate === 'checkpoint'))
      && r.status !== 'tombstoned',
  );
  let lastCheckpointAt = null;
  for (const c of checkpoints) {
    if (!lastCheckpointAt || (c.createdAt ?? '') > lastCheckpointAt) lastCheckpointAt = c.createdAt ?? null;
  }
  return {
    scope: service.scope,
    sessionId: service.scope.slice(SESSION_PREFIX.length),
    meta,
    checkpoints: checkpoints.length,
    facts: facts.length,
    lastCheckpointAt,
    status: registry?.status ?? (meta ? meta.status : 'unknown'),
  };
}

/**
 * 兜底扫描：找出「仍 open 且 startedAt 早于 olderThanMs」的僵尸 session。
 * **只报告候选，不改不删**（自动关闭永远不做，边界只到「提示」）。
 * 实现上直接读 items/<scope>.jsonl 的最后 meta 版本，不现开服务（扫描可能覆盖几十个库）。
 * @param {{service?: object, memoHome: string, olderThanMs: number, clock?: object}} args
 * @returns {{scanned: number, candidates: Array<{scope, sessionId, title, startedAt, ageMs}>}}
 */
export function sweepSessions({ service, memoHome, olderThanMs, clock = systemClock }) {
  const home = memoHome ?? service?.memoHome;
  if (!home) throw err('E_INVALID_ARG', 'sweepSessions: memoHome is required');
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
    throw err('E_INVALID_ARG', `sweepSessions: olderThanMs must be positive ms, got ${olderThanMs}`);
  }
  const itemsDir = path.join(home, 'items');
  const nowMs = clock.nowMs();
  const candidates = [];
  let scanned = 0;
  if (!existsSync(itemsDir)) return { scanned, candidates };
  for (const name of readdirSync(itemsDir)) {
    const scope = scopeFromItemsFileName(name);
    if (!scope || !isSessionScope(scope)) continue;
    scanned++;
    // 登记文件优先（B-02/B-03 后的真相源）；缺失才回落记忆流里的 meta
    const registry = readSessionRegistry(home, scope);
    if (registry) {
      if (registry.status !== 'open' || !registry.startedAt) continue;
      const ageMs = nowMs - Date.parse(registry.startedAt);
      if (!Number.isFinite(ageMs) || ageMs < olderThanMs) continue;
      candidates.push({
        scope,
        sessionId: registry.id ?? scope.slice(SESSION_PREFIX.length),
        title: registry.title ?? '',
        startedAt: registry.startedAt,
        ageMs,
      });
      continue;
    }
    // 逐行找最后一个 meta 版本（同 id 最后一行胜出，但 meta 可能被 supersede 出新 id；
    // 取 createdAt 最大的那条）
    let last = null;
    const lines = readFileSync(path.join(itemsDir, itemsFileName(scope)), 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t === '') continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      if (rec.subject === 'session' && rec.predicate === 'meta'
        && (!last || (rec.createdAt ?? '') >= (last.createdAt ?? ''))) {
        last = rec;
      }
    }
    if (!last) continue;
    let meta;
    try { meta = JSON.parse(last.value); } catch { continue; }
    if (!meta || meta.status !== 'open' || !meta.startedAt) continue;
    const ageMs = nowMs - Date.parse(meta.startedAt);
    if (!Number.isFinite(ageMs) || ageMs < olderThanMs) continue;
    candidates.push({
      scope,
      sessionId: meta.id ?? scope.slice(SESSION_PREFIX.length),
      title: meta.title ?? '',
      startedAt: meta.startedAt,
      ageMs,
    });
  }
  return { scanned, candidates };
}
