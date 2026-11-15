#!/usr/bin/env node
/**
 * memo MCP server —— stdio JSON-RPC 2.0（换行分隔，非 Content-Length 分帧）。
 * 契约：docs/02-data-model-and-contract.md §3 `src/mcp/server.js`。
 * 入口层：只做 JSON-RPC 编解码与参数透传，业务全部委托 MemoryService。
 * 工具表与常量在 tools.js，会话工具与 scope/service 基础设施在 session-tools.js（v1.0 W5 拆分）。
 */
import process from 'node:process';
import readline from 'node:readline';
import { validateArgs } from './validate.js';
import { TOOLS_BY_NAME, SERVER_INFO, INSTRUCTIONS, MAX_LINE_BYTES } from './tools.js';
import {
  getService, closeAllServices, initConnScope, makeServiceFacade,
} from './session-tools.js';
// 架构边界基线：mcp → session/cli-support 的边由本文件持有（tests/unit/arch-boundaries.test.js）
import { PROMOTE_KINDS } from '../session/cli-support.js';

// 兼容导出：插件与测试从 server.js import 这些名字（原实现拆到 tools.js）
export { validateArgs, MAX_LINE_BYTES, INSTRUCTIONS, SERVER_INFO, PROMOTE_KINDS };

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', 20241105].map(String));
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
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
        tools: [...TOOLS_BY_NAME.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
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
  // v1.0 W3 裁决 86：MCP 空闲时排空派生队列（第二顺位 drain 者）。
  // 只在端口就绪且已初始化时工作：未配置 LLM 时零成本，协议处理路径完全不受影响。
  const idleDeriver = (() => {
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || !connState.initialized || !connState.scope) return;
      try {
        const svc = await getService(connState.scope);
        if (!svc?.llmPort?.ready) return;
        const out = await svc.drainDerive({ limit: 5 });
        if (out.claimed > 0) {
          process.stderr.write(`[memo] idle derive: claimed=${out.claimed} ok=${out.ok} failed=${out.failed}\n`);
        }
      } catch (err) {
        process.stderr.write(`[memo] idle derive skipped: ${err?.message ?? err}\n`);
      }
    }, 30000);
    timer.unref?.();
    return { stop() { stopped = true; clearInterval(timer); } };
  })();
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
      idleDeriver.stop();
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
