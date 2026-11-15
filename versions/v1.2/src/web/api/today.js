// web/api/today.js — /api/today 端点：当日动作统计 + 时间线行构造（从 web/handlers.js 拆出）。

import { dayWindow, parseTzOffset, parseDateArg, todayInTz, recordIndex, decisionKey, makeLabel } from './shared.js';

/** 统计一天的动作数（裁决类按「一次裁决」计，而不是按写盘条数）。 */
function countActions(events) {
  const counts = { created: 0, superseded: 0, forgotten: 0, merged: 0, hit: 0 };
  const seenDecision = new Set();
  for (const ev of events) {
    const d = ev.detail ?? {};
    if (ev.op === 'write' && d.action === 'created') counts.created++;
    else if (ev.op === 'supersede') counts.superseded++;
    else if (ev.op === 'forget') counts.forgotten++;
    else if (ev.op === 'curate_apply') {
      if (d.side === 'loser') continue;
      const key = decisionKey(ev);
      if (seenDecision.has(key)) continue;
      seenDecision.add(key);
      counts.merged++;
    } else if (ev.op === 'hit') counts.hit++;
  }
  return counts;
}

/** 把事件投影成 timeline 行（label 服务端生成；裁决类事件只保留一行）。 */
export function toTimelineRows(events, index) {
  const rows = [];
  const seenDecision = new Set();
  for (const ev of events) {
    const d = ev.detail ?? {};
    // search 事件是「检索统计」不是「库的变化」（#43）：它没有记录 id、也没有分类含义，
    // 放进时间线只会多一行空 label。nightly 直接读事件流算指标，不受这里过滤影响。
    if (ev.op === 'search') continue;
    // 人工 supersede 会额外写一条 write(action='supersede')，以 op='supersede' 那行为准，避免重复
    if (ev.op === 'write' && d.action === 'supersede') continue;
    if (ev.op === 'curate_apply') {
      const side = d.side;
      if (side === 'loser') continue; // 只保留胜者行
      const key = decisionKey(ev);
      if (seenDecision.has(key)) continue;
      seenDecision.add(key);
    }
    const rec = ev.id ? index.get(ev.id) : null;
    // retitle/retitle_apply 是「改标题」动作：label 只给标题本身，再拼正文会把一行撑成两句
    const titleOnly = ev.op === 'retitle' || ev.op === 'retitle_apply';
    rows.push({
      ts: ev.ts,
      op: ev.op,
      id: ev.id ?? null,
      label: rec ? makeLabel(rec, { withValue: !titleOnly }) : String(ev.op),
      action: d.action ?? d.decision ?? null,
      reason: d.reason ?? null,
    });
  }
  return rows;
}

export async function apiToday(service, query) {
  const tzOffset = parseTzOffset(query);
  const date = parseDateArg(query, { fallback: todayInTz(tzOffset) });
  const { fromIso, toIso } = dayWindow(date, tzOffset);
  const { events } = await service.events({ since: fromIso, until: toIso, limit: 100000 });
  const index = await recordIndex(service);
  return { date, counts: countActions(events), timeline: toTimelineRows(events, index) };
}
