/**
 * dsh-sedimem —— sedimem 记忆中心（DSH 宿主侧插件）。
 *
 * 「原来的记忆系统保留」是本插件的第一设计约束：
 *  - 宿主侧优先**复用已运行的观察台**（config.observerUrl / SEDIMEM_OBSERVER_URL，
 *    本机 launchd 常驻的 127.0.0.1:7788）——插件只是同源代理壳，不产生第二套会漂移的代码；
 *  - 外部观察台不可达时才 fallback 到内嵌副本（为只装插件、没装完整系统的用户兜底）；
 *  - MCP 的 memory_* 工具与插件无关，仍由 cordis.patch.yml 里的 dsh-mcp-client 行提供。
 *
 * 职责四件：
 *  1. 观察台生命周期：外部优先、内嵌兜底（空闲回环端口 + spawn observer-entry.mjs）；
 *  2. `api/dsh-sedimem/ui` 前缀路由反向代理 —— 侧边栏 iframe 同源，不吃跨源/X-Frame-Options 的亏；
 *  3. `api/dsh-sedimem/health` 精确路由，客户端显示运行态；
 *  4. **每步记忆注入**（v0.4 D2，默认关闭）：注册 `systemPrompt.context`，每步把
 *     brief/items 的短目录（≤ maxChars）以「数据不是指令」的围栏文本注入。
 *     配置：`inject: {mode:'off'|'on', maxChars, scope}` 或环境变量 SEDIMEM_INJECT=on。
 *
 * 刻意不做：KeepAlive 重启循环（launchd 的职责域）；改写 ~/.memo 任何数据。
 */
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPreStep } from './pre-step.js';

const PKG_ID = 'dsh-sedimem';
/** 观察台 UI 前缀（客户端 iframe 用文档相对路径 `api/dsh-sedimem/ui/` 访问，无前导斜杠）。 */
const UI_PREFIX = '/api/dsh-sedimem/ui';
const HEALTH_PATH = '/api/dsh-sedimem/health';
/** 子进程就绪等待上限（ms）：观察台零依赖冷启动 <300ms，5s 足够覆盖慢盘。 */
const READY_TIMEOUT_MS = 5000;
/** 前缀被剥掉后的最大剩余路径长度，防畸形长 URL 打满代理。 */
const MAX_SUB_PATH = 4096;

/** 插件名（Cordis 稳定标识）。 */
export const name = PKG_ID;
/** 依赖宿主服务：webServer 注册路由；systemPrompt 可选（没有就跳过每步注入）。 */
export const inject = { required: ['webServer'], optional: ['systemPrompt'] };
/** 路由常量（测试与客户端镜像用）。 */
export const routes = { UI_PREFIX, HEALTH_PATH };

const here = path.dirname(fileURLToPath(import.meta.url));
const observerEntry = path.join(here, 'observer-entry.mjs');

/**
 * 挑一个空闲回环端口。listen(0) 由内核分配，close 与 spawn 之间存在极小的竞态窗口，
 * 本地单用户场景可接受；观察台 EADDRINUSE 会显式报错而不是静默错。
 * @returns {Promise<number>}
 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 找最近活跃的分库作为观察台默认 scope：扫 items/*.jsonl 取 mtime 最新者。
 * 文件名即 scope（mac/Linux 原样、Windows 把 `:` 换成 `+`，两种都还原）。
 * 没有任何分库时返回 undefined（服务端回落到自己的默认解析）。
 * @param {string} memoHome
 * @returns {string | undefined}
 */
function newestScope(memoHome) {
  try {
    const dir = path.join(memoHome, 'items');
    let best = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      let mtime;
      try {
        mtime = statSync(path.join(dir, name)).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) {
        best = { mtime, scope: scopeFromFileName(name) };
      }
    }
    return best ? best.scope : undefined;
  } catch {
    return undefined;
  }
}

/** items 文件名 → scope 字符串（Windows 的 `+` 还原成 `:`）。 */
function scopeFromFileName(name) {
  const base = name.slice(0, -'.jsonl'.length);
  return base.includes(':') ? base : base.replace(/\+/g, ':');
}

/**
 * 请求信任栅栏（对齐 skill-explorer 的防线，取其子集）：
 * 回环 socket + 回环 Host + 无代理转发头 + 浏览器标记非跨站。
 * 观察台本身只读且只绑回环，这里是纵深防御的第二层。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isAllowed(req) {
  const remote = req.socket?.remoteAddress ?? '';
  const isLoopbackAddr =
    remote.startsWith('127.') || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLoopbackAddr) return false;
  let hostname = '';
  try {
    hostname = new URL(`http://${req.headers.host ?? ''}`).hostname;
  } catch {
    return false;
  }
  if (hostname !== 'localhost' && !( /^127\./.test(hostname) || hostname === '::1')) return false;
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false;
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return false;
  return true;
}

/** 写 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 探测观察台 /api/summary 是否 200。 */
function probeOk(port) {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/summary', method: 'GET', timeout: 900 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * 插件 apply：观察台生命周期（外部优先、内嵌兜底）+ 注册两条路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文。
 * @param {{enabled?: boolean, memoHome?: string, port?: number, scope?: string, nodePath?: string, observerUrl?: string}} [config]
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return;
  const memoHome = config.memoHome ?? process.env.MEMO_HOME ?? path.join(homedir(), '.memo');
  const nodePath = config.nodePath ?? process.execPath;
  /** 外部观察台（如 launchd 常驻的 7788）：有效则内嵌副本永不启动。 */
  const externalUrl = config.observerUrl ?? process.env.SEDIMEM_OBSERVER_URL ?? null;
  const externalPort = externalUrl ? portFromUrl(externalUrl) : 0;

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** 观察台当前端口（外部=externalPort；内嵌=spawn 成功后写入）。 */
  let port = 0;
  /** 当前模式：'external' | 'embedded' | null。 */
  let mode = null;
  /** @type {Promise<number> | null} 启动互斥：并发请求共享同一次拉起。 */
  let starting = null;

  const log = (...args) => { try { ctx.logger?.info?.(`[${PKG_ID}]`, ...args); } catch { /* 日志不可用不致命 */ } };
  const warn = (...args) => { try { ctx.logger?.warn?.(`[${PKG_ID}]`, ...args); } catch { /* 同上 */ } };

  /** URL → 回环端口；非法/非回环返回 0（安全栅栏：外部目标必须仍是本机回环）。 */
  function portFromUrl(u) {
    try {
      const parsed = new URL(u);
      const p = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      const h = parsed.hostname;
      const loopback = h === 'localhost' || h === '::1' || /^127\./.test(h);
      if (!loopback || !Number.isInteger(p) || p <= 0) return 0;
      return p;
    } catch {
      return 0;
    }
  }

  /**
   * 确保观察台可代理：
   *  1. 配了 observerUrl 且活着 → 直接用（模式 external）；
   *  2. 否则 fallback 到内嵌副本（模式 embedded），spawn 并等 /api/summary 200。
   * @returns {Promise<number>} 观察台端口。
   */
  async function ensureObserver() {
    // 注意：probeOk 返回 Promise，必须 await（漏掉 = Promise 恒真，死掉的外部观察台永远复用）
    if (mode === 'external' && externalPort && (await probeOk(externalPort))) return externalPort;
    if (mode === 'embedded' && child && child.exitCode === null && !child.killed) return port;
    if (starting) return starting;
    starting = (async () => {
      // ① 外部优先（一次探测决定，不反复横跳）
      if (externalPort && await probeOk(externalPort)) {
        mode = 'external';
        log(`using external observer at ${externalUrl}`);
        starting = null; // 成功即清：外部死掉后下一次调用能重新决策（否则永远拿到旧端口）
        return externalPort;
      }
      // ② 内嵌兜底
      const chosen = config.port ?? (await pickFreePort());
      const env = { ...process.env, MEMO_HOME: memoHome, MEMO_PORT: String(chosen) };
      const scope = config.scope ?? newestScope(memoHome);
      if (scope) env.MEMO_SCOPE = scope;
      const proc = spawn(nodePath, [observerEntry], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = proc;
      proc.stdout.on('data', (chunk) => log('observer:', String(chunk).trim()));
      proc.stderr.on('data', (chunk) => warn('observer:', String(chunk).trim()));
      proc.on('exit', (code, signal) => {
        if (child === proc) { child = null; port = 0; if (mode === 'embedded') mode = null; starting = null; }
        warn(`observer exited (code=${code} signal=${signal})`);
      });
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        if (child !== proc) throw new Error('observer exited during startup');
        if (await probeOk(chosen)) {
          port = chosen;
          mode = 'embedded';
          log(`embedded observer ready on 127.0.0.1:${chosen} (scope=${scope ?? 'auto'})`);
          starting = null; // 成功即清：子进程 exit 回调里也会清，这里兜启动即成功的路径
          return chosen;
        }
        if (Date.now() > deadline) {
          const err = new Error(`observer not ready within ${READY_TIMEOUT_MS}ms on port ${chosen}`);
          err.code = 'E_OBSERVER_TIMEOUT';
          try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
          throw err;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    })().catch((err) => {
      starting = null;
      throw err;
    });
    return starting;
  }

  /**
   * 反向代理一跳：把 (method, path, headers, body) 流式透传给观察台。
   * 不缓冲：观察台回的 HTML/JSON/PNG 都原样过。
   */
  function proxyTo(obsPort, req, res, target) {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length']; // node 会按实际 body 重算
    const upstream = httpRequest(
      { host: '127.0.0.1', port: obsPort, path: target, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      warn('proxy:', err?.message ?? err);
      if (!res.headersSent) writeJson(res, 502, { error: 'observer unavailable' });
      else res.end();
    });
    req.pipe(upstream);
  }

  /** UI 前缀路由：剥前缀 → 懒启动 → 代理。 */
  const uiRoute = {
    kind: 'prefix',
    path: UI_PREFIX,
    handler: async (req, res) => {
      if (!isAllowed(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' });
        return;
      }
      let obsPort;
      try {
        obsPort = await ensureObserver();
      } catch (err) {
        writeJson(res, 503, { error: 'observer failed to start', detail: err?.message ?? String(err) });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://x');
      // 无尾斜杠（…/ui）先 301 到 …/ui/：观察台页面内全是文档相对路径，
      // 少这条斜杠会把 api/summary 解析到父路径上去。
      if (url.pathname === UI_PREFIX) {
        res.writeHead(301, { location: `${UI_PREFIX}/${url.search}` });
        res.end();
        return;
      }
      let sub = url.pathname.slice(UI_PREFIX.length);
      if (sub === '') sub = '/';
      if (sub.length > MAX_SUB_PATH) {
        writeJson(res, 414, { error: 'path too long' });
        return;
      }
      proxyTo(obsPort, req, res, `${sub}${url.search}`);
    },
  };

  /** health 精确路由：只读探测，不触发启动（客户端据此决定显示什么）。 */
  const healthRoute = {
    kind: 'exact',
    path: HEALTH_PATH,
    handler: async (req, res) => {
      if (!isAllowed(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' });
        return;
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }
      const externalAlive = mode === 'external' && externalPort > 0 && await probeOk(externalPort);
      const embeddedAlive = mode === 'embedded' && child !== null && child.exitCode === null && !child.killed;
      let summary = null;
      const livePort = externalAlive ? externalPort : embeddedAlive ? port : 0;
      if (livePort && await probeOk(livePort)) {
        try {
          const r = await fetch(`http://127.0.0.1:${livePort}/api/summary`);
          if (r.ok) summary = await r.json();
        } catch { summary = null; }
      }
      writeJson(res, 200, {
        ok: true,
        running: externalAlive || embeddedAlive,
        mode: externalAlive ? 'external' : embeddedAlive ? 'embedded' : null,
        configuredExternal: externalPort > 0,
        memoHome,
        port: livePort || null,
        summary,
      });
    },
  };

  // 每步注入（D2，默认关闭）：实现在 lib/pre-step.js（含宿主接缝的实证记录与测试）。
  // 开关两处任一即可：cordis 配置 inject.enabled=true，或环境变量 SEDIMEM_INJECT=on。
  const injectEnabled = config?.inject?.enabled === true
    || String(process.env.SEDIMEM_INJECT ?? '').toLowerCase() === 'on';
  if (injectEnabled) {
    const state = registerPreStep(ctx, {
      config: { inject: { ...config?.inject, enabled: true, scope: config?.inject?.scope ?? config?.scope } },
      memoHome,
      log: (msg) => log(msg),
    });
    if (!state.registered) warn(`per-step injection not registered (${state.mode ?? 'no-hook'})`);
  }

  ctx.effect(() => {
    const disposers = [ctx.webServer.register(uiRoute), ctx.webServer.register(healthRoute)];
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* 已注销 */ }
      }
      if (child) {
        const dying = child;
        try { dying.kill('SIGTERM'); } catch { /* 已退出 */ }
        const killer = setTimeout(() => {
          try { dying.kill('SIGKILL'); } catch { /* 已退出 */ }
        }, 2000);
        killer.unref?.();
        child = null;
        port = 0;
      }
    };
  }, `${PKG_ID}: routes + observer child`);
}
