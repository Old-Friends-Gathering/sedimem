// storage/lock.js — 跨进程写锁（契约：mkdir('.lock') 原子排他创建，陈旧锁 staleMs=30000 强制接管，
// 总等待超 timeoutMs=15000 抛 err.code='E_LOCK_TIMEOUT'，finally 必删锁目录）
//
// 为什么是目录而不是文件：`mkdir` 的 EEXIST 是内核级原子排他，没有「先检查后创建」窗口；
// 而「在临时目录里以可预测文件名创建文件」会被 CodeQL 判为 insecure-temporary-file（符号链接攻击面）。
// 锁只需要「唯一性 + 持有时间」，目录的 mtime 就够，不需要 pid 文件。

import path from 'node:path';
import fsp from 'node:fs/promises';

const POLL_MS = 25;

/**
 * @param {string} memoHome
 * @param {() => Promise<any>} fn 持锁期间执行的异步函数
 * @param {{staleMs?: number, timeoutMs?: number}} opts
 */
export async function withLock(memoHome, fn, { staleMs = 30000, timeoutMs = 15000 } = {}) {
  if (!memoHome || typeof memoHome !== 'string') {
    const err = new Error(`withLock: memoHome required, got ${JSON.stringify(memoHome)}`);
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  await fsp.mkdir(memoHome, { recursive: true });
  const lockPath = path.join(memoHome, '.lock');
  const start = Date.now();

  for (;;) {
    try {
      await fsp.mkdir(lockPath); // 原子排他：已存在则 EEXIST
      break; // 拿到锁
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 已存在：判断是否陈旧
      let st = null;
      try { st = await fsp.stat(lockPath); } catch { st = null; /* 刚被释放，重试 */ }
      if (st && Date.now() - st.mtimeMs > staleMs) {
        // 陈旧锁：强制接管（先删目录再重新竞争，避免覆盖新持有者）
        try { await fsp.rm(lockPath, { recursive: true, force: true }); } catch { /* 忽略，下一轮重试 */ }
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

  try {
    return await fn();
  } finally {
    try { await fsp.rm(lockPath, { recursive: true, force: true }); } catch { /* 尽力删除 */ }
  }
}
