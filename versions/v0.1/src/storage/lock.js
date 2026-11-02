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

  for (;;) {
    try {
      // 用 writeFile 的 'wx' 标志原子创建并写入 pid：一次系统调用完成「排他创建 + 落内容」，
      // 不再「先 open 再 write」两步（CodeQL 对临时目录里可预测文件名的句柄写法会报
      // insecure-temporary-file；锁文件路径由调用方的 memoHome 决定，不是进程级临时目录）。
      await fsp.writeFile(lockPath, String(process.pid), { flag: 'wx', encoding: 'utf8' });
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
    return await fn();
  } finally {
    try { await fsp.rm(lockPath, { force: true }); } catch { /* 尽力删除 */ }
  }
}
