// api/read-only.js — 只读查询端口实现（契约：docs/02 §3.9 裁决 30、§3.10 裁决 36–38）
// 从 MemoryService 里搬出来，避免 src/api/service.js 单文件越过质量门禁 Q2 的 900 行上限；
// 两个函数都只读：不写 events.jsonl、不改内存记录（裁决 30「只读」不变）。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { SUSPICIOUS_MASK as MASK } from './mask.js';

/**
 * 只读事件查询。读 $MEMO_HOME/events.jsonl（每行 {ts,op,scope,id,detail}），
 * 按 scope 过滤，[since, until) 半开（ts 为 UTC ISO8601，字典序 == 时间序），
 * ops 白名单，按 ts 倒序，坏行跳过但计入 scanned，命中超 limit 截断 truncated=true。
 * @param {import('./service.js').MemoryService} service
 * @param {{since?:string, until?:string, ops?:string[], limit?:number}} args
 */
export async function queryEvents(service, { since, until, ops, limit = 200 } = {}) {
  service._ensureOpen();
  const eventsPath = path.join(service.memoHome, 'events.jsonl');
  let raw = '';
  try {
    raw = await fsp.readFile(eventsPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { events: [], scanned: 0, truncated: false };
    throw e;
  }
  const opSet = Array.isArray(ops) && ops.length > 0 ? new Set(ops.filter((o) => typeof o === 'string')) : null;
  const hits = [];
  let scanned = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    scanned++;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // 坏行跳过但已计入 scanned
    }
    if (!ev || typeof ev !== 'object' || typeof ev.ts !== 'string') continue;
    if (ev.scope !== service.scope) continue;
    if (since !== undefined && !(ev.ts >= since)) continue;
    if (until !== undefined && !(ev.ts < until)) continue;
    if (opSet && !opSet.has(ev.op)) continue;
    hits.push(ev);
  }
  hits.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const truncated = hits.length > limit;
  return { events: truncated ? hits.slice(0, limit) : hits, scanned, truncated };
}

/**
 * 只读记录导出（从内存 _records 派生，不触盘）。
 * status='all' 不过滤；时间窗 [since, until) 按 createdAt；suspicious 记录 text/value/subject/
 * predicate 与 source.quote 一律遮蔽为 '[suspicious withheld]'（裁决 16、裁决 42）除非
 * includeSuspicious:true——只遮 text/value 会被「把 payload 挪进 subject」绕过。
 * total=过滤后总数，limited=是否被截断（禁止静默截断）。
 * @param {import('./service.js').MemoryService} service
 * @param {{since?:string, until?:string, status?:string, kind?:string, limit?:number, includeSuspicious?:boolean}} args
 */
export async function queryExportRecords(service, {
  since, until, status = 'active', kind, limit = 2000, includeSuspicious = false,
} = {}) {
  service._ensureOpen();
  let filtered = [...service._records.values()];
  if (status !== 'all') filtered = filtered.filter((r) => r.status === status);
  if (kind !== undefined) filtered = filtered.filter((r) => r.kind === kind);
  if (since !== undefined) filtered = filtered.filter((r) => String(r.createdAt) >= since);
  if (until !== undefined) filtered = filtered.filter((r) => String(r.createdAt) < until);
  // 裁决 44：导出顺序稳定（createdAt 升序，同刻按 id）——否则 limit 截断后 /api/records 的 q
  // 过滤会「在随机子集里搜」，结果既不可复现也不完整（审核 A3/B8）。
  filtered.sort((a, b) => (String(a.createdAt).localeCompare(String(b.createdAt))
    || String(a.id).localeCompare(String(b.id))));
  const total = filtered.length;
  const limited = total > limit;
  const records = (limited ? filtered.slice(0, limit) : filtered).map((r) => {
    const suspicious = Array.isArray(r.tags) && r.tags.includes('suspicious');
    const mask = suspicious && !includeSuspicious;
    return {
      id: r.id,
      subject: mask ? MASK : r.subject,
      predicate: mask ? MASK : r.predicate,
      value: mask ? MASK : r.value,
      text: mask ? MASK : r.text,
      kind: r.kind,
      status: r.status,
      validFrom: r.validFrom,
      validTo: r.validTo,
      createdAt: r.createdAt,
      hits: r.hits ?? 0,
      tags: r.tags,
      // 来源对象保留 agent（用于区分谁写的），但 quote 可能夹带正文 → 遮蔽
      source: mask && r.source
        ? { ...r.source, quote: r.source.quote === undefined ? undefined : MASK }
        : r.source,
    };
  });
  return { records, total, limited };
}
