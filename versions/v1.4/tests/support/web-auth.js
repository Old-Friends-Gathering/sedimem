// tests/support/web-auth.js — B4 测试用「已认证 fetch」垫片
//
// 为什么需要它：B4 之后所有 /api/* 都要求会话 token，浏览器走 HttpOnly cookie、
// 脚本走 `Authorization: Bearer <token>`；写请求还要求同源 Origin。
// 现有 15 个测试文件里有几十处 `fetch(...)` 只关心业务语义，不该逐处手写 header。
//
// 做法：测试里把 `createWebServer` 包一层登记 origin → token，
// `installAuthFetch()` 把全局 fetch 换成「对本进程登记过的 server 自动补
// Authorization（非 GET 再补同源 Origin）」。**负向测试用 rawFetch**（未经改造的原版），
// 这样才能真的构造出「没 token / 跨源」的请求。
//
// 注意：给非 GET 补 Origin 时，若调用方显式带了 referer（哪怕只带 referer）就不补——
// 正是为了保留 i47 那条「缺 Origin 一律拒绝」的负向用例。

import { createWebServer as createWebServerRaw } from '../../src/web/server.js';

/** 未被改造的 fetch：负向测试（401 / 403 / Host 伪造）必须用它。 */
export const rawFetch = globalThis.fetch.bind(globalThis);

/** origin → token。 */
const registry = new Map();

/** 登记一个测试 server，返回它本身（可在 createWebServer 包装层直接返回）。 */
export function trackTestServer(web) {
  if (web && typeof web.url === 'string' && typeof web.token === 'string') {
    registry.set(new URL(web.url).origin, web.token);
  }
  return web;
}

/** 包装版 createWebServer：保持返回值不变，额外登记 token。 */
export async function createAuthedWebServer(opts) {
  return trackTestServer(await createWebServerRaw(opts));
}

function headersOf(input, init) {
  const headers = new Headers(init?.headers);
  if (init?.headers === undefined && input instanceof Request) {
    for (const [k, v] of input.headers) headers.set(k, v);
  }
  return headers;
}

/** 把全局 fetch 换成自动带 token/origin 的版本（幂等）。 */
export function installAuthFetch() {
  const current = globalThis.fetch;
  if (typeof current === 'function' && current.__memoAuthFetch === true) return;
  const patched = (input, init = {}) => {
    const url = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.href : input?.url);
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return rawFetch(input, init);
    }
    const token = registry.get(origin);
    if (!token) return rawFetch(input, init);

    const headers = headersOf(input, init);
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && !headers.has('origin') && !headers.has('referer')) {
      headers.set('origin', origin);
    }
    return rawFetch(input, { ...init, headers });
  };
  Object.defineProperty(patched, '__memoAuthFetch', { value: true });
  globalThis.fetch = patched;
}
