#!/usr/bin/env node
/**
 * memo MCP server —— 会话临时库工具与运行期 scope/service 基础设施。
 * 从 src/mcp/server.js 拆出（v1.0 W5 拆大文件）：行为零变化，server.js re-export。
 * 入口层：只做 JSON-RPC 编解码与参数透传，业务全部委托 MemoryService。
 */
import process from 'node:process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// 会话工具（v0.6 W2）：MCP 侧直接复用 session 数据层与 CLI 的晋升白名单，入口层只做参数校验
import {
  isSessionScope, startSession, sessionStatus, sweepSessions,
  resolveParentScope, updateSessionRegistry,
} from '../session/lifecycle.js';
import { normalizeCheckpoint, parseDshSummary, writeCheckpoint } from '../session/checkpoint.js';
import { renderHandoff, writeHandoff } from '../session/handoff.js';
import { PROMOTE_KINDS } from '../session/cli-support.js';
import {
  clientKey,
  initScopeState as initScopeStateFrom,
  resolveUseTarget,
  writeScopeOverride,
} from './scope-state.js';

export const MEMO_HOME = process.env.MEMO_HOME || path.join(os.homedir(), '.memo');

/** scope → service 缓存：切换回来后不必重建索引。 */
const serviceCache = new Map();
export async function getService(scope) {
  const cached = serviceCache.get(scope);
  if (cached) return cached;
  let mod;
  try {
    mod = await import('../api/service.js');
  } catch (err) {
    const e = new Error(`memo MCP server: 无法加载 MemoryService (src/api/service.js)：${err.message}`);
    e.code = 'E_MISSING_SERVICE';
    throw e;
  }
  const svc = mod.createMemoryService({ memoHome: MEMO_HOME, cwd: process.cwd(), scope });
  serviceCache.set(scope, svc);
  return svc;
}

export async function closeAllServices() {
  const all = [...serviceCache.values()];
  serviceCache.clear();
  await Promise.all(all.map((s) => s.close().catch(() => {})));
}

// ===== 会话工具辅助（业务在 TOOL_DEFS 里，工具函数在此） =====

/** 带错误码的 Error 工厂（与 src/session/* 同款风格） */
function ecode(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/** start 时记录的「晋升目标」：session scope → start 时的主库 scope */
const sessionOrigins = new Map();

/** 解析会话工具的目标 scope：缺省用服务器当前 scope；非 session:* → 提示先 start */
function resolveSessionScopeArg(a, state) {
  const scope = a.scope ?? state.scope;
  if (!isSessionScope(scope)) {
    throw ecode(
      'E_INVALID_ARG',
      `目标 scope 必须是 session:<id>，当前是 ${JSON.stringify(scope)}；请先调用 memory_session_start 创建会话临时库`,
    );
  }
  return scope;
}

/**
 * 打开绑定到 session scope 的真实 service（writeCheckpoint/sessionStatus 需要 .scope/_records）。
 * 目标就是当前 scope 时复用缓存（不 close），否则现开一个临时服务并在调用方关闭。
 */
async function openSessionService(scope, state) {
  if (scope === state.scope) return { svc: await getService(scope), owned: false };
  const { createMemoryService } = await import('../api/service.js');
  return { svc: await createMemoryService({ memoHome: MEMO_HOME, scope }), owned: true };
}

/** close 的晋升目标：登记文件 sessions/<id>.json（B-02 后的真相源）> meta 回落（仅非 session 型
 *  且匹配 SCOPE_PATTERN）> start 时记住的主库 > 当前 scope（非 session 时）> 按 cwd/env 重新解析 */
async function mainScopeFor(state, sessionScope, meta) {
  const { parentScope } = resolveParentScope(MEMO_HOME, sessionScope, meta);
  if (parentScope) return parentScope;
  if (sessionOrigins.has(sessionScope)) return sessionOrigins.get(sessionScope);
  if (!isSessionScope(state.scope)) return state.scope;
  const { resolveScope } = await import('../core/scope.js');
  return resolveScope({ cwd: process.cwd(), env: process.env });
}

/** memory_session_close 的业务（与 cli/session close 同一流程：晋升 → handoff → closed meta → tombstone） */
async function closeSessionTool(a, state) {
  const scope = resolveSessionScopeArg(a, state);
  const sessionId = scope.slice('session:'.length);
  const { svc, owned } = await openSessionService(scope, state);
  try {
    const status = sessionStatus({ service: svc });
    const closedHandoff = path.join(MEMO_HOME, 'handoffs', `${sessionId}.md`);
    // 幂等：meta 已是 closed → 直接返回，不再晋升/落盘
    if (status.meta && status.meta.status === 'closed') {
      return {
        text: `session ${sessionId} 已关闭（幂等，无动作）`,
        structured: {
          ok: true, scope, alreadyClosed: true,
          promoted: [], forgotten: 0,
          handoffPath: existsSync(closedHandoff) ? closedHandoff : null,
        },
      };
    }

    const mainScope = await mainScopeFor(state, scope, status.meta);
    // 对抗 B1/B-02：晋升目标为空或仍是 session 型（session-in-session）→ 拒绝，与 CLI 对齐
    if (!mainScope || isSessionScope(mainScope)) {
      throw ecode('E_INVALID_ARG',
        `session ${sessionId} 的晋升目标无效（${JSON.stringify(mainScope)}）；` +
        `请用绑定主库（repo:/dir:）的服务执行 session start 后重试`);
    }
    const main = await getService(mainScope); // 晋升目标主库（真实 service，可 write）
    const records = [...svc._records.values()].filter((r) => r.status === 'active');

    // ① 白名单 kind 晋升主库（tags 加 from-session:<id>）
    const promoted = [];
    for (const r of records) {
      if (r.subject === 'session' && (r.predicate === 'meta' || r.predicate === 'checkpoint')) continue;
      if (!PROMOTE_KINDS.has(r.kind)) continue;
      const tags = Array.isArray(r.tags) ? [...r.tags] : [];
      const tag = `from-session:${sessionId}`;
      if (!tags.includes(tag)) tags.push(tag);
      const w = await main.write({
        text: r.text,
        ...(typeof r.title === 'string' && r.title !== '' ? { title: r.title } : {}),
        kind: r.kind,
        subject: r.subject,
        predicate: r.predicate,
        value: r.value,
        confidence: r.confidence,
        tags,
        privacy: r.privacy,
        source: { agent: r.source?.agent ?? 'cli' },
      });
      promoted.push({ kind: r.kind, id: w.record.id, title: r.title, text: r.text });
    }

    // 取最后一个 checkpoint（createdAt 最大）做交接底稿
    const lastCpRecord = records
      .filter((r) => r.subject === 'session' && r.predicate === 'checkpoint')
      .sort((x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? ''))[0];
    let checkpoint = null;
    if (lastCpRecord) {
      try {
        checkpoint = normalizeCheckpoint(JSON.parse(lastCpRecord.value));
      } catch { /* 坏 checkpoint 不阻断 close，只是交接缺底稿 */ }
    }

    // ② nextSteps 写成主库一条 handoff state
    if (checkpoint && Array.isArray(checkpoint.nextSteps) && checkpoint.nextSteps.length > 0) {
      await main.write({
        text: `session ${sessionId} handoff: ${checkpoint.nextSteps.join('；')}`,
        kind: 'state',
        subject: 'session',
        predicate: 'handoff',
        value: JSON.stringify({ sessionId, nextSteps: checkpoint.nextSteps }),
        tags: [`from-session:${sessionId}`],
        source: { agent: 'cli' },
      });
    }

    // ③ 写交接文档 <memoHome>/handoffs/<id>.md（幂等覆盖）
    const meta = status.meta ?? { id: sessionId };
    const markdown = renderHandoff({ sessionId, meta, checkpoint, promoted, pending: [] });
    const handoffPath = writeHandoff({ memoHome: MEMO_HOME, sessionId, markdown });

    // ④ meta 置 closed，其余记录 tombstone（保留 closed meta）
    const closedMeta = { ...meta, status: 'closed', closedAt: new Date().toISOString() };
    await svc.write({
      text: `session ${sessionId} 关闭`,
      kind: 'state',
      subject: 'session',
      predicate: 'meta',
      value: JSON.stringify(closedMeta),
      source: { agent: 'cli' },
      _sessionInternal: true, // lifecycle 内部写 meta 旁路（E_SESSION_META_PROTECTED 不拦）
    });
    // 登记文件同步置 closed（状态真相源；B-03：此后该 scope 写入被拒）
    updateSessionRegistry(MEMO_HOME, scope, { status: 'closed', closedAt: closedMeta.closedAt });
    let forgotten = 0;
    for (const r of svc._records.values()) {
      if (r.status !== 'active') continue;
      if (r.subject === 'session' && r.predicate === 'meta') continue;
      await svc.forget({ id: r.id, reason: 'session-closed' });
      forgotten++;
    }
    sessionOrigins.delete(scope);

    return {
      text: `session ${sessionId} 已关闭：晋升 ${promoted.length} 条到主库（${mainScope}），tombstone ${forgotten} 条；交接文档 ${handoffPath}`,
      structured: { ok: true, scope, alreadyClosed: false, promoted, forgotten, handoffPath },
    };
  } finally {
    if (owned) await svc.close().catch(() => {});
  }
}

/** 服务门面：每次方法调用按「当前 scope」解析服务，切换后所有工具立即跟随。 */
export function makeServiceFacade(state) {
  return new Proxy(
    {},
    {
      get: (_t, prop) => (...args) => getService(state.scope).then((svc) => svc[prop](...args)),
    },
  );
}

/**
 * 运行期分库（裁决 28）：env MEMO_SCOPE > 按客户端隔离的覆盖文件 > cwd 解析。
 * 客户端身份来自 initialize 的 clientInfo.name —— 覆盖文件必须按客户端分开，
 * 否则 DSH 把 scope 切到 A 之后，Claude 在项目 B 启动也会读到 A（跨项目污染）。
 */
export async function initConnScope(client) {
  const { resolveScope } = await import('../core/scope.js');
  const st = initScopeStateFrom({ memoHome: MEMO_HOME, cwd: process.cwd(), env: process.env, resolveScope, client });
  process.stderr.write(
    `[memo-mcp] client=${clientKey(client)} scope=${st.scope}（来源：${st.source}）cwd=${process.cwd()} memoHome=${MEMO_HOME}\n` +
      (st.source === 'cwd'
        ? '[memo-mcp] 提示：分库按本进程 cwd 解析，常驻进程 cwd 固定；要与其它客户端共享分库，调用 memory_scope({action:"use", path:"/abs/path/to/project"})\n'
        : ''),
  );
  return st;
}

export async function scopeToolHandler(a, ctx) {
  if (a.action === 'get') {
    return {
      text: `scope=${ctx.scope}（来源：${ctx.scopeSource}）`,
      structured: { scope: ctx.scope, source: ctx.scopeSource, client: clientKey(ctx.client), memoHome: MEMO_HOME },
    };
  }
  const { resolveScope } = await import('../core/scope.js');
  const next = resolveUseTarget({ scope: a.scope, path: a.path, resolveScope });
  await getService(next); // 先建好；建失败则不改状态（fail-loud）
  ctx.scope = next;
  ctx.scopeSource = `runtime(${a.path ? 'path' : 'explicit'})`;
  const file = writeScopeOverride(MEMO_HOME, next, ctx.client);
  process.stderr.write(`[memo-mcp] client=${clientKey(ctx.client)} scope 切换 → ${next}（已持久化到 ${file}）\n`);
  return {
    text: `scope 已切换为 ${next}（本客户端后续所有工具立即生效，且已持久化，重启后仍生效）`,
    structured: { scope: next, source: ctx.scopeSource, client: clientKey(ctx.client), memoHome: MEMO_HOME },
  };
}

// ===== 会话临时库工具（v0.6 W2）：业务委托 src/session/* 与 cli/session 的晋升白名单 =====
export const SESSION_TOOL_DEFS = [
  {
    name: 'memory_session_start',
    description: '开始一个会话临时库（scope 形如 session:<id>）：写 meta 并返回 scope。close 时只晋升 decision/gotcha，其余随库丢弃。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', pattern: '^[\\s\\S]{1,120}$', description: '会话标题（必填，1..120 字）' },
        repo: { type: 'string', description: '可选：关联仓库标识/路径' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: async (s, a, state) => {
      // startSession 需要带 memoHome/scope 的真实 service（facade 只有方法），用当前 scope 的缓存服务
      const svc = await getService(state.scope);
      const { scope, meta } = await startSession({
        service: svc,
        title: a.title,
        repo: a.repo,
        // 工厂：按新 session scope 现开服务（mcp→api 是允许方向）
        serviceFactory: async ({ memoHome, scope: sScope, clock }) => {
          const { createMemoryService } = await import('../api/service.js');
          return createMemoryService({ memoHome, scope: sScope, clock });
        },
      });
      sessionOrigins.set(scope, state.scope); // 记住晋升目标（close 时回到 start 时的主库）
      const hint =
        '这是临时库：close 时只晋升 decision/gotcha 到主库，其余记录会被 tombstone；' +
        '后续 checkpoint/status/close 请带 scope 参数（或用 memory_scope 切到该临时库）。';
      return { text: `session 已创建: ${scope}\n${hint}`, structured: { ok: true, scope, hint, meta } };
    },
  },
  {
    name: 'memory_session_checkpoint',
    description: '向会话临时库追加一条 8 段 checkpoint（intent/concepts/files/errorsAndFixes/pendingJobs/currentState/nextSteps/criticalContext）。' +
      'checkpoint 与 fromSummary 至少给其一，都给时 checkpoint 优先。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'session:<id>；缺省用服务器当前 scope（必须是 session:*）' },
        checkpoint: {
          type: 'object',
          description: '8 段 checkpoint 对象；数组型五段（concepts/files/errorsAndFixes/pendingJobs/nextSteps），字符串型三段（intent/currentState/criticalContext）',
          properties: {
            intent: { type: 'string' },
            concepts: { type: 'array', items: { type: 'string' } },
            files: { type: 'array', items: { type: 'string' } },
            errorsAndFixes: { type: 'array', items: { type: 'string' } },
            pendingJobs: { type: 'array', items: { type: 'string' } },
            currentState: { type: 'string' },
            nextSteps: { type: 'array', items: { type: 'string' } },
            criticalContext: { type: 'string' },
          },
        },
        fromSummary: { type: 'object', description: 'DSH compaction/summary 事件 payload（自由形状，交给 parseDshSummary 解析）' },
      },
      additionalProperties: false,
    },
    handler: async (s, a, state) => {
      const scope = resolveSessionScopeArg(a, state);
      let checkpoint;
      let compactionId;
      if (a.checkpoint) {
        checkpoint = normalizeCheckpoint(a.checkpoint); // checkpoint 优先（两者都给时）
      } else if (a.fromSummary) {
        const parsed = parseDshSummary(a.fromSummary);
        checkpoint = parsed.checkpoint;
        compactionId = parsed.dsh.compactionId ?? undefined;
      } else {
        throw ecode('E_INVALID_ARG', 'checkpoint 与 fromSummary 至少给其一（都不给无法追加 checkpoint）');
      }
      const { svc, owned } = await openSessionService(scope, state);
      try {
        const r = await writeCheckpoint({ service: svc, scope, checkpoint, compactionId });
        return {
          text: `checkpoint 已追加 (${r.record.id} @ ${r.record.createdAt})`,
          structured: { ok: true, action: r.action, recordId: r.record.id, scope, checkpoint: r.checkpoint },
        };
      } finally {
        if (owned) await svc.close().catch(() => {});
      }
    },
  },
  {
    name: 'memory_session_status',
    description: '查看会话临时库概况：meta / checkpoint 数 / 期间事实数 / 最后一次 checkpoint 时间。',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', description: 'session:<id>；缺省用服务器当前 scope（必须是 session:*）' } },
      additionalProperties: false,
    },
    handler: async (s, a, state) => {
      const scope = resolveSessionScopeArg(a, state);
      const { svc, owned } = await openSessionService(scope, state);
      try {
        const st = sessionStatus({ service: svc });
        return {
          text: `session ${st.sessionId} status=${st.status} checkpoints=${st.checkpoints} facts=${st.facts} lastCheckpointAt=${st.lastCheckpointAt ?? '无'}`,
          structured: {
            ok: true, scope, sessionId: st.sessionId, meta: st.meta,
            checkpoints: st.checkpoints, facts: st.facts,
            lastCheckpointAt: st.lastCheckpointAt, status: st.status,
          },
        };
      } finally {
        if (owned) await svc.close().catch(() => {});
      }
    },
  },
  {
    name: 'memory_session_close',
    description: '关闭会话临时库：白名单 decision/gotcha 晋升主库（tags 加 from-session:<id>），其余记录 tombstone，写交接文档。幂等：重复 close 返回 alreadyClosed。',
    inputSchema: {
      type: 'object',
      properties: { scope: { type: 'string', description: 'session:<id>；缺省用服务器当前 scope（必须是 session:*）' } },
      additionalProperties: false,
    },
    handler: async (s, a, state) => closeSessionTool(a, state),
  },
  {
    name: 'memory_session_sweep',
    description: '兜底扫描僵尸会话临时库：只报告 startedAt 早于 olderThanMs 且仍 open 的候选，不删不改（自动关闭永远不做）。',
    inputSchema: {
      type: 'object',
      properties: {
        olderThanMs: { type: 'number', minimum: 1, description: '阈值毫秒，默认 14 天' },
      },
      additionalProperties: false,
    },
    handler: (s, a) => {
      const olderThanMs = a.olderThanMs ?? 14 * 86_400_000;
      const r = sweepSessions({ memoHome: MEMO_HOME, olderThanMs });
      return {
        text:
          `扫描 ${r.scanned} 个 session scope，候选 ${r.candidates.length} 个（只报告，不删）\n` +
          r.candidates.map((c) => `  ${c.scope}  开始于 ${c.startedAt}  ${c.title}`).join('\n'),
        structured: { ok: true, scanned: r.scanned, candidates: r.candidates },
      };
    },
  },
];
