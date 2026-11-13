#!/usr/bin/env node
/**
 * memo MCP server —— stdio JSON-RPC 2.0（换行分隔，非 Content-Length 分帧）。
 * 契约：docs/02-data-model-and-contract.md §3 `src/mcp/server.js`。
 * 入口层：只做 JSON-RPC 编解码与参数透传，业务全部委托 MemoryService。
 */
import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { validateArgs } from './validate.js';
import {
  clientKey,
  initScopeState as initScopeStateFrom,
  resolveUseTarget,
  writeScopeOverride,
} from './scope-state.js';
// 会话工具（v0.6 W2）：MCP 侧直接复用 session 数据层与 CLI 的晋升白名单，入口层只做参数校验
import {
  isSessionScope, startSession, sessionStatus, sweepSessions,
  resolveParentScope, updateSessionRegistry,
} from '../session/lifecycle.js';
import { normalizeCheckpoint, parseDshSummary, writeCheckpoint } from '../session/checkpoint.js';
import { renderHandoff, writeHandoff } from '../session/handoff.js';
import { PROMOTE_KINDS } from '../cli/session.js';

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', 20241105].map(String));
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const MAX_LINE_BYTES = 1024 * 1024; // 单行请求上限 1MB；超过按 Invalid Request 拒绝（见 rl.on('line')）
const INSTRUCTIONS =
  'memo 是本机跨 agent 记忆。需要历史事实先 memory_search；用户要求记住时用 memory_write；事实变更用 memory_supersede。' +
  ' scope（记忆分库）按 server 进程启动时的 cwd 解析（向上找 .git → repo:<name>，否则 dir:<name>）；' +
  '如需固定分库请设置环境变量 MEMO_SCOPE（如 MEMO_SCOPE=repo:myrepo）后重启 server，避免不同目录启动导致静默分库。' +
  ' 写入时未显式给 agent/source 则记为 unknown。' +
  ' 分库：本 server 是常驻进程，cwd 通常不是你的项目目录；若你知道当前项目根，先 memory_scope({action:"get"}) 看，' +
  '与本项目不符就 memory_scope({action:"use", path:"<项目根绝对路径>"}) 对齐（与 Claude/Codex 共享同一分库的关键一步）。' +
  '写记忆必须给 title（≤40 字、单行）：它就是图谱与 brief 上人看到的那句话；缺了只能从正文截 60 字，' +
  '实测同一分库 118 个节点里 51% 会和别人重名（"Mac mini A4x Bus…" 这种看不出区别）。' +
  ' 自我维护：本记忆库可能积累重复/冲突条目；当用户提到记忆、或会话结束前，若 brief 出现「待裁决去重候选」，' +
  '调用 memory_dedupe_scan 获取候选簇。' +
  '判裁决时看每簇的 pairs（逐对依据）：strength=strong 先怀疑同一事实；strength=weak 多为「同主题词重合」（实测与真改写区间重叠），' +
  '默认 keep_both 更安全。' +
  '裁决用 memory_curate(action="apply", decisions=[{ids:[pairs[].aId, pairs[].bId], decision:"a_wins|b_wins|merge|keep_both", note}])；' +
  '若走 memory_curate(action="export") 的批次，则改用 {pairIndex, decision, note} 并带 batchId。' +
  '同簇 merge 是**非破坏**的（败者 superseded 且真相层保留），所以宁判勿漏。这是本记忆系统自我迭代的主通道。' +
  ' 会话临时库（memory_session_*）：开始一段可丢弃的工作前用 memory_session_start 建临时库，三条规则——' +
  '①临时库只收 state/decision/gotcha（fact 禁止写入：close 时不会被晋升，写了就丢）；' +
  '②memory_session_close 只把 decision/gotcha 晋升主库，其余记录随库 tombstone，并写交接文档；' +
  '③完全手动：不自动建库、不自动压缩、不自动关闭，checkpoint 由你按需追加。';
/**
 * serverInfo.version 从 package.json 读，别写死（issue #41）：
 * 这个字段是客户端确认「我加载的是哪一版服务」的唯一手段，
 * 写死过一次 0.1.1 就落后了四个版本，排查时反而误导人。
 */
const SERVER_INFO = (() => {
  const fallback = '0.2.1';
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return { name: 'memo', version: String(pkg.version ?? fallback) };
  } catch {
    return { name: 'memo', version: fallback };
  }
})();

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** 工具表：name -> {description, inputSchema, handler(service, args) -> {text, structured?}} */

/** memory_write / memory_supersede 共用的 source 语义（C 项）：
 *  - `source` 对象（含 agent/session/quote，additionalProperties:false）
 *  - 顶层 `agent` 作为兼容别名
 *  - 两者都给且 agent 不一致 → 冲突错误；都缺 → agent='unknown'（不猜 'cli'） */
// 裁决 25：agent 不收窄成枚举（新客户端可直接接入）；保留名由 core/record.js 拒绝
const AGENT_PATTERN = '^[a-z0-9][a-z0-9._-]{0,31}$';
const SOURCE_PROPERTY = {
  type: 'object',
  properties: {
    agent: { type: 'string', pattern: AGENT_PATTERN },
    session: { type: 'string' },
    quote: { type: 'string' },
  },
  additionalProperties: false,
};
const AGENT_ALIAS_PROPERTY = { type: 'string', pattern: AGENT_PATTERN };

/** 把 args 里的 source / agent 归一成 service 需要的 source 对象。
 *  冲突时抛 code='E_SOURCE_CONFLICT'。 */
function normalizeSource(a) {
  if (a.source && a.agent !== undefined && a.source.agent !== a.agent) {
    const e = new Error(
      `E_SOURCE_CONFLICT: source.agent=${JSON.stringify(a.source.agent)} 与顶层 agent=${JSON.stringify(a.agent)} 不一致，请只传其一`,
    );
    e.code = 'E_SOURCE_CONFLICT';
    throw e;
  }
  if (a.source) {
    return { session: undefined, quote: undefined, ...a.source, agent: a.source.agent || a.agent || 'unknown' };
  }
  return { agent: a.agent || 'unknown' };
}

const TOOL_DEFS = [
  {
    name: 'memory_write',
    description: '写入一条记忆。返回 action（created/noop_duplicate/noop_same_value/supersede/disputed）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '人类可读原句（必填，≤4000 字）' },
        title: {
          type: 'string',
          description: '一句话标题（强烈建议填，≤40 字、单行）：图谱与 brief 上显示的就是它；不填会从 subject/正文里截，可读性差',
        },
        kind: { type: 'string', enum: ['fact', 'pref', 'decision', 'gotcha', 'state'] },
        subject: { type: 'string' },
        predicate: { type: 'string' },
        value: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', items: { type: 'string' } },
        privacy: { type: 'string', enum: ['private', 'shared'] },
        agent: AGENT_ALIAS_PROPERTY,
        source: SOURCE_PROPERTY,
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (s, a) => {
      const source = normalizeSource(a);
      const { agent, source: _s, ...rest } = a;
      return s
        .write({ ...rest, source })
        .then((r) => ({ text: `action=${r.action} id=${r.record.id}${r.supersededId ? ` superseded=${r.supersededId}` : ''}`, structured: r }));
    },
  },
  {
    name: 'memory_search',
    description: '按关键词检索记忆（BM25）。默认只返回 active 且未过期的记录。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1 },
        kind: { type: 'string', enum: ['fact', 'pref', 'decision', 'gotcha', 'state'] },
        asOf: { type: 'string', description: 'ISO-8601，返回当时有效版本' },
        includeDisputed: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (s, a) =>
      s.search(a.query, { limit: a.limit, kind: a.kind, asOf: a.asOf, includeDisputed: a.includeDisputed }).then((r) => ({
        text: r.items.map((i) => `[${i.record.kind}] ${i.record.text} (id=${i.record.id}, score=${i.score.toFixed(3)})`).join('\n') || '(无结果)',
        structured: r,
      })),
  },
  {
    name: 'memory_brief',
    description: '返回当前 scope 的确定性 brief（Markdown，≤lines 行）。',
    inputSchema: {
      type: 'object',
      properties: { lines: { type: 'number', minimum: 1 } },
      additionalProperties: false,
    },
    handler: (s, a) => s.brief(a).then((text) => ({ text })),
  },
  {
    name: 'memory_get',
    description: '按 id 取一条记忆记录。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (s, a) =>
      s.get(a.id).then((record) => {
        if (!record) {
          const e = new Error(`E_NOT_FOUND: ${a.id}`);
          e.code = 'E_NOT_FOUND';
          throw e;
        }
        return { text: JSON.stringify(record, null, 2), structured: record };
      }),
  },
  {
    name: 'memory_supersede',
    description: '用新值取代旧记录（旧记录追加 valid_to，新记录写入）。',
    inputSchema: {
      type: 'object',
      properties: {
        oldId: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
        value: { type: 'string' },
        text: { type: 'string' },
        agent: AGENT_ALIAS_PROPERTY,
        source: SOURCE_PROPERTY,
        reason: { type: 'string' },
      },
      required: ['oldId', 'value'],
      additionalProperties: false,
    },
    handler: (s, a) => {
      const source = normalizeSource(a);
      const { agent, source: _s, ...rest } = a;
      return s
        .supersede({ ...rest, source, reason: a.reason })
        .then((r) => ({ text: `superseded ${a.oldId} -> ${r.record.id}`, structured: r }));
    },
  },
  {
    name: 'memory_forget',
    description: '删除一条记忆（默认写墓碑，不物理删除）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
        mode: { type: 'string', enum: ['tombstone', 'purge'] },
        reason: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (s, a) =>
      s.forget({ id: a.id, mode: a.mode || 'tombstone', reason: a.reason }).then((r) => ({
        text: `forgot ${r.id}: ${r.status}`,
        structured: r,
      })),
  },
  {
    name: 'memory_curate',
    description: '离线裁决：action="export" 导出待裁决批次；action="apply" 应用裁决决定。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['export', 'apply'] },
        limit: { type: 'number', minimum: 1 },
        batchId: { type: 'string' },
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pairIndex: { type: 'number', description: 'curate export 批次的 pair 下标（与 ids 二选一）' },
              ids: {
                type: 'array',
                items: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
                minItems: 2,
                maxItems: 2,
                description: 'memory_dedupe_scan 返回的 pairs[].aId/bId（与 pairIndex 二选一）',
              },
              decision: { type: 'string', enum: ['a_wins', 'b_wins', 'merge', 'keep_both'] },
              note: { type: 'string' },
            },
            required: ['decision'],
            additionalProperties: false,
          },
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: (s, a) => {
      if (a.action === 'export') {
        return s.curateExport({ limit: a.limit }).then((batch) => ({
          text: batch ? `batchId=${batch.batchId} pairs=${batch.pairs.length}` : '无待裁决候选',
          structured: batch,
        }));
      }
      const decisions = a.decisions || [];
      // decisions 可以是两种形状（裁决 27）：ids:[a,b]（来自 memory_dedupe_scan 的 pairs，无批次）
      // 或 pairIndex + batchId（来自 memory_curate export 的批次）。混合形状交给 service 拒绝。
      const allIdsShape = decisions.length > 0 && decisions.every((d) => d && Array.isArray(d.ids));
      if (!a.batchId && !allIdsShape) {
        const e = new Error('E_INVALID_RECORD: apply 需要 batchId（批次形状）或全部 decisions 带 ids（扫描形状）');
        e.code = 'E_INVALID_RECORD';
        throw e;
      }
      return s.curateApply({ batchId: a.batchId, decisions }).then((r) => ({
        text: `applied ${r.applied.filter((x) => x.applied).length} decisions`,
        structured: r,
      }));
    },
  },
  {
    name: 'memory_dedupe_scan',
    description:
      '只读扫描近重复候选簇（裁决 22/23）：按 slot 分组 + 两两相似度并查集聚簇，返回候选供 Agent 裁决。绝不改数据。',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: { type: 'number', minimum: 0, maximum: 1, description: 'containment 阈值，默认 policy.dedupe.scanThreshold=0.45' },
        diceThreshold: { type: 'number', minimum: 0, maximum: 1, description: '字符二元组 Dice 阈值（中文改写召回），默认 policy.dedupe.scanDiceThreshold=0.15' },
        limit: { type: 'number', minimum: 1, description: '最多返回簇数，默认 50' },
      },
      additionalProperties: false,
    },
    handler: (s, a) => {
      if (typeof s.dedupeScan !== 'function') {
        const e = new Error('E_MISSING_DEDUPE_SCAN: MemoryService 尚未提供 dedupeScan（src/api/service.js 同事并行实现中）');
        e.code = 'E_MISSING_DEDUPE_SCAN';
        throw e;
      }
      return s.dedupeScan({ threshold: a.threshold, diceThreshold: a.diceThreshold, limit: a.limit }).then((r) => ({
        text:
          r.clusters.length === 0
            ? `scanned=${r.scanned} threshold=${r.threshold} diceThreshold=${r.diceThreshold}，无候选簇`
            : r.clusters
                .map(
                  (c) =>
                    `#${c.key} size=${c.size} maxSimilarity=${c.maxSimilarity.toFixed(3)} basis=${c.basis} (containment=${c.metrics?.maxContainment} dice=${c.metrics?.maxDice})\n` +
                    c.items.map((i) => `  - ${i.id} [${i.kind}] ${i.text}`).join('\n'),
                )
                .join('\n'),
        structured: r,
      }));
    },
  },
  {
    name: 'memory_stats',
    description: '返回当前 scope 的统计（total/active/superseded/disputed/tombstoned/dupRatio/conflictRate/avgHits）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (s) => s.stats().then((r) => ({ text: JSON.stringify(r), structured: r })),
  },
  {
    name: 'memory_scope',
    description:
      '查看或切换记忆分库（scope）。本机多个客户端（DSH/Codex/Claude）默认按各自进程 cwd 解析分库，' +
      '常驻进程（如 DSH 的 MCP server）cwd 固定，会导致「同一个项目被记到不同分库」。' +
      '当你要与其它客户端共享同一分库时：先 get 看当前值，再 use({path:"<项目根目录>"}) 对齐（解析规则与 cwd 自动解析完全一致）。' +
      '选择按客户端持久化到 $MEMO_HOME/.scope.<client>.json，重启后本客户端仍生效；传 scope 可直接指定（形如 repo:名字 / dir:名字）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'use'], description: 'get=查看当前 scope；use=切换' },
        path: { type: 'string', description: 'use 时可选：项目根目录（按与 cwd 相同的规则解析成 repo:/dir:）' },
        scope: { type: 'string', description: 'use 时可选：显式 scope，形如 repo:my-project / dir:work' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: (s, a, ctx) => scopeToolHandler(a, ctx),
  },
  // ===== 会话临时库工具（v0.6 W2）：业务委托 src/session/* 与 cli/session 的晋升白名单 =====
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
      const { scope, meta } = await startSession({ service: svc, title: a.title, repo: a.repo });
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
const TOOLS_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

const MEMO_HOME = process.env.MEMO_HOME || path.join(os.homedir(), '.memo');

/** scope → service 缓存：切换回来后不必重建索引。 */
const serviceCache = new Map();
async function getService(scope) {
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

async function closeAllServices() {
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
function makeServiceFacade(state) {
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
async function initConnScope(client) {
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

async function scopeToolHandler(a, ctx) {
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


async function handleMessage(msg, _service, state) {
  // 容忍通知与残缺输入：无 method 或非对象 → 忽略（JSON-RPC 通知没有 id，不回包）
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return null;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  // 任务 C（审核建议）：initialize 门禁——未初始化前除 initialize/ping 外的方法
  // 一律返回 -32002（Server not initialized），且绝不触达任何存储操作（提前返回，handler 不执行）。
  if (!state.initialized && method !== 'initialize' && method !== 'ping') {
    if (isNotification) return null; // 初始化前后的通知一律静默忽略
    return rpcError(id, -32002, 'Server not initialized');
  }

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion != null ? String(params.protocolVersion) : undefined;
      const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : FALLBACK_PROTOCOL_VERSION;
      state.initialized = true; // 收到 initialize 即视为已初始化（后续请求放行）
      state.client = (params && params.clientInfo && params.clientInfo.name) || 'unknown';
      const st = await initConnScope(state.client);
      state.scope = st.scope;
      state.scopeSource = st.source;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return null; // 通知：忽略，不回包
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const toolName = params && params.name;
      const tool = TOOLS_BY_NAME.get(toolName);
      if (!tool) {
        if (isNotification) return null;
        return rpcError(id, -32601, `未知工具: ${toolName}`);
      }
      const args = (params && params.arguments) || {};
      // 严格参数校验（fail-loud）：不合法输入绝不进入 handler（即绝不落库）
      const v = validateArgs(tool.inputSchema, args);
      if (!v.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `[E_INVALID_ARGS] ${v.errors.join('；')}` }],
          isError: true,
        });
      }
      try {
        const { text, structured } = await tool.handler(makeServiceFacade(state), args, state);
        const result = { content: [{ type: 'text', text }] };
        if (structured !== undefined) result.structuredContent = structured;
        return rpcResult(id, result);
      } catch (err) {
        // 业务错误 → isError:true，不用 JSON-RPC error
        return rpcResult(id, {
          content: [{ type: 'text', text: `[${err.code || 'E_UNKNOWN'}] ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null; // 未知通知也必须忽略（客户端可能先发 initialize 前的通知）
      return rpcError(id, -32601, `未知方法: ${method}`);
  }
}

async function main() {
  // 分库在 initialize 时按 clientInfo 决定（见 initConnScope）：不同客户端的覆盖文件互不干扰。

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // 每连接独立：initialize 门禁 + 运行期 scope（client/scope 在 initialize 时填充）
  const connState = { initialized: false, client: 'unknown', scope: null, scopeSource: null };
  let inFlight = 0; // 正在处理的请求数；stdin EOF 时必须等它清零再退出
  // 串行处理（A 项）：按到达顺序逐条处理，响应顺序与请求顺序一致，
  // 前一条的副作用（写入）对后一条可见；单条抛错不打断链。
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_LINE_BYTES) {
      // 大行防护：>1MB 的单行直接按 Invalid Request 拒绝（id 未知，用 null），
      // 不进入 JSON.parse，避免畸形超大输入拖垮进程。
      send(rpcError(null, -32600, `Invalid Request: 单行超过 ${MAX_LINE_BYTES} 字节上限`));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // 非法 JSON 行：无法确定 id，只能按 JSON-RPC Parse error 回 -32700（id 用 null）
      send(rpcError(null, -32700, `Parse error: 不是一个合法 JSON 行`));
      return;
    }
    inFlight++;
    queue = queue
      .then(() => handleMessage(msg, null, connState))
      .then((resp) => {
        if (resp) send(resp);
      })
      .catch((err) => {
        send(rpcError(msg.id ?? null, -32603, `Internal error: ${err.message}`));
      })
      .finally(() => {
        inFlight--;
      });
  });

  const shutdown = async () => {
    rl.close();
    while (inFlight > 0) await new Promise((r) => setTimeout(r, 10));
    try {
      await closeAllServices();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // stdin EOF（客户端断开）→ 排空在途请求后正常退出
  rl.on('close', async () => {
    while (inFlight > 0) await new Promise((r) => setTimeout(r, 10));
    try {
      await closeAllServices();
    } finally {
      process.exit(0);
    }
  });
}

main().catch((err) => {
  process.stderr.write(`memo MCP server 启动失败 [${err.code ?? 'E_UNKNOWN'}]: ${err.message}\n`);
  process.exit(1);
});
