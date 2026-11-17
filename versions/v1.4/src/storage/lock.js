// storage/lock.js — 跨进程写锁（契约：mkdir('.lock') 原子排他创建；5s 心跳刷新 mtime；
// 陈旧判据 = mtime 超过 staleMs **且** owner pid 已不存在；总等待超 timeoutMs 抛 E_LOCK_TIMEOUT）
//
// 为什么是目录而不是文件：`mkdir` 的 EEXIST 是内核级原子排他，没有「先检查后创建」窗口；
// 而「在临时目录里以可预测文件名创建文件」会被 CodeQL 判为 insecure-temporary-file（符号链接攻击面）。
//
// 为什么还要 owner.json + 心跳：只凭 mtime 会把「仍在跑但慢于 staleMs 的写」误判为陈旧，
// 接管后 rename 覆盖别人的追加（P0b 审计 B1）。pid 存活检查把「慢」与「死」分开；
// 心跳保证存活持有者的 mtime 不会被误判；接管用 rename 而不是 rm，避免删掉刚创建的新锁。

import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MEMO_DIR_MODE, MEMO_FILE_MODE } from '../config/perms.js';

const POLL_MS = 25;
const HEARTBEAT_MS = 5000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限发信号
  }
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} memoHome
 * @param {() => Promise<any>} fn 持锁期间执行的异步函数
 * @param {{staleMs?: number, timeoutMs?: number, heartbeatMs?: number}} opts
 */
export async function withLock(memoHome, fn, { staleMs = 30000, timeoutMs = 15000, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error(`withLock: memoHome required, got ${JSON.stringify(memoHome)}`);
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  await fsp.mkdir(memoHome, { recursive: true, mode: MEMO_DIR_MODE });
  const lockPath = path.join(memoHome, '.lock');
  const start = Date.now();
  const nonce = randomUUID();

  for (;;) {
    try {
      await fsp.mkdir(lockPath, { mode: MEMO_DIR_MODE }); // 原子排他：已存在则 EEXIST
      await fsp.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce, at: Date.now() }), { mode: MEMO_FILE_MODE });
      break; // 拿到锁
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let st = null;
      try { st = await fsp.stat(lockPath); } catch { st = null; /* 刚被释放，重试 */ }
      const owner = await readOwner(lockPath);
      const mtimeStale = st && Date.now() - st.mtimeMs > staleMs;
      const ownerDead = !owner || !pidAlive(owner.pid);
      if (mtimeStale && ownerDead) {
        // 先 rename 到本进程专属的墓碑，再删；这样不会误删另一个进程刚创建的新锁。
        const grave = `${lockPath}.stale-${process.pid}-${nonce.slice(0, 8)}`;
        try {
          await fsp.rename(lockPath, grave);
          await fsp.rm(grave, { recursive: true, force: true });
        } catch { /* 被别的进程先接管，下一轮重试 */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        const err = new Error(`withLock: timed out after ${Date.now() - start}ms waiting for ${lockPath}`);
        err.code = 'E_LOCK_TIMEOUT';
        throw err;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    fsp.utimes(lockPath, now, now).catch(() => { /* 锁已释放或已被接管 */ });
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try { await fsp.rm(lockPath, { recursive: true, force: true }); } catch { /* 尽力删除 */ }
  }
}
