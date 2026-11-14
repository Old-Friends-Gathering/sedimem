// web/handlers.js — 只读 HTTP 端点路由与分发（契约：docs/08-web-ui.md §4.2 + docs/02 §3.9 裁决 30–34）
// 端点实现已拆分到 web/api/*（read / search / hygiene / today），本文件保留：
// ROUTES 注册表、handleApi 分发与错误映射（E_INVALID_ARG → 400、E_CORRUPT_JSONL → 500 带 file/line）、
// ENDPOINTS 导出、parseCorruptLocation，并 re-export 原公开接口（makeLabel / dayWindow / readMetrics）。

import { makeLabel, dayWindow, readMetrics } from './api/shared.js';
import { apiSummary, apiBrief, apiRecords, apiGraph, apiTimeline } from './api/read.js';
import { apiSearch } from './api/search.js';
import { apiHygiene, apiConflicts } from './api/hygiene.js';
import { apiToday } from './api/today.js';
import { handleWriteApi, readJsonBody } from './api/write.js';

/** 写端点（W7）：POST /api/write|supersede|forget，走 handleWriteApi 门禁（只读 403 / Origin 校验） */
const WRITE_PATHS = new Set(['/api/write', '/api/supersede', '/api/forget']);

/** POST 写请求的错误码 → HTTP 状态映射（区别于只读 GET 的映射） */
function writeErrorStatus(code) {
  if (code === 'E_READONLY' || code === 'E_BAD_ORIGIN') return 403;
  if (code === 'E_PAYLOAD_TOO_LARGE') return 413;
  if (code === 'E_CONFLICT') return 409;
  if (code === 'E_NOT_FOUND') return 404;
  if (code === 'E_INVALID_JSON' || code === 'E_INVALID_ARG') return 400;
  return 500;
}

// ---------------------------------------------------------------- 路由

const ROUTES = new Map([
  ['/api/summary', apiSummary],
  ['/api/brief', apiBrief],
  ['/api/today', apiToday],
  ['/api/records', apiRecords],
  ['/api/graph', apiGraph],
  ['/api/hygiene', apiHygiene],
  ['/api/timeline', apiTimeline],
  ['/api/search', apiSearch],
  ['/api/conflicts', apiConflicts],
]);

/** 从 E_CORRUPT_JSONL 的 message 解析 file/line（与 service._parseCorruptLocation 同格式）。 */
function parseCorruptLocation(message) {
  const m = String(message).match(/at (\S+?\.jsonl)(?::(\d+))?/);
  if (!m) return {};
  return { file: m[1], line: m[2] !== undefined ? Number(m[2]) : null };
}

/**
 * 处理一个 /api/* 请求（不含静态资源）。
 * W7：req 为 POST 且路径是写端点时走写通道（readJsonBody + 只读/Origin 门禁 + 审计），
 * opts 由 server.js 传入：{ write?: boolean, serverPort?: number, req?: http.IncomingMessage }。
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleApi(service, url, req, opts = {}) {
  if (req?.method === 'POST' && WRITE_PATHS.has(url.pathname)) {
    try {
      const body = await readJsonBody(req);
      return await handleWriteApi(service, url.pathname, body, { ...opts, req });
    } catch (err) {
      const code = err?.code ?? 'E_INTERNAL';
      return { status: writeErrorStatus(code), body: { ok: false, code, message: err?.message ?? String(err) } };
    }
  }
  const route = ROUTES.get(url.pathname);
  if (!route) {
    return { status: 404, body: { ok: false, code: 'E_NOT_FOUND', message: `unknown endpoint: ${url.pathname}` } };
  }
  try {
    const payload = await route(service, url.searchParams);
    return { status: 200, body: { ok: true, ...payload } };
  } catch (err) {
    const code = err?.code ?? 'E_INTERNAL';
    const message = err?.message ?? String(err);
    if (code === 'E_INVALID_ARG') return { status: 400, body: { ok: false, code, message } };
    if (code === 'E_CORRUPT_JSONL') {
      return { status: 500, body: { ok: false, code, message, ...parseCorruptLocation(message) } };
    }
    return { status: 500, body: { ok: false, code, message } };
  }
}

export const ENDPOINTS = [...ROUTES.keys()];

// 公开接口 re-export（原 handlers.js 曾导出 makeLabel / dayWindow / readMetrics）
export { makeLabel, dayWindow, readMetrics };
