// cli/derive.js — `memo derive` 子命令（v1.0 W3，裁决 84/86）
// 用途：把 derive-queue 里的待派生条目排空，生成 derived sidecar（只读投影，永不改真相层）。
// 设计要点：
//   - 默认只跑一批（--limit，缺省 5），避免一次烧太多预算；--drain 语义相同（保留兼容）。
//   - --rebuild 忽略队列，按当前 active 记录全量重建 sidecar（幂等）。
//   - 输出人类可读摘要或 --json 结构化；任何派生失败都只降级，不改变退出码语义（除非查询本身失败）。

import { deriveQueueStats } from '../llm/outbox.js';

/**
 * `memo derive` 实现。
 * @param {object} service MemoryService（已 open）
 * @param {{drain?: boolean, rebuild?: boolean, limit?: string|number, json?: boolean}} opts
 * @param {{out?: Function|import('node:stream').Writable}} io 输出通道
 * @returns {Promise<number>} 退出码
 */
export async function deriveCli(service, opts = {}, io = {}) {
  const out = typeof io.out === 'function' ? io.out : (line) => process.stdout.write(`${line}\n`);
  const asJson = opts.json === true;

  if (opts.rebuild === true) {
    const result = await service.rebuildDerived();
    if (asJson) out(JSON.stringify({ action: 'rebuild', ...result }, null, 2));
    else out(`已重建派生层：${result.written} 条（${result.scope}）`);
    return 0;
  }

  const limit = Number(opts.limit ?? 5);
  if (!Number.isFinite(limit) || limit <= 0) {
    out('derive: --limit 必须是正整数');
    return 2;
  }

  const before = await deriveQueueStats({ memoHome: service.memoHome, scope: service.scope });
  const drained = await service.drainDerive({ limit });
  const after = await deriveQueueStats({ memoHome: service.memoHome, scope: service.scope });

  if (asJson) {
    out(JSON.stringify({ action: 'drain', limit, ...drained, pendingBefore: before.pending, pendingAfter: after.pending }, null, 2));
    return 0;
  }
  out(
    `派生：领取 ${drained.claimed} · 成功 ${drained.ok} · 失败 ${drained.failed}`
    + ` · 跳过 ${drained.skipped}（剩余待派生 ${after.pending}，死信 ${after.dead}）`,
  );
  return 0;
}
