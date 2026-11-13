/**
 * api.js —— 前后端通道（W7 拆出 app.js）：统一的 GET/POST 出口与「当前分库」解析。
 *
 * 为什么单独一个文件：Q9 要求单文件 ≤600 行（拆模块，不放宽阈值），
 * 而 app.js 里路由 + 各页渲染 + 工具函数已经贴顶。
 *
 * 约定：
 * - 全部路径用**文档相对**（`api/...`），根路径部署与 iframe 子路径代理都成立。
 * - GET 失败抛 Error（页面按错误态渲染）；POST 不抛，返回 {status, body}，让调用方区分 409/E_READONLY。
 */

import { hrefFor as buildHref } from './scope.js';

export const API = 'api'; // 文档相对：根路径部署与子路径代理（DSH 插件 iframe）都能解析

/** 东八区为 +480；-new Date().getTimezoneOffset() 把浏览器时区换成「东为正」分钟数。 */
export const TZ_OFFSET = -new Date().getTimezoneOffset();

/* ---------------- 小工具 ---------------- */

/** 当前观察的分库（?scope=repo:xxx）；空串表示用服务端启动时解析出的那个。 */
export function currentScope() {
  const m = /(?:^|[?&])scope=([^&]+)/.exec(location.hash.split('?')[1] ?? '');
  return m ? decodeURIComponent(m[1]) : '';
}

/** 统一出口：内部跳转必须带当前 scope（W4：裸 '#/'+route 会丢 ?scope=）。 */
export function hrefFor(route, extra = {}) {
  return buildHref(route, { scope: currentScope(), ...extra });
}

export async function api(path) {
  const sc = currentScope();
  const sep = path.includes('?') ? '&' : '?';
  const withScope = sc ? `${API + path}${sep}scope=${encodeURIComponent(sc)}` : API + path;
  let res;
  try {
    res = await fetch(withScope);
  } catch {
    throw new Error('E_FETCH_FAILED: 无法连接本地服务，请确认 memo serve 正在运行。');
  }
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 错误体走下面统一处理 */ }
  if (!res.ok || !body || body.ok === false) {
    const code = body?.code ?? `E_HTTP_${res.status}`;
    throw new Error(`${code}: ${body?.message ?? res.statusText}`);
  }
  return body;
}

/** POST 出口：不把 4xx 抛成异常，返回 {status, body} 让页面自己区分 409 / E_READONLY。 */
export async function apiPost(path, payload) {
  const sc = currentScope();
  const sep = path.includes('?') ? '&' : '?';
  const withScope = sc ? `${API + path}${sep}scope=${encodeURIComponent(sc)}` : API + path;
  let res;
  try {
    res = await fetch(withScope, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
  } catch {
    throw new Error('E_FETCH_FAILED: 无法连接本地服务，请确认 memo serve 正在运行。');
  }
  let body = null;
  try { body = await res.json(); } catch { /* 保持 null */ }
  return { status: res.status, body };
}

