// web/auth.js — 回环 Host / Origin / token 的强校验（P0b B4，契约：docs/02 §3.24、docs/08 §7）
//
// 三个互相独立的问题，不要混在一起：
//   1) Host：请求到底发给了谁？只允许 127.0.0.0/8 / ::1 / localhost，且端口 = 实际监听端口
//      —— 防 DNS rebinding（evil.com 解析到 127.0.0.1 时 Host 会是 evil.com）。
//   2) Origin：写请求是不是本页面发起的？**缺失 Origin 一律拒绝**（浏览器同源写一定会带；
//      命令行/脚本没有 Origin 时必须显式带 Bearer + Origin，见 docs/08 §7）。
//   3) token：调用方是不是本机这个用户？浏览器走 HttpOnly cookie（JS 读不到），脚本走 Bearer。
//
// 错误码：E_BAD_HOST（403）/ E_BAD_ORIGIN（403）/ E_UNAUTHORIZED（401）。

/** 浏览器 cookie 名。页面 JS 不需要也不应该读到 token（HttpOnly）。 */
export const AUTH_COOKIE = 'memo_session';

/** 回环地址判定（127.0.0.0/8、::1、localhost）。'0.0.0.0'/'' 一律视为非回环。 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return Boolean(m) && m.slice(1).every((n) => Number(n) <= 255);
}

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** `Authorization: Bearer <token>` → token；形状不对 → null。 */
export function bearerTokenOf(req) {
  const raw = req?.headers?.authorization;
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/i.exec(raw.trim());
  return m ? m[1] : null;
}

/** `Cookie: memo_session=<token>` → token；没有/解码失败 → null。 */
export function cookieTokenOf(req) {
  const raw = req?.headers?.cookie;
  if (typeof raw !== 'string' || raw === '') return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== AUTH_COOKIE) continue;
    try {
      const token = decodeURIComponent(part.slice(eq + 1).trim());
      return token || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 请求出示的 token：Authorization 优先，其次 cookie（写请求即使 cookie 有效也能显式用 Bearer）。 */
export function presentedToken(req) {
  return bearerTokenOf(req) ?? cookieTokenOf(req);
}

/**
 * 下发浏览器的 cookie：HttpOnly（JS 读不到）+ SameSite=Strict（跨站请求不带）。
 * 不加 Secure：本地服务是 http://127.0.0.1，Secure 会让浏览器直接丢弃该 cookie。
 */
export function sessionCookie(token) {
  return `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * Host 强校验：缺失 / 非回环 / 端口不对 → E_BAD_HOST。
 * 端口必须等于实际监听端口：`Host: 127.0.0.1:7788` 打到一个随机端口上同样是 rebinding 前兆。
 */
export function assertHostAllowed(req, serverPort) {
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host.trim() === '') {
    throw coded('E_BAD_HOST', '缺少 Host 头');
  }
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    throw coded('E_BAD_HOST', `Host 头无法解析: ${host}`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw coded('E_BAD_HOST', `只允许回环 Host（127.0.0.1/localhost/::1），收到 ${parsed.hostname}`);
  }
  const port = Number(parsed.port === '' ? 80 : parsed.port);
  if (Number(serverPort) > 0 && port !== Number(serverPort)) {
    throw coded('E_BAD_HOST', `Host 端口 ${port} 与实际监听端口 ${serverPort} 不一致`);
  }
  return parsed;
}

/**
 * Origin 强校验（写请求专用）：Origin 必须存在、必须是回环、必须与 Host 同源。
 * 缺 Origin 的写请求一律拒绝 —— 这是与旧实现（缺省放行）唯一的语义变更，
 * 因为「缺 Origin」正是最简单的 CSRF/本地脚本伪装姿势。
 */
export function assertSameOriginStrict(req, serverPort) {
  const raw = req?.headers?.origin;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw coded('E_BAD_ORIGIN', '写请求必须带 Origin 头（缺失一律拒绝）');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw coded('E_BAD_ORIGIN', `Origin 头无法解析: ${raw}`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw coded('E_BAD_ORIGIN', `跨源写请求被拒绝：${parsed.origin}`);
  }
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host.trim() === '') {
    throw coded('E_BAD_HOST', '缺少 Host 头');
  }
  // 先过 Host 校验再比较 origin：Host 带非法端口时不应该被「同源」掩盖
  assertHostAllowed(req, serverPort);
  let expected;
  try {
    expected = new URL(`http://${host}`).origin;
  } catch {
    throw coded('E_BAD_ORIGIN', `Host 头无法解析: ${host}`);
  }
  if (parsed.origin !== expected) {
    throw coded('E_BAD_ORIGIN', `写请求必须同源：Origin ${parsed.origin} ≠ ${expected}`);
  }
  return parsed;
}
