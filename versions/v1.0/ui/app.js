/**
 * app.js —— sedimem 记忆观察台（只读）的壳：
 * hash 路由（#/today 默认、#/graph、#/hygiene）+ 取数渲染今日/卫生两页；
 * 图谱页只放容器并动态委托给 graph.js（不存在时显示占位）。
 * 安全约定：所有接口数据一律 textContent 写入，禁止 innerHTML 拼数据，无 eval。
 */
import { renderLineChart, fmtPct as pctFmt } from './charts.js';
import { API, TZ_OFFSET, api, apiPost, currentScope, hrefFor } from './api.js';
import { el, localDateStr } from './dom.js';
import { renderSearchResults } from './search-view.js';
import { resolveScope, hrefFor as buildHref } from './scope.js';





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
      // 检索健康（issue #36）：null 的点由 charts.js 跳过不画，不会伪装成 0%
      { key: 'noHitRate', label: '检索空结果率', color: '#a78bfa', fmt: pct },
      { key: 'staleHitRate', label: '检索命中过期率', color: '#22d3ee', fmt: pct },
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
    // dedupeScan 的簇用 items（契约 §3.3）；members 只是兼容旧形状。
    // 标题条数优先用 size —— items 可能被服务端按 limit 裁过，count 会骗人。
    const members = Array.isArray(cl.members) ? cl.members : (Array.isArray(cl.items) ? cl.items : []);
    const pairs = Array.isArray(cl.pairs) ? cl.pairs : [];
    const total = Number.isFinite(Number(cl.size)) ? Number(cl.size) : members.length;
    card.append(el('h4', '', `簇 #${i + 1} · ${total} 条`));
    if (cl.slot) card.append(el('div', 'm', `slot: ${cl.slot}`));
    for (const m of members) {
      const raw = typeof m === 'string' ? m : (m.label ?? m.text ?? m.id ?? '');
      const label = raw.length > 72 ? `${raw.slice(0, 72)}…` : raw;
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
  const container = document.getElementById('graph-canvas');
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
  graphApi = await mod.initGraph({ container, detailEl: detail, toolbarEl: toolbar, apiBase: API, scope });
}

function destroyGraph() {
  if (graphApi && typeof graphApi.destroy === 'function') graphApi.destroy();
  graphApi = null;
  graphScope = undefined;
}

/* ---------------- 搜索页（B3 / D8） ---------------- */

/** 当前路由 query 里的 ?q= 值（搜索词）；无则空串。 */
function currentQuery() {
  const m = /(?:^|[?&])q=([^&]*)/.exec(location.hash.split('?')[1] ?? '');
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
}

/** 渲染搜索页：读 hash 里的 q，fetch api/search（scope 由 api() 统一拼接），结果整段写入。 */
async function loadSearch() {
  const input = document.getElementById('search-input');
  const box = document.getElementById('search-results');
  const q = currentQuery();
  if (input && input.value !== q) input.value = q;
  if (!q) {
    box.replaceChildren(el('p', 'dim', '输入关键词后回车开始搜索。'));
    return;
  }
  box.replaceChildren(el('p', 'dim', '搜索中…'));
  let data;
  try {
    // 相对路径（无前导斜杠）；scope 拼接照 api() 现有实现；limit=30（D8 契约）
    data = await api(`/search?q=${encodeURIComponent(q)}&limit=30`);
  } catch (err) {
    showError(box, err);
    return;
  }
  // Q9 禁 innerHTML：用 DOMParser 把已 escapeHtml 的字符串解析成 DOM 再挂载。
  // 这样既保留 search-view.js 的「纯函数返回 HTML 字符串」（node 可测），
  // 又不把字符串直接赋给 innerHTML/insertAdjacentHTML。
  const html = renderSearchResults({
    query: q,
    items: Array.isArray(data?.items) ? data.items : [],
    degraded: !!data?.degraded,
  });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  box.replaceChildren(...Array.from(doc.body.childNodes));
}

/** 输入框回车 → 写 hash（保留当前 scope），hashchange 触发重查；切分库同理重查。 */
function bindSearchControls() {
  document.getElementById('search-input').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const v = ev.target.value.trim();
    if (!v) return;
    location.hash = hrefFor('search', { q: v });
  });
}

/**
 * 图谱节点详情浮层末尾追加「在搜索中查看」。
 * graph.js 不在 B3 写盘范围：借助其暴露的只读快照 window.__sedimemGraphState.selectedId
 * 拿到当前节点 id（D8：仅传 id 查询），用 MutationObserver 在详情刷新后补一行链接。
 */
function watchGraphDetail() {
  const detail = document.getElementById('graph-detail');
  if (!detail || typeof MutationObserver !== 'function') return;
  const mo = new MutationObserver(() => {
    const id = window.__sedimemGraphState?.selectedId;
    if (!id) return; // 未选中（占位文案）不加链接
    if (detail.lastElementChild?.classList?.contains('graph-search-link')) return; // 已加过（自身触发）
    const p = el('p', 'graph-search-link');
    const a = el('a', '', '在搜索中查看');
    a.href = hrefFor('search', { q: id });
    p.append(a);
    detail.append(p);
  });
  mo.observe(detail, { childList: true });
}

/* ---------------- 编辑 / 导入页（W7 / B1-B2：懒加载，参考图谱页委托模式） ---------------- */

let editMounted = null; // { scope } 记住挂载时分库，换库要重挂
let importMounted = null;

async function loadEdit() {
  const scope = currentScope();
  if (editMounted && editMounted.scope === scope) return;
  const mod = await import('./edit-view.js').catch(() => null);
  const box = document.getElementById('edit-container');
  if (!mod || typeof mod.mountEditView !== 'function') {
    box.replaceChildren(el('p', 'dim', '编辑模块 edit-view.js 未加载，刷新页面重试。'));
    return;
  }
  await mod.mountEditView({ container: box, apiGet: api, apiPost });
  editMounted = { scope };
}

async function loadImport() {
  const scope = currentScope();
  if (importMounted && importMounted.scope === scope) return;
  const mod = await import('./import-view.js').catch(() => null);
  const box = document.getElementById('import-container');
  if (!mod || typeof mod.mountImportView !== 'function') {
    box.replaceChildren(el('p', 'dim', '导入模块 import-view.js 未加载，刷新页面重试。'));
    return;
  }
  await mod.mountImportView({ container: box, apiGet: api, apiPost });
  importMounted = { scope };
}

/* W8：会话 / 交接页统一懒加载（只读，无需记忆挂载状态） */
async function loadLazyView(name) {
  const mod = await import(`./${name}-view.js`).catch(() => null);
  const box = document.getElementById(`${name}-container`);
  if (mod && typeof mod.mount === 'function') await mod.mount({ container: box, apiGet: api });
  else box.replaceChildren(el('p', 'dim', `${name}-view.js 未加载，刷新页面重试。`));
}

/* ---------------- 路由 ---------------- */

const ROUTES = ['today', 'graph', 'search', 'hygiene', 'edit', 'import', 'settings', 'session', 'handoff'];

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
  else if (route === 'search') await loadSearch();
  else if (route === 'edit') await loadEdit();
  else if (route === 'import') await loadImport();
  else if (route === 'settings') await loadLazyView('settings');
  else if (route === 'session' || route === 'handoff') await loadLazyView(route);
  else await loadHygiene();
}

window.addEventListener('hashchange', () => {
  const route = currentRoute();
  if (route !== 'graph') destroyGraph();
  loadScopes(); // 分库可能被切换：刷新下拉的选中项与计数
  render();
});
// W4：经 hrefFor 携带当前 scope（裸 '#/'+r 会丢 ?scope=，切页后分库漂回默认）
for (const r of ROUTES) document.getElementById(`tab-${r}`).addEventListener('click', () => { location.hash = hrefFor(r); });

/* ---------------- 分库切换 ---------------- */

// localStorage 键：记住上次观察的分库（回落只 warn 一次）
const SCOPE_STORAGE_KEY = 'sedimem.scope';
let storedScopeWarned = false, stickyDone = false; // 回落 warn 一次 + 首次粘性合成只跑一次
function readStoredScope() { try { return localStorage.getItem(SCOPE_STORAGE_KEY) ?? ''; } catch { return ''; } }
function writeStoredScope(scope) { try { localStorage.setItem(SCOPE_STORAGE_KEY, scope); } catch { /* 隐私模式写不进就算了 */ } }

/** 首次加载的粘性合成（W4）：hash + localStorage + /api/scopes 服务端默认 → resolveScope；
 *  结果与 hash 不一致时重写当前页 hash（保留 q=）；本地记忆非法/不存在 → 回落一次只 warn 一次。 */
function reconcileScope({ scopes }) {
  const list = Array.isArray(scopes) ? scopes : [];
  const available = list.map((s) => s.scope).filter(Boolean);
  const serverDefault = list.find((s) => s.current)?.scope ?? '';
  const stored = readStoredScope();
  const r = resolveScope({ hashScope: currentScope(), storedScope: stored, serverDefault, available });
  if (stored && r.source !== 'stored' && !storedScopeWarned) {
    console.warn(`sedimem: 本地记忆的分库 ${stored} 无效（${r.fallbackReason ?? 'unknown'}），已回落到 ${r.scope || '默认库'}`);
    storedScopeWarned = true;
  }
  writeStoredScope(r.scope);
  if (r.scope && r.scope !== currentScope()) {
    const q = currentQuery(); // 搜索页：重写 hash 不能把搜索词弄丢
    location.hash = hrefFor(currentRoute(), { ...(q ? { q } : {}), scope: r.scope });
  }
}

/** 拉分库列表并渲染顶栏下拉；首次加载先做粘性合成。 */
async function loadScopes() {
  let data;
  try {
    data = await api('/scopes');
  } catch {
    return; // 列表拿不到不影响主流程（下拉保持默认）
  }
  if (!stickyDone) { stickyDone = true; reconcileScope(data); }
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
    // W4：切分库只重载当前页（保留路由），scope 进 hash + localStorage 双写实现粘性
    writeStoredScope(sel.value);
    location.hash = hrefFor(currentRoute(), { scope: sel.value });
  });  box.append(sel);
}

/* ---------------- 启动 ---------------- */

bindTodayControls();
bindSearchControls();
watchGraphDetail();
loadScopes(); loadSummary();
if (!location.hash) location.hash = hrefFor('today');
render();
