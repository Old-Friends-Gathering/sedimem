// llm/lock.js — llm 层目录锁（预算与缓存共用）
//
// 为什么不复用 src/storage/lock.js：Q15 门禁要求 llm 层与存储实现解耦（不得依赖 storage/**），
// 且锁路径形状不同——storage 是 memoHome/.lock，llm 需要按文件命名，如 llm/budget.lock、llm/cache.lock。
// 语义与 storage/lock.js 对齐：mkdir 原子排他、陈旧锁 staleMs 强制接管、超时抛 E_LOCK_TIMEOUT。

import path from 'node:path';
import fsp from 'node:fs/promises';

const POLL_MS = 25;

/**
 * 在 dir 下以 name 命名的锁目录上执行 fn（排他）。
 * @param {string} dir 锁所在目录（不存在会先递归创建）
 * @param {string} name 锁名（如 'budget.lock'）
 * @param {() => Promise<any>} fn 持锁期间执行的异步函数
 * @param {{staleMs?: number, timeoutMs?: number}} opts
 */
export async function withPathLock(dir, name, fn, { staleMs = 30000, timeoutMs = 15000 } = {}) {
  if (!dir || typeof dir !== 'string' || !name || typeof name !== 'string') {
    const err = new Error(`withPathLock: dir/name required`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  await fsp.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, name);
  const start = Date.now();

  for (;;) {
    try {
      await fsp.mkdir(lockPath); // 原子排他：已存在则 EEXIST
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 陈旧锁：先删再重新竞争，避免覆盖新持有者
      let st = null;
      try { st = await fsp.stat(lockPath); } catch { st = null; }
      if (st && Date.now() - st.mtimeMs > staleMs) {
        try { await fsp.rm(lockPath, { recursive: true, force: true }); } catch { /* 下一轮重试 */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        const err = new Error(`withPathLock: timed out after ${Date.now() - start}ms waiting for ${lockPath}`);
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

/** tmp 写入 + rename 原子替换（同目录 rename 在同一文件系统上是原子的） */
export async function atomicWriteFile(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
}
