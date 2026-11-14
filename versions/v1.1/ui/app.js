/**
 * app.js —— sedimem 记忆观察台（只读）的壳：
 * hash 路由（#/today 默认）+ 各页委托：today/hygiene 拆到各自 view 模块（W9，
 * Q9 单文件 ≤600 行），图谱/编辑/导入/设置/任务/交接维持懒加载委托。
 * 安全约定：所有接口数据一律 textContent 写入，禁止 innerHTML 拼数据，无 eval。
 */
import { API, api, apiPost, currentScope, hrefFor } from './api.js';
import { applyHostVars } from './palette.js';
import { loadLazyView } from './lazy.js';
import { el } from './dom.js';
import { renderSearchResults } from './search-view.js';
import { resolveScope } from './scope.js';

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

/* ---------------- 今日 / 卫生页（W9 委托各自 view 模块） ---------------- */

async function loadToday() {
  const mod = await import('./today-view.js').catch(() => null);
  if (!mod || typeof mod.renderToday !== 'function') {
    document.getElementById('today').replaceChildren(el('div', 'err', '今日页模块 today-view.js 未加载，刷新重试。'));
    return;
  }
  await mod.renderToday();
}

async function loadHygiene() {
  const mod = await import('./hygiene-view.js').catch(() => null);
  if (!mod || typeof mod.renderHygiene !== 'function') {
    document.getElementById('hygiene').replaceChildren(el('div', 'err', '卫生页模块 hygiene-view.js 未加载，刷新重试。'));
    return;
  }
  await mod.renderHygiene();
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

/* ---------------- 搜索页（B3 / D8；W9 换 .page-head + .search-box 结构） ---------------- */

let searchBuilt = false;

/** 搜索页骨架：.page-head（h2 + .sub）+ .search-box（输入），一次性替换旧标记。 */
function buildSearchShell() {
  if (searchBuilt) return;
  searchBuilt = true;
  const section = document.getElementById('search');
  section.replaceChildren();
  const head = el('div', 'page-head');
  head.append(
    el('h2', '', '搜索记忆'),
    el('p', 'sub', '词法检索（语义道启用时自动融合）；结果按相关度排序，跟随顶栏分库。'),
  );
  const box = el('div', 'search-box');
  const input = el('input');
  input.type = 'search';
  input.id = 'search-input';
  input.placeholder = '输入关键词，回车搜索';
  input.setAttribute('aria-label', '搜索记忆');
  box.append(input);
  const results = el('div');
  results.id = 'search-results';
  section.append(head, box, results);
  // 输入框回车 → 写 hash（保留当前 scope），hashchange 触发重查；切分库同理重查。
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const v = ev.target.value.trim();
    if (!v) return;
    location.hash = hrefFor('search', { q: v });
  });
}

/** 当前路由 query 里的 ?q= 值（搜索词）；无则空串。 */
function currentQuery() {
  const m = /(?:^|[?&])q=([^&]*)/.exec(location.hash.split('?')[1] ?? '');
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
}

/** 渲染搜索页：读 hash 里的 q，fetch api/search（scope 由 api() 统一拼接），结果整段写入。 */
async function loadSearch() {
  buildSearchShell();
  const input = document.getElementById('search-input');
  const box = document.getElementById('search-results');
  const q = currentQuery();
  if (input && input.value !== q) input.value = q;
  if (!q) {
    box.replaceChildren(el('div', 'empty', '输入关键词后回车开始搜索。'));
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

/* W8：任务 / 交接页统一懒加载（只读，无需记忆挂载状态） */
/* ---------------- 路由 ---------------- */

const ROUTES = ['today', 'graph', 'search', 'hygiene', 'edit', 'import', 'settings', 'session', 'handoff'];
const CRUMBS = {
  today: '今日', graph: '图谱', search: '搜索', hygiene: '卫生',
  edit: '编辑', import: '导入', settings: '设置', session: '任务', handoff: '交接',
};

function currentRoute() {
  // 只取 path 部分：`#/graph?scope=repo:x` 的路由是 graph，不是 "graph?scope=repo:x"
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.includes(h) ? h : 'today';
}

async function render() {
  const route = currentRoute();
  for (const r of ROUTES) {
    document.getElementById(r).classList.toggle('active', r === route);
    const tab = document.getElementById(`tab-${r}`);
    tab.toggleAttribute('aria-selected', r === route);
    tab.classList.toggle('active', r === route);
  }
  const crumb = document.getElementById('crumb');
  if (crumb) crumb.textContent = CRUMBS[route] ?? route;
  if (route === 'today') await loadToday();
  else if (route === 'graph') await loadGraph();
  else if (route === 'search') await loadSearch();
  else if (route === 'edit') await loadEdit();
  else if (route === 'import') await loadImport();
  else if (route === 'settings') await loadLazyView('settings', { api, el });
  else if (route === 'session' || route === 'handoff') await loadLazyView(route, { api, el });
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
    // 任务库显示任务标题（session:<id> 对人没有意义）；其余分库仍是 scope 名
    const name = s.title ? `${s.title} · ${s.records}` : `${s.scope}（${s.records}）`;
    const opt = el('option', null, name);
    opt.value = s.scope;
    if (s.scope === active) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    // W4：切分库只重载当前页（保留路由），scope 进 hash + localStorage 双写实现粘性
    writeStoredScope(sel.value);
    location.hash = hrefFor(currentRoute(), { scope: sel.value });
  });
  box.append(sel);
}

/* ---------------- 启动 ---------------- */
applyHostVars();

/* ---------------- 启动（续） ---------------- */

buildSearchShell();
watchGraphDetail();
loadScopes(); loadSummary();
if (!location.hash) location.hash = hrefFor('today');
render();
