// storage/lock.js — 跨进程写锁（契约：fs.open(path,'wx')，陈旧锁 staleMs=30000 强制接管，
// 总等待超 timeoutMs=15000 抛 err.code='E_LOCK_TIMEOUT'，finally 必删锁文件）

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
  let handle = null;

  for (;;) {
    try {
      handle = await fsp.open(lockPath, 'wx');
      break; // 拿到锁
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 已存在：判断是否陈旧
      let st = null;
      try { st = await fsp.stat(lockPath); } catch { st = null; /* 刚被释放，重试 */ }
      if (st && Date.now() - st.mtimeMs > staleMs) {
        // 陈旧锁：强制接管（先 unlink 再重新竞争，避免覆盖新持有者）
        try { await fsp.rm(lockPath, { force: true }); } catch { /* 忽略，下一轮重试 */ }
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
    await handle.writeFile(String(process.pid), 'utf8');
    await handle.close();
    handle = null;
    return await fn();
  } finally {
    if (handle) { try { await handle.close(); } catch { /* already closed */ } }
    try { await fsp.rm(lockPath, { force: true }); } catch { /* 尽力删除 */ }
  }
}
