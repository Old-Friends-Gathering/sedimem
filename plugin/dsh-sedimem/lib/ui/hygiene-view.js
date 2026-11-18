/**
 * hygiene-view.js —— 卫生页（W9 重构：从 app.js 拆出，Q9 单文件 ≤600 行）。
 * 结构：.page-head → 待裁决 .cluster 卡片 / 体检摘要 .doctor-row / 清理史表 / 趋势 .chart-wrap。
 * 安全约定：只用 createElement/textContent（el()），不碰 innerHTML。
 */
import { renderLineChart, fmtPct as pctFmt } from './charts.js';
import { TZ_OFFSET, api } from './api.js';
import { el, localDateStr } from './dom.js';

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const fmt3 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '–');
const short = (id) => (typeof id === 'string' && id.length > 10 ? `${id.slice(0, 8)}…` : String(id ?? ''));

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : localDateStr(d);
}

/* ---------------- 页面骨架（一次性挂载，替换 index.html 旧标记） ---------------- */

let mounted = false;
let refs = null; // { cand, doc, histBody, trend }

function card(title, sub) {
  const cardEl = el('div', 'card');
  const h = el('div', 'card-h');
  h.append(el('h3', '', title));
  if (sub) h.append(el('span', 'dim', sub));
  cardEl.append(h);
  return cardEl;
}

function buildShell(section) {
  section.replaceChildren();
  const head = el('div', 'page-head');
  head.append(
    el('h2', '', '库的卫生状况'),
    el('p', 'sub', '待裁决簇给 Agent 裁决参考；体检摘要逐项给结论；趋势看 30 天。'),
  );

  const split = el('div', 'split two');
  const candCard = card('待裁决候选', '词法只报候选，不判决');
  const cand = el('div', 'card-b tight');
  candCard.append(cand);
  const docCard = card('体检摘要（doctor）');
  const doc = el('div', 'card-b');
  docCard.append(doc);
  split.append(candCard, docCard);

  const histCard = card('清理史（最近 30 天）', '合并与取代');
  const table = el('table');
  const thead = el('thead');
  const htr = el('tr');
  for (const t of ['日期', '类型', '记录']) htr.append(el('th', '', t));
  thead.append(htr);
  const histBody = el('tbody');
  table.append(thead, histBody);
  const histB = el('div', 'card-b tight');
  histB.append(table);
  histCard.append(histB);

  const trendCard = card('趋势（30 天）', '冗余 / 冲突 / active / 检索健康');
  const trend = el('div', 'chart-wrap');
  const trendB = el('div', 'card-b');
  trendB.append(trend);
  trendCard.append(trendB);

  section.append(head, split, histCard, trendCard);
  refs = { cand, doc, histBody, trend };
}

/* ---------------- 待裁决簇 ---------------- */

function pairText(p) {
  if (p.aLabel || p.bLabel) return `${p.aLabel ?? p.aId ?? ''} ↔ ${p.bLabel ?? p.bId ?? ''}`;
  if (p.aId || p.bId) return `${p.aId ?? ''} ↔ ${p.bId ?? ''}`;
  return '';
}

/** 候选簇：.cluster（.hd 簇号/条数/分数/strength · .member 逐条 · .pair · .curate-tip）。只读。 */
function renderCandidates(box, clusters) {
  const list = Array.isArray(clusters) ? clusters : [];
  if (list.length === 0) {
    box.append(el('div', 'empty', '当前没有待裁决的近重复候选。'));
    return;
  }
  list.forEach((cl, i) => {
    const c = el('div', 'cluster');
    // 标题条数优先 size——items 可能被服务端按 limit 裁过，count 会骗人。
    const members = Array.isArray(cl.members) ? cl.members : (Array.isArray(cl.items) ? cl.items : []);
    const pairs = Array.isArray(cl.pairs) ? cl.pairs : [];
    const total = Number.isFinite(Number(cl.size)) ? Number(cl.size) : members.length;
    const hd = el('div', 'hd');
    hd.append(el('span', 'h4', `簇 #${i + 1} · ${total} 条`));
    if (cl.slot) hd.append(el('span', 'badge', `slot ${cl.slot}`));
    const strong = pairs.some((p) => p.strength === 'strong');
    hd.append(el('span', `badge ${strong ? 'b-warn' : ''}`, strong ? 'strong' : 'weak'));
    const scores = pairs
      .map((p) => `c ${fmt3(p.containment ?? p.score)} / d ${fmt3(p.dice)}`)
      .filter((s) => !s.includes('–'));
    if (scores.length > 0) hd.append(el('span', 'dim', scores.slice(0, 3).join(' · ')));
    c.append(hd);
    for (const m of members) {
      const raw = typeof m === 'string' ? m : (m.label ?? m.text ?? m.id ?? '');
      const label = raw.length > 72 ? `${raw.slice(0, 72)}…` : raw;
      c.append(el('div', 'member', `· ${label}`));
    }
    for (const p of pairs) {
      const row = el('div', 'pair');
      row.append(document.createTextNode(
        `${pairText(p)} · c ${fmt3(p.containment ?? p.score)} / d ${fmt3(p.dice)} · ${p.strength ?? ''}`,
      ));
      c.append(row);
    }
    c.append(el('div', 'curate-tip', '→ 复制给 Agent：请对以上簇用 memory_curate 裁决（本页只读，不提供按钮）。'));
    box.append(c);
  });
}

/* ---------------- 清理史 / 体检 ---------------- */

/** 清理史：合并（curate_apply）与失效（supersede），各取最近若干条。 */
function renderHistory(tbody, merged, superseded) {
  const rows = [];
  for (const m of Array.isArray(merged) ? merged : [])
    rows.push({ ts: m.ts, kind: 'merged', text: `合并：${m.loserLabel ?? short(m.loserId)} 并入 ${m.winnerLabel ?? short(m.winnerId)}` });
  for (const s of Array.isArray(superseded) ? superseded : [])
    rows.push({ ts: s.ts, kind: 'superseded', text: `失效：${s.loserLabel ?? short(s.loserId)} 被 ${s.winnerLabel ?? short(s.winnerId)} 取代` });
  rows.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  if (rows.length === 0) {
    const tr = el('tr');
    const td = el('td', 'dim', '最近 30 天没有合并或失效记录。');
    td.colSpan = 3;
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const r of rows.slice(0, 50)) {
    const tr = el('tr');
    tr.append(el('td', 't', fmtDay(r.ts)));
    const b = el('td', 'b');
    b.append(el('span', `badge ${r.kind === 'merged' ? 'b-info' : 'b-warn'}`, r.kind === 'merged' ? '合并' : '取代'));
    tr.append(b, el('td', '', r.text));
    tbody.append(tr);
  }
}

/** doctor issues：ok → .badge.b-ok，warn → .badge.b-warn，error → .badge.b-danger。 */
function renderDoctor(box, doctor, suspicious) {
  const issues = Array.isArray(doctor?.issues) ? doctor.issues : [];
  if (issues.length === 0) {
    const row = el('div', 'doctor-row');
    row.append(el('span', 'badge b-ok', 'ok'),
      el('span', '', typeof doctor?.message === 'string' ? doctor.message : '未发现问题。'));
    box.append(row);
  } else {
    for (const it of issues) {
      const row = el('div', 'doctor-row');
      const sev = it.severity === 'error' ? 'b-danger' : (it.severity === 'warn' ? 'b-warn' : 'b-ok');
      row.append(el('span', `badge ${sev}`, it.severity ?? 'info'),
        el('span', '', `${it.type ?? it.code ?? ''}: ${it.message ?? it.detail ?? ''}`));
      box.append(row);
    }
  }
  const n = suspicious?.count;
  if (Number.isFinite(Number(n)) && Number(n) > 0) {
    box.append(el('div', 'doctor-row faint', `${n} 条记录被标记 suspicious（默认不在 UI 渲染原文）。`));
  }
}

/* ---------------- 挂载 + 渲染（app.js 的 #/hygiene 路由委托到这里） ---------------- */

export async function renderHygiene() {
  const section = document.getElementById('hygiene');
  if (!mounted) { mounted = true; buildShell(section); }
  let data;
  try {
    data = await api('/hygiene');
  } catch (err) {
    refs.cand.replaceChildren(el('div', 'err', `加载失败 · ${err.message}`));
    refs.doc.replaceChildren();
    refs.histBody.replaceChildren();
    refs.trend.replaceChildren();
    return;
  }
  refs.cand.replaceChildren();
  renderCandidates(refs.cand, data.candidates);
  refs.histBody.replaceChildren();
  renderHistory(refs.histBody, data.merged, data.superseded);
  refs.doc.replaceChildren();
  renderDoctor(refs.doc, data.doctor, data.suspicious);

  // 趋势：优先 /api/timeline，失败则回退 /api/hygiene 自带的 series
  let series = Array.isArray(data.series) ? data.series : [];
  try {
    const tl = await api(`/timeline?days=30&tzOffset=${TZ_OFFSET}`);
    if (Array.isArray(tl.series) && tl.series.length > 0) series = tl.series;
  } catch { /* 回退 hygiene.series */ }
  renderLineChart(refs.trend, {
    series,
    yFmt: pctFmt,
    lines: [
      { key: 'dupRatio', label: 'dupRatio（冗余率）', color: '#f97316', fmt: pct },
      { key: 'conflictRate', label: 'conflictRate（冲突率）', color: '#ef4444', fmt: pct },
      { key: 'activeRatio', label: 'active 占比（相对配额）', color: '#5b9cf5', dash: true, fmt: pct },
      // 检索健康：null 的点由 charts.js 跳过不画，不会伪装成 0%
      { key: 'noHitRate', label: '检索空结果率', color: '#a78bfa', fmt: pct },
      { key: 'staleHitRate', label: '检索命中过期率', color: '#22d3ee', fmt: pct },
    ],
  });
}
