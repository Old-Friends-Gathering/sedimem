// web/api/hygiene.js — /api/hygiene 与 /api/conflicts 端点（从 web/handlers.js 拆出）。

import { listConflicts } from '../../views/conflicts.js';
import { decisionKey, recordIndex, makeLabel, readMetrics } from './shared.js';

async function apiHygiene(service) {
  const scan = await service.dedupeScan({ limit: 50 });
  const until = new Date().toISOString();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { events } = await service.events({ since, until, limit: 100000 });

  const merged = [];
  const superseded = [];
  const decisions = new Map(); // 裁决键 → {ts, loser, winner, decision}
  for (const ev of events) {
    if (ev.op === 'curate_apply') {
      const d = ev.detail ?? {};
      const key = decisionKey(ev);
      const slot = decisions.get(key) ?? { ts: ev.ts, loserId: null, winnerId: null, decision: d.decision ?? null };
      if (d.side === 'loser') slot.loserId = ev.id ?? null;
      else slot.winnerId = ev.id ?? null;
      // 兼容：旧事件没有 side 时按 ids 推断（ids[0] 胜者，b_wins 时 ids[1] 胜者）
      if (d.side === undefined && Array.isArray(d.ids)) {
        const winnerIdx = d.decision === 'b_wins' ? 1 : 0;
        slot.winnerId = d.ids[winnerIdx] ?? null;
        slot.loserId = ev.id ?? null;
      }
      if (!slot.decision) slot.decision = d.decision ?? null;
      decisions.set(key, slot);
    } else if (ev.op === 'supersede') {
      superseded.push({ ts: ev.ts, loserId: ev.id ?? null, winnerId: ev.detail?.by ?? null });
    }
  }

  const labels = await recordIndex(service);
  const labelOf = (id) => (id && labels.get(id) ? makeLabel(labels.get(id), { withValue: true }) : null);
  for (const slot of decisions.values()) {
    merged.push({
      ts: slot.ts,
      loserId: slot.loserId,
      winnerId: slot.winnerId,
      loserLabel: labelOf(slot.loserId),
      winnerLabel: labelOf(slot.winnerId),
      decision: slot.decision,
    });
  }
  for (const row of superseded) {
    row.loserLabel = labelOf(row.loserId);
    row.winnerLabel = labelOf(row.winnerId);
  }
  merged.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
  superseded.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));

  const all = await service.exportRecords({ status: 'all', limit: 1000000 });
  const suspiciousCount = all.records.filter(
    (r) => Array.isArray(r.tags) && r.tags.includes('suspicious'),
  ).length;

  // series：近 30 天 metrics 快照，按日期升序
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const m = await readMetrics(service.memoHome, service.scope, date);
    if (m) {
      const maxActive = Number(m.maxActive) > 0 ? Number(m.maxActive) : 5000;
      series.push({
        date,
        dupRatio: m.dupRatio ?? null,
        conflictRate: m.conflictRate ?? null,
        active: m.active ?? null,
        maxActive,
        activeRatio: Number.isFinite(Number(m.active)) ? Number(m.active) / maxActive : null,
        total: m.total ?? null,
        // 检索健康指标透传（issue #36，裁决 52）：metrics 文件里没有（旧快照）→ null，
        // UI 端 null 点跳过不画，绝不折算成 0。
        searchCount: m.searchCount ?? null,
        noHitRate: m.noHitRate ?? null,
        staleHitRate: m.staleHitRate ?? null,
        avgTopScore: m.avgTopScore ?? null,
      });
    }
  }

  const doctor = await service.doctor();
  return { candidates: scan.clusters, merged, superseded, suspicious: { count: suspiciousCount }, series, doctor };
}

/** /api/conflicts（v0.4 D4）：disputed 一等公民视图（按 slot 分组 + 候选对）。 */
async function apiConflicts(service, params) {
  const raw = params?.get?.('limit');
  if (raw === null || raw === undefined || raw === '') return listConflicts({ service });
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw Object.assign(new Error('conflicts: limit must be a positive integer'), { code: 'E_INVALID_ARG' });
  }
  return listConflicts({ service, limit });
}

export { apiHygiene, apiConflicts };
