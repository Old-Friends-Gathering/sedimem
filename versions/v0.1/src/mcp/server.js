#!/usr/bin/env node
/**
 * memo MCP server —— stdio JSON-RPC 2.0（换行分隔，非 Content-Length 分帧）。
 * 契约：docs/02-data-model-and-contract.md §3 `src/mcp/server.js`。
 * 入口层：只做 JSON-RPC 编解码与参数透传，业务全部委托 MemoryService。
 */
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import fs from 'node:fs';
import { validateArgs } from './validate.js';
import {
  clientKey,
  SCOPE_PATTERN,
  initScopeState as initScopeStateFrom,
  readScopeOverride,
  resolveUseTarget,
  scopeFilePath,
  writeScopeOverride,
} from './scope-state.js';

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
  ' 自我维护：本记忆库可能积累重复/冲突条目；当用户提到记忆、或会话结束前，若 brief 出现「待裁决去重候选」，' +
  '调用 memory_dedupe_scan 获取候选簇。' +
  '判裁决时看每簇的 pairs（逐对依据）：strength=strong 先怀疑同一事实；strength=weak 多为「同主题词重合」（实测与真改写区间重叠），' +
  '默认 keep_both 更安全。' +
  '裁决用 memory_curate(action="apply", decisions=[{ids:[pairs[].aId, pairs[].bId], decision:"a_wins|b_wins|merge|keep_both", note}])；' +
  '若走 memory_curate(action="export") 的批次，则改用 {pairIndex, decision, note} 并带 batchId。' +
  '同簇 merge 是**非破坏**的（败者 superseded 且真相层保留），所以宁判勿漏。这是本记忆系统自我迭代的主通道。';
const SERVER_INFO = { name: 'memo', version: '0.1.1' };

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
