/**
 * app.js —— strata 记忆观察台（只读）的壳：
 * hash 路由（#/today 默认、#/graph、#/hygiene）+ 取数渲染今日/卫生两页；
 * 图谱页只放容器并动态委托给 graph.js（不存在时显示占位）。
 * 安全约定：所有接口数据一律 textContent 写入，禁止 innerHTML 拼数据，无 eval。
 */
import { renderLineChart, fmtPct as pctFmt } from './charts.js';

const API = '/api';
/** 东八区为 +480；-new Date().getTimezoneOffset() 把浏览器时区换成「东为正」分钟数。 */
const TZ_OFFSET = -new Date().getTimezoneOffset();

/* ---------------- 小工具 ---------------- */

/** 取接口数据；ok:false 或网络错误统一抛 Error(code+message)。 */
/** 当前观察的分库（?scope=repo:xxx）；空串表示用服务端启动时解析出的那个。 */
function currentScope() {
  const m = /(?:^|[?&])scope=([^&]+)/.exec(location.hash.split('?')[1] ?? '');
  return m ? decodeURIComponent(m[1]) : '';
}

async function api(path) {
  const sc = currentScope();
  const sep = path.includes('?') ? '&' : '?';
  const withScope = sc ? `${API + path}${sep}scope=${encodeURIComponent(sc)}` : API + path;
  let res;
  try {
    res = await fetch(withScope);
  } catch {
    throw new Error('E_FETCH_FAILED: 无法连接本地服务，请确认 memo serve 正在运行。');
  }
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 错误体走下面统一处理 */ }
  if (!res.ok || !body || body.ok === false) {
    const code = body?.code ?? `E_HTTP_${res.status}`;
    throw new Error(`${code}: ${body?.message ?? res.statusText}`);
  }
  return body;
}

/** 创建元素并批量填子节点/文本。 */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** YYYY-MM-DD（本地时区）。 */
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** date 字符串 ± n 天。 */
function shiftDate(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return localDateStr(dt);
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

/** 把错误显示进容器。 */
function showError(container, err) {
  const box = el('div', 'err', `加载失败 · ${err.message}`);
  container.replaceChildren(box);
}

/* ---------------- 顶栏 ---------------- */

async function loadSummary() {
  const set = (id, text) => {
    const chip = document.getElementById(id);
    chip.replaceChildren(document.createTextNode(text));
  };
  try {
    const s = await api('/summary');
    // 顶栏分库下拉由 loadScopes() 渲染（这里不再传字符串，否则会把下拉降级成静态 chip）
    set('chip-version', String(s.version ?? 'v?'));
  } catch (err) {
    set('chip-version', '服务不可用');
  }
}

/* ---------------- 今日页 ---------------- */

let todayDate = localDateStr();

async function loadToday() {
  const tbody = document.querySelector('#today-table tbody');
  const empty = document.getElementById('today-empty');
  const title = document.getElementById('today-title');
  document.getElementById('today-date').value = todayDate;
  title.textContent = `${todayDate} · 库里的变化`;

  let data;
  try {
    data = await api(`/today?date=${encodeURIComponent(todayDate)}&tzOffset=${TZ_OFFSET}`);
  } catch (err) {
    empty.hidden = true;
    showError(document.getElementById('today-table'), err);
    return;
  }
  document.getElementById('today-table').style.display = '';
  const c = data.counts ?? {};
  for (const k of ['created', 'superseded', 'forgotten', 'merged']) {
    document.getElementById(`n-${k}`).textContent = String(c[k] ?? 0);
  }

  const rows = Array.isArray(data.timeline) ? data.timeline : [];
  const changes = rows.filter((r) => r.op !== 'hit');
  const hits = rows.filter((r) => r.op === 'hit');
  tbody.replaceChildren();

  if (changes.length === 0 && hits.length === 0) {
    // 空状态：不留白页，顺带给出上次写入日期（取不到就省略）
    document.getElementById('today-table').style.display = 'none';
    empty.hidden = false;
    empty.replaceChildren(document.createTextNode('今天没有写入。'));
    try {
      const tl = await api(`/timeline?days=30&tzOffset=${TZ_OFFSET}`);
      const last = findLastWriteDate(tl.series);
      if (last) {
        const days = Math.max(0, Math.round((new Date(`${todayDate}T00:00:00`) - new Date(`${last}T00:00:00`)) / 86400000));
        empty.append(document.createTextNode(` 上次写入是 ${last}（${days} 天前）。`));
      }
    } catch { /* 上次写入推断失败就省略 */ }
    return;
  }

  empty.hidden = true;
  for (const r of changes) {
    const tr = el('tr');
    tr.append(el('td', 't', hhmm(r.ts) || '--:--'));
    const b = el('td', 'b');
    b.append(badge(r.op));
    tr.append(b);
    const td = el('td', '', r.label ?? r.id ?? '');
    if (r.reason) {
      const why = el('div', 'reason');
      why.textContent = humanReason(r.reason);
      td.append(why);
    }
    tr.append(td);
    tbody.append(tr);
  }

  // hit 折叠成一行，点开展开明细
  if (hits.length > 0) {
    const tr = el('tr', 'hitrow');
    tr.append(el('td', 't', '全天'));
    const b = el('td', 'b');
    b.append(badge('hit'));
    tr.append(b);
    const td = el('td');
    const toggle = el('button', 'dim', `今天这些记忆被读过 ${hits.length} 次（点开展开明细）`);
    toggle.style.cssText = 'background:none;border:none;cursor:pointer;font:inherit;padding:0';
    const list = el('div', 'hitlist');
    list.hidden = true;
    for (const h of hits) list.append(el('div', '', `${hhmm(h.ts)} · ${h.label ?? h.id ?? ''}`));
    toggle.addEventListener('click', () => { list.hidden = !list.hidden; });
    td.append(toggle, list);
    tr.append(td);
    tbody.append(tr);
  }
}

/** 从 timeline 序列里找最近一个有写入（created>0 等）的日期。 */
function findLastWriteDate(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i];
    if ((s.created ?? 0) + (s.superseded ?? 0) + (s.merged ?? 0) > 0) return s.date;
  }
  return null;
}

function bindTodayControls() {
  document.getElementById('today-date').addEventListener('change', (e) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { todayDate = e.target.value; loadToday(); }
  });
  document.getElementById('today-prev').addEventListener('click', () => { todayDate = shiftDate(todayDate, -1); loadToday(); });
  document.getElementById('today-next').addEventListener('click', () => { todayDate = shiftDate(todayDate, 1); loadToday(); });
}

/* ---------------- 卫生页 ---------------- */

async function loadHygiene() {
  const candBox = document.getElementById('hyg-candidates');
  const histBody = document.querySelector('#hyg-history tbody');
  const trendBox = document.getElementById('hyg-trend');
  const docBox = document.getElementById('hyg-doctor');

  let data;
  try {
    data = await api('/hygiene');
  } catch (err) {
    showError(candBox, err);
    histBody.replaceChildren();
    trendBox.replaceChildren();
    docBox.replaceChildren();
    return;
  }

  renderCandidates(candBox, data.candidates);
  renderHistory(histBody, data.merged, data.superseded);
  renderDoctor(docBox, data.doctor, data.suspicious);

  // 趋势：优先 /api/timeline（可带 days/tzOffset），失败则回退 /api/hygiene 自带的 series
  let series = Array.isArray(data.series) ? data.series : [];
  try {
    const tl = await api(`/timeline?days=30&tzOffset=${TZ_OFFSET}`);
    if (Array.isArray(tl.series) && tl.series.length > 0) series = tl.series;
  } catch { /* 回退 hygiene.series */ }
  renderLineChart(trendBox, {
    series,
    yFmt: pctFmt,
    lines: [
      { key: 'dupRatio', label: 'dupRatio（冗余率）', color: '#f97316', fmt: pct },
      { key: 'conflictRate', label: 'conflictRate（冲突率）', color: '#ef4444', fmt: pct },
      { key: 'activeRatio', label: 'active 占比（相对配额）', color: '#5b9cf5', dash: true, fmt: pct },
    ],
  });
}

const pct = (v) => `${(v * 100).toFixed(2)}%`;

/** 候选簇：成员 label + pairs 的 containment/dice/strength，只显示建议，不提供按钮。 */
function renderCandidates(box, clusters) {
  box.replaceChildren();
  const list = Array.isArray(clusters) ? clusters : [];
  if (list.length === 0) {
    box.append(el('p', 'dim', '当前没有待裁决的近重复候选。'));
    return;
  }
  list.forEach((cl, i) => {
    const card = el('div', 'cluster');
    const members = Array.isArray(cl.members) ? cl.members : [];
    const pairs = Array.isArray(cl.pairs) ? cl.pairs : [];
    card.append(el('h4', '', `簇 #${i + 1} · ${members.length} 条`));
    if (cl.slot) card.append(el('div', 'm', `slot: ${cl.slot}`));
    for (const m of members) {
      const label = typeof m === 'string' ? m : (m.label ?? m.id ?? '');
      card.append(el('div', 'member', `· ${label}`));
    }
    for (const p of pairs) {
      const row = el('div', 'pair');
      row.append(el('span', '', pairText(p)));
      const strong = p.strength === 'strong';
      row.append(el('span', strong ? 'strong' : 'weak', `c ${fmt3(p.containment ?? p.score)}`));
      row.append(el('span', strong ? 'strong' : 'weak', `d ${fmt3(p.dice)}`));
      row.append(el('span', strong ? 'strong' : 'weak', p.strength ?? ''));
      card.append(row);
    }
    card.append(el('div', 'curate-tip', '→ 复制给 Agent：请对以上簇用 memory_curate 裁决（本页只读，不提供按钮）。'));
    box.append(card);
  });
}

const fmt3 = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '–');

function pairText(p) {
  if (p.aLabel || p.bLabel) return `${p.aLabel ?? p.aId ?? ''} ↔ ${p.bLabel ?? p.bId ?? ''}`;
  if (p.aId || p.bId) return `${p.aId ?? ''} ↔ ${p.bId ?? ''}`;
  return '';
}

/** 清理史：合并（curate_apply）与失效（supersede），各取最近若干条。 */
function renderHistory(tbody, merged, superseded) {
  tbody.replaceChildren();
  const rows = [];
  for (const m of Array.isArray(merged) ? merged : [])
    rows.push({
      ts: m.ts,
      kind: 'merged',
      text: `合并：${m.loserLabel ?? short(m.loserId)} 并入 ${m.winnerLabel ?? short(m.winnerId)}`,
    });
  for (const s of Array.isArray(superseded) ? superseded : [])
    rows.push({
      ts: s.ts,
      kind: 'superseded',
      text: `失效：${s.loserLabel ?? short(s.loserId)} 被 ${s.winnerLabel ?? short(s.winnerId)} 取代`,
    });
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
    b.append(badge(r.kind === 'merged' ? 'merged' : 'superseded'));
    const textCell = el('td');
    textCell.append(el('div', 'hist', r.text));
    tr.append(b, textCell);
    tbody.append(tr);
  }
}

const short = (id) => (typeof id === 'string' && id.length > 10 ? `${id.slice(0, 8)}…` : String(id ?? ''));

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : localDateStr(d);
}

/** doctor issues 徽章 + suspicious 计数。形状防御式解析。 */
function renderDoctor(box, doctor, suspicious) {
  box.replaceChildren();
  const issues = Array.isArray(doctor?.issues) ? doctor.issues : [];
  if (issues.length === 0) {
    const row = el('div', 'doctor-row');
    const b = el('span', 'badge b-merged', 'ok');
    row.append(b, el('span', '', typeof doctor?.message === 'string' ? doctor.message : '未发现问题。'));
    box.append(row);
  } else {
    for (const it of issues) {
      const row = el('div', 'doctor-row');
      const sev = it.severity === 'error' ? 'b-superseded' : (it.severity === 'warn' ? 'b-forgotten' : 'b-created');
      const b = el('span', `badge ${sev}`, it.severity ?? 'info');
      row.append(b, el('span', '', `${it.type ?? it.code ?? ''}: ${it.message ?? it.detail ?? ''}`));
      box.append(row);
    }
  }
  const n = suspicious?.count;
  if (Number.isFinite(Number(n)) && Number(n) > 0) {
    box.append(el('div', 'doctor-count', `${n} 条记录被标记 suspicious（默认不在 UI 渲染原文）。`));
  }
}

/* ---------------- 图谱页（委托 graph.js） ---------------- */

let graphApi = null; // { destroy() }

let graphScope;

async function loadGraph() {
  const toolbar = document.getElementById('graph-toolbar');
  const canvas = document.getElementById('graph-canvas');
  const detail = document.getElementById('graph-detail');

  const mod = await import('./graph.js').catch(() => null);
  if (!mod || typeof mod.initGraph !== 'function') {
    toolbar.replaceChildren();
    detail.replaceChildren();
    const hint = el('p', 'graph-placeholder',
      '图谱模块 graph.js 未加载（可能尚未交付）。本页只读容器已就位，待 graph.js 就绪后刷新即可。');
    detail.append(hint);
    return;
  }
  // 同一路由下换分库要重建实例：图谱数据是按 scope 拉的，复用旧实例会一直显示老库
  const scope = currentScope();
  if (graphApi && graphScope === scope) return; // 已初始化且分库未变：canvas/toolbar/detail 由 graph.js 接管
  destroyGraph();
  graphScope = scope;
  graphApi = await mod.initGraph({ canvas, detailEl: detail, toolbarEl: toolbar, apiBase: API, scope });
}

function destroyGraph() {
  if (graphApi && typeof graphApi.destroy === 'function') graphApi.destroy();
  graphApi = null;
  graphScope = undefined;
}

/* ---------------- 路由 ---------------- */

const ROUTES = ['today', 'graph', 'hygiene'];

function currentRoute() {
  // 只取 path 部分：`#/graph?scope=repo:x` 的路由是 graph，不是 "graph?scope=repo:x"
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.includes(h) ? h : 'today';
}

async function render() {
  const route = currentRoute();
  for (const r of ROUTES) {
    document.getElementById(r).classList.toggle('on', r === route);
    document.getElementById(`tab-${r}`).toggleAttribute('aria-selected', r === route);
  }
  if (route === 'today') await loadToday();
  else if (route === 'graph') await loadGraph();
  else await loadHygiene();
}

window.addEventListener('hashchange', () => {
  const route = currentRoute();
  if (route !== 'graph') destroyGraph();
  loadScopes(); // 分库可能被切换：刷新下拉的选中项与计数
  render();
});
for (const r of ROUTES) {
  document.getElementById(`tab-${r}`).addEventListener('click', () => { location.hash = `#/${r}`; });
}

/* ---------------- 分库切换 ---------------- */

/** 拉分库列表并渲染顶栏下拉；切换后把 scope 写进 hash 并发起重渲染。 */
async function loadScopes() {
  let data;
  try {
    data = await api('/scopes');
  } catch {
    return; // 列表拿不到不影响主流程（下拉保持默认）
  }
  renderScopePicker(data.scopes);
}

function renderScopePicker(scopes) {
  const box = document.getElementById('scope-pick');
  if (!box) return;
  const list = Array.isArray(scopes) ? scopes : [];
  const active = currentScope() || (list.find((s) => s.current)?.scope ?? list[0]?.scope ?? '');
  box.textContent = '';
  const label = el('span', 'scope-label', '分库');
  box.append(label);
  if (list.length === 0) {
    box.append(el('span', 'chip', active || '…'));
    return;
  }
  const sel = el('select');
  sel.className = 'scope-select';
  sel.setAttribute('aria-label', '切换分库');
  for (const s of list) {
    const opt = el('option', null, `${s.scope}（${s.records}）`);
    opt.value = s.scope;
    if (s.scope === active) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    const route = currentRoute();
    location.hash = `#/${route}?scope=${encodeURIComponent(sel.value)}`;
  });
  box.append(sel);
}

/* ---------------- 启动 ---------------- */

bindTodayControls();
loadScopes();
loadSummary();
if (!location.hash) location.hash = '#/today';
render();
