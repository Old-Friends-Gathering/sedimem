// mcp/token-gate.js — 直连 MCP 的 token 校验（P0b B4，契约：docs/02 §3.24、docs/08 §7）
//
// 取舍（必须写清，否则后面的人会以为这是漏做）：
//   stdio 是**进程边界**：能写我们 stdin 的只有拉起我们的父进程，所以「本机 stdio 默认信任」
//   本身是一条结构保证，不是懒。强制 token 会把现有三端（DSH / Codex / Claude 的 MCP 配置）
//   全部打断——它们都只写 command/args，不会带 MEMO_MCP_TOKEN，也没有握手期 header 的惯例。
//   因此 B4 的选择是：
//     默认        = 信任本机 stdio（与 B4 之前行为一致，不破坏三端）；
//     MEMO_MCP_TOKEN=<token>            → 强制 token，必须与它一致；
//     MEMO_MCP_REQUIRE_TOKEN=1          → 强制 token，期望值取 <memoHome>/web-token（serve 写的那把）。
//   强制模式下未携带/带错 token 的请求一律 -32001 E_MCP_UNAUTHORIZED，且**不触达存储**。
//   若将来 MCP 支持 HTTP/UDS 传输，同一个 gate 可直接复用到那条真实网络边界上。
//
// token 的携带位置（首帧 header）：initialize 的 params._meta 里
//   _meta.token = '<token>'                             （最直接）
//   _meta.headers.authorization = 'Bearer <token>'      （模拟 HTTP header）
//   _meta.headers['x-memo-token'] = '<token>'           （备用）

import { readWebToken, tokensEqual } from '../config/web-token.js';
import { MEMO_HOME } from './session-tools.js';

/** 环境变量里直接给 token（优先于读文件）。 */
export const MCP_TOKEN_ENV = 'MEMO_MCP_TOKEN';
/** 置 1 表示强制 token，期望值取 `<memoHome>/web-token`。 */
export const MCP_REQUIRE_ENV = 'MEMO_MCP_REQUIRE_TOKEN';

/** 从 JSON-RPC 请求的 params._meta 里取调用方出示的 token；没有 → null。 */
export function mcpPresentedToken(params) {
  const meta = params && typeof params === 'object' ? params._meta : null;
  if (!meta || typeof meta !== 'object') return null;
  if (typeof meta.token === 'string' && meta.token.trim() !== '') return meta.token.trim();
  const headers = meta.headers;
  if (!headers || typeof headers !== 'object') return null;
  const authorization = typeof headers.authorization === 'string'
    ? headers.authorization
    : (typeof headers.Authorization === 'string' ? headers.Authorization : '');
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (m) return m[1];
  if (typeof headers['x-memo-token'] === 'string' && headers['x-memo-token'].trim() !== '') {
    return headers['x-memo-token'].trim();
  }
  return null;
}

/**
 * 建立本进程的 token 门禁。
 * @param {{env?: NodeJS.ProcessEnv, memoHome?: string}} [opts]
 * @returns {Promise<{required: boolean, expected: string|null}>}
 * @throws {Error & {code: 'E_MCP_TOKEN_MISSING'}} 强制模式但既无 env token 也无 token 文件
 */
export async function createMcpTokenGate({ env = process.env, memoHome = MEMO_HOME } = {}) {
  const requireFlag = String(env[MCP_REQUIRE_ENV] ?? '') === '1';
  const envToken = typeof env[MCP_TOKEN_ENV] === 'string' ? env[MCP_TOKEN_ENV].trim() : '';
  if (!requireFlag && envToken === '') return { required: false, expected: null };

  const expected = envToken !== '' ? envToken : await readWebToken(memoHome);
  if (!expected) {
    const err = new Error(
      `E_MCP_TOKEN_MISSING: ${MCP_REQUIRE_ENV}=1 但没有可用的 token（${memoHome}/web-token 不存在，且未设置 ${MCP_TOKEN_ENV}）`,
    );
    err.code = 'E_MCP_TOKEN_MISSING';
    throw err;
  }
  return { required: true, expected };
}

/**
 * 校验一条已经解析出来的请求；通过 → null，不通过 → 错误文案。
 * 纯函数：服务端把返回值包成 JSON-RPC error（-32001），测试也能直接断言。
 */
export function checkMcpToken(gate, params) {
  if (!gate || gate.required !== true) return null;
  if (tokensEqual(mcpPresentedToken(params), gate.expected)) return null;
  return 'E_MCP_UNAUTHORIZED: 缺少或错误的 MEMO token（stdio 客户端设置 MEMO_MCP_TOKEN，并在 initialize 的 params._meta.token 里回传）';
}
