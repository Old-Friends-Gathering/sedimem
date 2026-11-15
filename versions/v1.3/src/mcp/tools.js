#!/usr/bin/env node
/**
 * memo MCP server —— 工具表（TOOL_DEFS）与入口常量。
 * 从 src/mcp/server.js 拆出（v1.0 W5 拆大文件）：行为零变化，server.js re-export。
 * memory_* 工具的纯数据（name/description/inputSchema）与 handler 在此；会话工具在 session-tools.js。
 */
import { readFileSync } from 'node:fs';
import { scopeToolHandler, SESSION_TOOL_DEFS } from './session-tools.js';

export const MAX_LINE_BYTES = 1024 * 1024; // 单行请求上限 1MB；超过按 Invalid Request 拒绝（见 rl.on('line')）
export const INSTRUCTIONS =
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
export const SERVER_INFO = (() => {
  const fallback = '0.2.1';
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return { name: 'memo', version: String(pkg.version ?? fallback) };
  } catch {
    return { name: 'memo', version: fallback };
  }
})();

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

const MEMORY_TOOL_DEFS = [
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
];

export const TOOL_DEFS = [...MEMORY_TOOL_DEFS, ...SESSION_TOOL_DEFS];
export const TOOLS_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));
