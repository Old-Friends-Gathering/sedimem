// config/web-token.js — `memo serve` 的随机会话 token（P0b B4，契约：docs/02 §3.24、docs/08 §7）
//
// 为什么放 `~/.memo`：token 是「本机这个用户的 serve 进程」的凭据，不是仓库配置。
// 文件模式 0600 由本模块保证；Web 的 cookie / Bearer 与 `memo-mcp` 都读同一个文件，
// 这样「浏览器能读的对象」和「MCP 客户端要证明的身份」是同一把钥匙。
//
// 禁止固定常量：每次 serve 启动重新生成（32 字节 crypto 随机，base64url 43 字符）。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureMemoDir, MEMO_FILE_MODE } from './perms.js';

/** token 文件名（在 memoHome 下）。 */
export const WEB_TOKEN_FILE = 'web-token';
/** 合法 token 形状：base64url 字符集，长度 16–128（容忍用户用 `MEMO_MCP_TOKEN` 塞自定义串）。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** `<memoHome>/web-token`。 */
export function webTokenPath(memoHome) {
  return path.join(memoHome, WEB_TOKEN_FILE);
}

/** 生成新的会话 token（43 字符 base64url）。 */
export function generateWebToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * 恒定时间比较两个 token。长度不同 / 非字符串一律 false：
 * 先用长度比较会泄漏长度，但 token 长度是公开的（固定 43），这不构成秘密泄漏。
 */
export function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 读 token；文件不存在 → null；内容不像 token → E_CORRUPT_TOKEN（不静默当成「没有」）。 */
export async function readWebToken(memoHome) {
  let raw;
  try {
    raw = await fsp.readFile(webTokenPath(memoHome), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const token = raw.trim();
  if (!TOKEN_PATTERN.test(token)) {
    const err = new Error(`web token 文件内容不合法：${webTokenPath(memoHome)}`);
    err.code = 'E_CORRUPT_TOKEN';
    throw err;
  }
  return token;
}

/**
 * 生成并落盘新 token（0600）。先写 `<pid>.tmp` 再 rename：
 * 两个 serve 同时启动时最后一个 rename 胜出，读方永远读到完整内容而不是半截。
 */
export async function issueWebToken(memoHome) {
  const token = generateWebToken();
  await ensureMemoDir(memoHome);
  const target = webTokenPath(memoHome);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${token}\n`, { encoding: 'utf8', mode: MEMO_FILE_MODE });
  await fsp.rename(tmp, target);
  // rename 保留源 mode，这里再 chmod 一次是防「tmp 先被换成宽权限文件」的兜底
  await fsp.chmod(target, MEMO_FILE_MODE).catch(() => { /* Windows：chmod 不表达 ACL，跳过 */ });
  return token;
}
