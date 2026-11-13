// api/lifecycle.js — MemoryService 生命周期承接模块（车道 A，issue #32）
// 为什么单独成文件：service.js 只保留「类 + 构造 + 一行委托」，
// 实现（含读路径增量刷新）全部下沉到本模块，函数第一参数即 service（充当 this）。

import { validateRecord } from '../core/record.js';
// 错误工厂从 service.js 反向引用：三处工厂是唯一权威（错误文本被测试断言），
// ESM 函数声明在实例化期即初始化，循环 import 在运行期取值是安全的。
import { invalid } from './service.js';

/** 初始化：全量重载一次真相层（原 _init 方法体） */
export async function init(svc) {
  await reload(svc);
}

/**
 * 全量重载真相层并重建索引（原 _reload 方法体）。
 * 顺序不能反（I8 并发偶发红的根因）：先取 fileSize，再全量读。
 * 若先读后取 size，两步之间他进程追加的行会「读时没看到 + readOffset 已越过」→ 永久漏读，
 * 同一条事实随后被再判一次 created（active 出现 2 条）。反过来最多把已读过的行再增量读一次，
 * 由 refreshIncremental 的快照相等去重兜住。
 */
export async function reload(svc) {
  const sizeBefore = await svc.store.fileSize(svc.scope);
  let records;
  try {
    records = await svc.store.loadScope(svc.scope);
    svc._loadError = null;
  } catch (e) {
    // 任务 A（doctor 修复）：真相层损坏不在这里裸抛——记下错误、以空索引继续构造，
    // doctor() 用它产出 corrupt_jsonl issue；其余操作经 ensureOpen() fail-loud 原样抛出。
    if (e.code === 'E_CORRUPT_JSONL') {
      svc._loadError = e;
      records = [];
    } else {
      throw e;
    }
  }
  svc._records = new Map();
  svc._versions = new Map();
  for (const r of records) {
    svc._records.set(r.id, r);
    if (!svc._versions.has(r.id)) svc._versions.set(r.id, []);
    svc._versions.get(r.id).push(r);
  }
  svc.index.build(records);
  // 以「读之前」的 size 作为消费水位：宁可重复消费已读过的行，也不能跳过未读的行
  svc._readOffset = records.length === 0 && svc._loadError ? 0 : sizeBefore;
  return records;
}

/**
 * 读路径刷新（裁决 39）：常驻进程不写库，_records 会冻结；只读查询前调用，按水位增量重读。
 * 并发调用共享同一在途刷新（_refreshPromise），避免重复消费同一批行。
 * @returns {Promise<object[]>} 本次新增的记录快照
 */
export async function refreshView(svc) {
  svc._ensureOpen();
  if (!svc._refreshPromise) {
    svc._refreshPromise = (async () => {
      try {
        return await refreshIncremental(svc);
      } finally {
        svc._refreshPromise = null;
      }
    })();
  }
  return svc._refreshPromise;
}

/**
 * 增量重读真相层尾部并 fold 进内存索引/_records（裁决 13）。
 * 必须在 scope 锁临界区内调用（写路径由 write() 保证）。
 */
export async function refreshIncremental(svc) {
  const size = await svc.store.fileSize(svc.scope);
  if (size < svc._readOffset) {
    // 文件变短（异常/重建）：退化为全量重载，避免漏读
    return reload(svc);
  }
  if (size === svc._readOffset) return [];
  const { records, nextOffset } = await svc.store.loadScopeIncremental(svc.scope, svc._readOffset);
  svc._readOffset = nextOffset;
  for (const r of records) {
    const prev = svc._records.get(r.id);
    // 同一快照被重复消费（reload 的水位回退、半行补齐等）：不能重复计入版本链/索引，
    // 否则 hits、版本数与 dupRatio 类指标会被污染
    if (prev && prev.validTo === r.validTo && prev.status === r.status
        && prev.contentHash === r.contentHash && prev.hits === r.hits) {
      continue;
    }
    svc._records.set(r.id, r);
    if (!svc._versions.has(r.id)) svc._versions.set(r.id, []);
    svc._versions.get(r.id).push(r);
    svc.index.add(r);
  }
  return records;
}

/** 开门检查（原 _ensureOpen）：closed 即抛；真相层损坏除 doctor 外 fail-loud */
export function ensureOpen(svc) {
  if (svc._closed) {
    const err = new Error('MemoryService: already closed');
    err.code = 'E_INVALID_RECORD';
    throw err;
  }
  // 真相层损坏（任务 A）：doctor 之外的操作照旧 fail-loud（错误信息含 file:line）
  if (svc._loadError && !svc._inDoctor) throw svc._loadError;
}

/** 审计事件（原 _event）：锁临界区内走 Immediate 通道，避免重复拿锁 */
export async function event(svc, op, id, detail) {
  const ev = { ts: svc._nowIso(), op, scope: svc.scope, id, detail };
  if (svc._inScopeLock) await svc.store.appendEventImmediate(ev);
  else await svc.store.appendEvent(ev);
}

/** 校验并 append 一条记录快照，同时更新缓存与索引（原 _commit） */
export async function commit(svc, record, op = 'write', detail = {}) {
  const v = validateRecord(record);
  if (!v.ok) throw invalid(`commit: ${v.errors.join('; ')}`);
  if (svc._inScopeLock) await svc.store.appendImmediate(record);
  else await svc.store.append(record);
  svc._records.set(record.id, record);
  if (!svc._versions.has(record.id)) svc._versions.set(record.id, []);
  svc._versions.get(record.id).push(record);
  svc.index.add(record);
  await event(svc, op, record.id, detail);
  return record;
}

/** 裁决 21：close 不吞错——flushHits 失败原样上抛（hits 增量已在 flushHits 内恢复） */
export async function close(svc) {
  try {
    if (!svc._closed) {
      // 对抗审核 S-1：短命 CLI 进程退出时，索引里排队的向量任务会被丢掉
      // （hybrid 索引的 flush 是「等待在途任务」，不是 flush 到磁盘——向量是先落盘再入内存的）。
      if (typeof svc.index?.flush === 'function') await svc.index.flush();
      await svc.flushHits();
    }
  } finally {
    svc._closed = true;
  }
}
