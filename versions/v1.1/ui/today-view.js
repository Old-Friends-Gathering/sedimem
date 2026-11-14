/**
 * today-view.js —— 今日页（W9 重构：从 app.js 拆出，Q9 单文件 ≤600 行）。
 * 结构：.page-head（日期 + 前一天/后一天）→ .kpis 四张 .kpi → .tl 时间线。
 * 安全约定：只用 createElement/textContent（el()），不碰 innerHTML。
 */
import { TZ_OFFSET, api } from './api.js';
import { el, localDateStr } from './dom.js';

/** date 字符串 ± n 天。 */
function shiftDate(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateStr(new Date(y, m - 1, d + n));
}

/** UTC ISO 时间 → 本地 HH:MM。 */
function hhmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const OP_LABEL = {
  created: ['新增', 'b-created'],
  write: ['新增', 'b-created'],
  superseded: ['取代', 'b-superseded'],
  forgotten: ['删除', 'b-forgotten'],
  forget: ['删除', 'b-forgotten'],
  supersede: ['被取代', 'b-superseded'],
  curate_apply: ['裁决', 'b-merged'],
  merged: ['合并', 'b-merged'],
  retitle: ['改标题', 'b-merged'],
  retitle_apply: ['回填标题', 'b-merged'],
  merge: ['合并', 'b-merged'],
  hit: ['命中', 'b-hit'],
};

/** 把服务端 reason 代码映射成人话（展示层映射，不改数据）。 */
function humanReason(reason) {
  if (!reason) return '';
  const r = String(reason);
  if (/^no duplicate contentHash/.test(r)) return '新事实：无相同内容，也无同槽记录';
  if (r === 'near_duplicate') return '与已有记录近似重复，未重复写入';
  if (r === 'duplicate_content_hash') return '与已有记录内容完全相同，未重复写入';
  if (r === 'noop_same_value') return '同槽已有完全相同的事实';
  if (r === 'manual') return '人工显式取代';
  return r;
}

function badge(op) {
  const [label, cls] = OP_LABEL[op] ?? [op, 'b-forgotten'];
  return el('span', `badge ${cls}`, label);
}

/** id 前 8 位（短显示，mono 风格由 .meta 承担）。 */
const shortId = (id) => (typeof id === 'string' ? id.slice(0, 8) : String(id ?? ''));

/* ---------------- 页面骨架（一次性挂载，替换 index.html 旧标记） ---------------- */

let mounted = false;
let todayDate = localDateStr();
let refs = null; // { h2, dateInput, kpis:{}, tl, empty }

const KPI_DEFS = [
  ['created', '新增 created', 'accent'],
  ['superseded', '被取代 superseded', 'warn'],
  ['forgotten', '删除 tombstone', 'danger'],
  ['merged', '合并 merge', 'ok'],
];

function buildShell(section) {
  section.replaceChildren();
  const head = el('div', 'page-head');
  const h2 = el('h2', '', '今日变化');
  const sub = el('p', 'sub', '这一天库里发生了什么：写入、取代、删除与合并，命中折叠在末尾。');
  const right = el('div', 'right');
  const prev = el('button', 'sm', '‹ 前一天');
  const dateInput = el('input');
  dateInput.type = 'date';
  const next = el('button', 'sm', '后一天 ›');
  right.append(prev, dateInput, next);
  head.append(h2, sub, right);

  const kpis = el('div', 'kpis');
  const kpiMap = {};
  for (const [key, label, tone] of KPI_DEFS) {
    const k = el('div', `kpi ${tone}`);
    k.append(el('div', 'v', '–'), el('div', 'k', label));
    kpiMap[key] = k.firstChild;
    kpis.append(k);
  }

  const tl = el('div', 'tl card');
  const empty = el('div', 'empty');
  empty.hidden = true;

  section.append(head, kpis, tl, empty);
  prev.addEventListener('click', () => { todayDate = shiftDate(todayDate, -1); renderToday(); });
  next.addEventListener('click', () => { todayDate = shiftDate(todayDate, 1); renderToday(); });
  dateInput.addEventListener('change', (e) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { todayDate = e.target.value; renderToday(); }
  });
  refs = { h2, dateInput, kpiMap, tl, empty };
}

/* ---------------- 渲染 ---------------- */

/** 从 timeline 序列里找最近一个有写入的日期。 */
function findLastWriteDate(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i];
    if ((s.created ?? 0) + (s.superseded ?? 0) + (s.merged ?? 0) > 0) return s.date;
  }
  return null;
}

function tlRow(r) {
  const row = el('div', 'tl-row');
  row.append(el('span', 't', hhmm(r.ts) || '--:--'));
  const b = el('span');
  b.append(badge(r.op));
  row.append(b);
  const main = el('div');
  main.append(el('div', 'title', r.label ?? r.id ?? ''));
  if (r.reason) main.append(el('div', 'why', humanReason(r.reason)));
  row.append(main);
  const meta = el('div', 'meta');
  if (r.id) meta.append(el('span', 'mono', `id:${shortId(r.id)}`));
  row.append(meta);
  return row;
}

/** 挂载（首次）并拉取当日数据渲染。app.js 的 #/today 路由委托到这里。 */
export async function renderToday() {
  const section = document.getElementById('today');
  if (!mounted) { mounted = true; buildShell(section); }
  refs.h2.textContent = `${todayDate} 的变化`;
  refs.dateInput.value = todayDate;
  refs.empty.hidden = true;
  refs.tl.style.display = '';

  let data;
  try {
    data = await api(`/today?date=${encodeURIComponent(todayDate)}&tzOffset=${TZ_OFFSET}`);
  } catch (err) {
    refs.tl.replaceChildren(el('div', 'err', `加载失败 · ${err.message}`));
    return;
  }
  const c = data.counts ?? {};
  for (const [key] of KPI_DEFS) refs.kpiMap[key].textContent = String(c[key] ?? 0);

  const rows = Array.isArray(data.timeline) ? data.timeline : [];
  const changes = rows.filter((r) => r.op !== 'hit');
  const hits = rows.filter((r) => r.op === 'hit');

  if (changes.length === 0 && hits.length === 0) {
    refs.tl.style.display = 'none';
    refs.empty.hidden = false;
    refs.empty.replaceChildren(
      el('div', 'big', '今天没有写入。'),
      el('div', '', '这个分库在这一天是安静的。'),
    );
    try {
      const tl = await api(`/timeline?days=30&tzOffset=${TZ_OFFSET}`);
      const last = findLastWriteDate(tl.series);
      if (last) {
        const days = Math.max(0, Math.round((new Date(`${todayDate}T00:00:00`) - new Date(`${last}T00:00:00`)) / 86400000));
        refs.empty.append(el('div', '', `上次写入是 ${last}（${days} 天前）。`));
      }
    } catch { /* 上次写入推断失败就省略 */ }
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of changes) frag.append(tlRow(r));
  if (hits.length > 0) {
    const hitBox = el('div', 'tl-hit');
    const toggle = el('button', 'ghost sm', `这些记忆当天被读过 ${hits.length} 次（点开展开明细）`);
    const list = el('div', 'tl');
    list.hidden = true;
    for (const h of hits) {
      const row = el('div', 'tl-row');
      row.append(el('span', 't', hhmm(h.ts) || '--:--'));
      row.append(el('span'));
      const main = el('div');
      main.append(el('div', 'title', h.label ?? h.id ?? ''));
      row.append(main);
      list.append(row);
    }
    toggle.addEventListener('click', () => { list.hidden = !list.hidden; });
    hitBox.append(toggle, list);
    frag.append(hitBox);
  }
  refs.tl.replaceChildren(frag);
}
