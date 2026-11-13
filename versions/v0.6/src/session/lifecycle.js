// session/lifecycle.js — 会话临时库生命周期（v0.6 W2，契约：docs/plans/v0.6-memory-quality-and-session.md §2.2/§2.3）
// session 是「可丢弃、可晋升」的中间层：scope 前缀 session:<id>，只有 state/checkpoint 与
// 白名单 kind（decision/gotcha）有意义；close 时白名单晋升主库，其余 tombstone。
// 本模块只做数据层，不自动触发（不做自动建库/自动压缩/自动关闭）。

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../core/clock.js';
import { itemsFileName, scopeFromItemsFileName } from '../config/paths.js';

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
 * 写入门禁：session scope 下禁 fact（E_SCRATCH_KIND_FORBIDDEN）。
 * 其余 kind 不拦——close 时按白名单 {decision, gotcha} 晋升，白名单外的自然随库丢弃。
 * @param {string} scope
 * @param {string} kind
 */
export function assertWritableKind(scope, kind) {
  if (isSessionScope(scope) && SCRATCH_FORBIDDEN_KINDS.has(kind)) {
    throw err('E_SCRATCH_KIND_FORBIDDEN',
      `session scope (${scope}) 下禁止写 kind=${kind}：临时库里的 fact 不会被晋升，` +
      `close 时只保留 decision/gotcha。要写长期事实请写主库。`);
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

/** 供 startSession 在需要时按 session scope 现开一个服务（避免 CLI 与本模块重复拼 createMemoryService 参数） */
async function openSessionService(memoHome, scope, clock) {
  const { createMemoryService } = await import('../api/service.js');
  return createMemoryService({ memoHome, scope, clock });
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
export async function startSession({ service, title, repo, clock = systemClock, sessionScope }) {
  if (!service) throw err('E_INVALID_ARG', 'startSession: service is required');
  if (sessionScope !== undefined && !isSessionScope(sessionScope)) {
    throw err('E_INVALID_ARG',
      `startSession: sessionScope 必须形如 ${SESSION_PREFIX}<id>，收到 ${JSON.stringify(sessionScope)}`);
  }
  // 显式 sessionScope 优先；否则：已绑定 session scope 沿用（测试/二次进入），再否则生成新 id
  const reuse = !sessionScope && isSessionScope(service.scope);
  const id = sessionScope ? sessionScope.slice(SESSION_PREFIX.length)
    : reuse ? service.scope.slice(SESSION_PREFIX.length) : createSessionId(clock);
  const scope = SESSION_PREFIX + id;
  const svc = reuse ? service : await openSessionService(service.memoHome, scope, clock);
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
    });
  } finally {
    if (!reuse) await svc.close();
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
    status: meta ? meta.status : 'unknown',
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
