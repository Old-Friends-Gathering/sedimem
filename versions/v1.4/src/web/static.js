// web/static.js — ui/ 静态资源服务（契约：docs/02 §3.9 裁决 34、docs/08 §7）
// 只从 versions/v0.3/ui/ 读取；路径穿越（..、绝对路径、软链接）一律 404；
// 禁止目录列表；ui 目录缺失时降级为 404 而不是崩溃（C/D 路并行开发期兼容）。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 创建静态文件处理器。
 * @param {string} uiDir ui/ 的绝对路径
 * @returns {(pathname: string) => Promise<{status: number, body?: Buffer|string,
 *            headers?: object}>}
 */
export function createStaticHandler(uiDir) {
  const root = path.resolve(uiDir);
  return async function serveStatic(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { status: 404, body: 'not found' };
    }
    if (decoded.includes('\0')) return { status: 404, body: 'not found' };
    const rel = decoded === '/' ? '/index.html' : decoded;
    // 任何 '..' 段、绝对路径、反斜杠 → 404（不留给 resolve 兜底）
    const segments = rel.split('/').filter((s) => s !== '');
    if (rel.includes('\\') || segments.includes('..') || rel !== '/' + segments.join('/')) {
      return { status: 404, body: 'not found' };
    }
    const abs = path.resolve(root, `.${rel}`);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { status: 404, body: 'not found' };
    }
    // 先用 O_NOFOLLOW 打开再 fstat：路径检查与读取是同一个句柄，
    // 避免 lstat 之后文件被换成软链接（TOCTOU，CodeQL 会报 file system race condition）
    let handle;
    let data;
    try {
      handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) return { status: 404, body: 'not found' }; // 目录/设备一律不服务
      data = await handle.readFile();
    } catch {
      return { status: 404, body: 'not found' }; // 含 ui 目录缺失、软链接（ELOOP）
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    return { status: 200, body: data, headers: { 'content-type': type } };
  };
}
