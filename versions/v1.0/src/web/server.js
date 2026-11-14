// web/server.js — 只读 HTTP 服务（W3，契约：docs/08-web-ui.md §4.2、docs/02 §3.9 裁决 32/33/34）
// 只绑回环（D1）、无鉴权、无写端点；内部复用一个 MemoryService 实例。

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryService } from '../api/service.js';
import { SCOPE_PATTERN } from '../core/scope-state.js';
import { listScopes } from './scopes.js';
import { handleApi } from './handlers.js';
import { createStaticHandler } from './static.js';

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui');

/** 回环地址判定（127.0.0.0/8、::1、localhost）。'0.0.0.0'/'' 一律视为非回环。 */
function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return Boolean(m) && m.slice(1).every((n) => Number(n) <= 255);
}

/**
 * 创建并启动只读 Web 服务。
 * @param {{memoHome: string, scope?: string, port?: number, host?: string,
 *          includeUi?: boolean, service?: object}} args
 * @returns {Promise<{server: http.Server, url: string, close: () => Promise<void>}>}
 */
export async function createWebServer({
  memoHome, scope, port = 7788, host = '127.0.0.1', includeUi = true, service,
  write = process.env.MEMO_WRITE === '1', // W7：默认只读；显式 {write:true} 或 MEMO_WRITE=1 才开放写端点
} = {}) {
  // W7：把「是否可写」同步到进程环境，供 /api/summary 与 UI 只读门禁读取（避免再穿一层参数）
  if (write) process.env.MEMO_WRITE = '1';

  if (!memoHome) {
    const err = new Error('createWebServer: memoHome is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  // 裁决 41：只绑回环是结构保证，不是门禁纪律——传递 0.0.0.0/局域网 IP 一律拒绝
  if (!isLoopbackHost(host)) {
    const err = new Error(`createWebServer: host must be loopback (127.0.0.0/8 or ::1), got ${host}`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const svc = service ?? await createMemoryService({ memoHome, scope });
  const serveStatic = includeUi ? createStaticHandler(UI_DIR) : null;
  // 多分库浏览（docs/08 §13）：?scope= 指定其它分库时按需懒建服务并缓存。
  // scope 会直接进文件路径（items/<scope>.jsonl），所以必须过 SCOPE_PATTERN —— 否则就是 path traversal。
  const extra = new Map();
  const services = [];
  async function serviceFor(requested) {
    if (requested === undefined || requested === null || requested === '') return svc;
    const wanted = String(requested);
    if (!SCOPE_PATTERN.test(wanted)) {
      const err = new Error(`scope 不合法（需形如 repo:name / dir:name / session:id）: ${JSON.stringify(wanted)}`);
      err.code = 'E_INVALID_ARG';
      throw err;
    }
    if (wanted === svc.scope) return svc;
    if (!extra.has(wanted)) {
      const created = await createMemoryService({ memoHome, scope: wanted });
      await created._init();
      extra.set(wanted, created);
      services.push(created);
    }
    return extra.get(wanted);
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // 错误对象可能带绝对路径/栈信息：只把**可枚举的错误码**给客户端，正文一律固定文案
      // （js/stack-trace-exposure；本地服务也不该把内部路径递到浏览器里）。详情写 stderr 供排障。
      process.stderr.write(`[memo-web] ${req.method} ${req.url} 失败: ${err?.stack ?? err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          code: err?.code ?? 'E_INTERNAL',
          message: '内部错误（详见服务端日志）',
        }));
      } else {
        res.destroy(err);
      }
    });
  });

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'E_INVALID_ARG', message: 'malformed request url' }));
      return;
    }
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      // W7：POST 只放行人类可写端点（后续仍有 只读门禁/Origin 校验 在 write 通道内执行）；其余方法一律 405
      const isWritePost = req.method === 'POST'
        && (pathname === '/api/write' || pathname === '/api/supersede' || pathname === '/api/forget');
      if (req.method !== 'GET' && !isWritePost) {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, code: 'E_METHOD', message: `${req.method} not allowed (read-only GET API)` }));
        return;
      }
      if (pathname === '/api/scopes') {
        const payload = await listScopes(memoHome, svc.scope);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...payload }));
        return;
      }
      // 多分库：?scope= 覆盖启动分库；未指定则用启动时那个。
      // 非法 scope 在 serviceFor 里抛 E_INVALID_ARG —— 必须在 API 层映射成 400（否则会被外层兜成 500，
      // 客户端就分不清「你的参数错了」和「服务坏了」）。
      let active;
      try {
        active = await serviceFor(url.searchParams.get('scope'));
      } catch (e) {
        // 只回固定文案：错误对象可能带绝对路径/栈信息（js/stack-trace-exposure），本地服务也不该外泄
        const code = e?.code ?? 'E_INTERNAL';
        res.writeHead(code === 'E_INVALID_ARG' ? 400 : 500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          code,
          message: code === 'E_INVALID_ARG'
            ? 'scope 不合法（需形如 repo:name / dir:name / session:id）'
            : '切换分库失败',
        }));
        return;
      }
      // 裁决 39：常驻服务不写库，读前先按文件水位增量刷新，否则浏览器看到的截面会自相矛盾
      await active.refreshView();
      // W7：POST 写端点把 req（读 body）与写模式上下文递给 handleApi；GET 行为不变
      const writeOpts = isWritePost
        ? { write, serverPort: server.address()?.port ?? port }
        : undefined;
      const { status, body } = await handleApi(active, url, req, writeOpts);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return;
    }

    if (serveStatic && req.method === 'GET') {
      const { status, body, headers } = await serveStatic(pathname);
      res.writeHead(status, headers ?? { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'E_NOT_FOUND', message: `not found: ${pathname}` }));
  }

  // 裁决 41：本地只读服务不应被慢连接拖住——显式设超时，别依赖 Node 的 300s 默认值
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve); // host 必须原样传入（回环绑定，裁决 34）
  });

  const addr = server.address();
  const url = `http://${addr.family === 'IPv6' ? `[${addr.address}]` : addr.address}:${addr.port}/`;

  return {
    server,
    url,
    async close() {
      // 先掐掉空闲 keep-alive 连接，否则 close 会等它们自然超时（浏览器标签页常驻时尤其明显）
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
      for (const s of [svc, ...services]) {
        try { await s.close(); } catch { /* 单个分库 close 失败不阻塞整体关闭 */ }
      }
    },
  };
}
