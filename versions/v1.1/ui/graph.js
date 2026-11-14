/**
 * graph.js —— 图谱页渲染与交互：vendor force-graph（window.ForceGraph）+ graph-ui.js 辅助。
 * 零构建不变：Node 单测无该全局 → 降级不抛错。UI 纯辅助与视觉常量都在 graph-ui.js。
 * v1.0 可用性改造交互契约：
 * - 工具栏 gx-zoom-in/out、gx-fit、gx-relayout、gx-scope、gx-legend（kind 显隐 gx-off）、
 *   gx-search（即时高亮，回车聚焦首命中）；键盘 + - 0 f r Esc（input 内不生效）。
 * - 搜索：命中画 accent 环，未命中 alpha 0.15；点击节点=聚焦模式（其余 alpha 0.12 不画标签），
 *   点空白/Esc 退出；双击节点=重新居中 zoom 1.2；悬停高亮 + tooltip。
 * - 拖拽=固定 fx/fy，右键或再次点击释放；标签按度数降序避让，zoom<0.22 只画 degree>=3；
 *   r 重排并释放固定；持久化 localStorage 键 sedimem.graph.ui（loadUiState/saveUiState）。
 */

import { renderToolbar } from './graph-toolbar.js';
import { uiPalette } from './palette.js';
import { edgeStyleFor, edgeStrokeColor, nodeFillColor } from './graph-style.js';
import { KIND_COLORS, kindColorsFromPolicy, DEFAULT_EDGE_TYPES, OPTIONAL_EDGE_TYPES, EDGE_PREF_KEY } from './graph-ui.js';
import {
  loadUiState, saveUiState, loadEdgePref, saveEdgePref, withAlpha, computeDegrees, neighborSet,
  matchNodes, planLabels, measureLabel, drawRing, drawNodeLabel, createTooltip, tooltipLines,
  createOrbit, renderDetail, attachKeyboard,
} from './graph-ui.js';

export async function initGraph({ container, detailEl, toolbarEl, apiBase = 'api', scope = '' }) {
  /* 降级路径：全局缺失（如 Node 单测）→ 提示一行文本，不抛错 */
  const ForceGraph = (typeof window !== 'undefined' ? window.ForceGraph : undefined);
  if (typeof ForceGraph !== 'function') {
    if (container) {
      const tip = document.createElement('div');
      tip.textContent = '图谱库未加载';
      container.replaceChildren(tip);
    }
    return { destroy() { if (container) container.replaceChildren(); } };
  }

  const ui0 = loadUiState();
  const state = {
    nodes: [], edges: [], sampled: { shown: 0, total: 0 },
    pref: loadEdgePref(EDGE_PREF_KEY),
    rotateMode: false, selectedId: null, center: null, angle: 0, zoom: 1,
    destroyed: false, rafId: 0,
    /* v1.0 图谱 UI 状态 */
    ui: { onlyThisScope: ui0.onlyThisScope, kindsOff: new Set(ui0.kindsOff), search: ui0.search },
    searchIds: null,      // Set<id> | null（null = 无搜索态）
    focusId: null,        // 聚焦模式中心节点 id
    hoverId: null,        // 悬停节点 id
    degrees: new Map(),   // id → 度数
    labelPlan: new Set(), // 本帧允许画标签的 id
    pinned: new Set(),    // 已固定（fx/fy）的节点 id
    mouse: { x: 0, y: 0 },
  };
  if (ui0.edgeTypes) { // 恢复持久化的边类型偏好
    state.pref.all = !!ui0.edgeTypes.all;
    state.pref['duplicate-of'] = !!(ui0.edgeTypes.all || ui0.edgeTypes['duplicate-of']);
    state.pref['disputed-with'] = !!(ui0.edgeTypes.all || ui0.edgeTypes['disputed-with']);
  }
  let fg = null;
  let kindColors = KIND_COLORS;
  let loadError = null;
  const nodeById = new Map();
  const tooltip = createTooltip(container);
  const refs = { searchInput: null };
  const orbit = createOrbit(() => fg, state);
  let detachKeys = () => {};

  /* ---------- 边偏好 ---------- */
  function persistEdgePref() { saveEdgePref(EDGE_PREF_KEY, state.pref); }
  function activeEdgeTypes() {
    const set = new Set(DEFAULT_EDGE_TYPES);
    if (state.pref['duplicate-of']) set.add('duplicate-of');
    if (state.pref['disputed-with']) set.add('disputed-with');
    return set;
  }

  /* ---------- 数据加载 ---------- */
  async function fetchData() {
    const q = new URLSearchParams({ limit: '300', days: '90' });
    if (scope && state.ui.onlyThisScope) q.set('scope', scope); // 「全部」时不带 scope
    const res = await fetch(`${apiBase}/graph?${q.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function loadKindColors() {
    try {
      const sr = await fetch(`${apiBase}/summary${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`);
      if (sr.ok) {
        const summary = await sr.json();
        if (summary?.policy?.kinds) kindColors = kindColorsFromPolicy(summary.policy);
      }
    } catch { /* summary 失败 → 继续用兜底色 */ }
  }

  /* ---------- 采样提示（DOM 覆盖层） ---------- */
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;top:10px;right:14px;padding:4px 10px;'
    + 'font:12px sans-serif;border-radius:6px;background:rgba(100,116,139,0.14);pointer-events:none;';
  function updateOverlay() {
    if (state.sampled.shown < state.sampled.total) {
      overlay.textContent = `已采样 ${state.sampled.shown} / ${state.sampled.total} 条`;
      overlay.style.display = 'block';
    } else overlay.style.display = 'none';
  }

  const showDetail = (nd) => renderDetail(detailEl, nd, { loadError, pinned: state.pinned.has(nd?.id) });

  /* ---------- 淡化规则：聚焦 > 悬停 > 搜索 ---------- */
  function nodeAlphaFor(nd) {
    const active = state.focusId || state.hoverId; // 聚焦优先于悬停
    if (active) {
      if (nd.id === active || neighborSet(active, state.edges).has(nd.id)) return 1;
      return 0.12;
    }
    if (state.searchIds && !state.searchIds.has(nd.id)) return 0.15;
    return 1;
  }

  /* ---------- force-graph 实例与绘制 ---------- */
  function nodeColor(nd) {
    const base = nodeFillColor(kindColors[nd.kind] || KIND_COLORS.state, uiPalette());
    const sup = nd.status === 'superseded' ? (uiPalette().light ? 0.6 : 0.45) : 1;
    return withAlpha(base, Math.min(nodeAlphaFor(nd), sup));
  }
  function linkColor(e) {
    const s = nodeById.get(e.source); const t = nodeById.get(e.target);
    const a = Math.min(s ? nodeAlphaFor(s) : 1, t ? nodeAlphaFor(t) : 1);
    const c = edgeStrokeColor(e.type, uiPalette());
    return a < 1 ? (withAlpha(c, a) || c) : c;
  }
  function applyVisibility() {
    if (!fg) return;
    const types = activeEdgeTypes();
    const kindsOff = state.ui.kindsOff;
    fg.nodeVisibility((nd) => !kindsOff.has(nd.kind));
    fg.linkVisibility((e) => { // 边类型勾选 + 两端 kind 任一隐藏即隐藏
      if (!types.has(e.type)) return false;
      const s = nodeById.get(e.source); const t = nodeById.get(e.target);
      return (!s || !kindsOff.has(s.kind)) && (!t || !kindsOff.has(t.kind));
    });
    repaint();
  }
  /** 重设 accessor 触发 force-graph 整帧重绘（状态变化后调用）。 */
  function repaint() {
    if (!fg) return;
    fg.nodeColor(nodeColor);
    fg.linkColor(linkColor);
    fg.linkWidth((e) => edgeStyleFor(e.type).width);
  }
  function fitToGraph() {
    if (!fg || !state.nodes.length) return;
    fg.zoomToFit(400, 46);
    let sx = 0; let sy = 0;
    for (const nd of state.nodes) { sx += nd.x || 0; sy += nd.y || 0; }
    state.center = { x: sx / state.nodes.length, y: sy / state.nodes.length };
  }
  function applyData(data) {
    state.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    state.edges = Array.isArray(data.edges) ? data.edges : [];
    state.sampled = data.sampled || { shown: state.nodes.length, total: state.nodes.length };
    nodeById.clear();
    for (const nd of state.nodes) nodeById.set(nd.id, nd);
    state.degrees = computeDegrees(state.nodes, state.edges);
    state.searchIds = matchNodes(state.nodes, state.ui.search); // 按新数据重算命中
    state.focusId = state.focusId && nodeById.has(state.focusId) ? state.focusId : null;
    state.pinned = new Set([...state.pinned].filter((id) => nodeById.has(id)));
    updateOverlay();
    if (!fg) return;
    fg.graphData({ nodes: state.nodes, links: state.edges });
    applyVisibility();
    setTimeout(() => fitToGraph(), 400); // 引擎可能瞬间停，双保险再 fit
    setTimeout(() => fitToGraph(), 2000);
  }

  function buildGraph() {
    const pal = uiPalette();
    fg = ForceGraph()(container)
      .backgroundColor(pal.bg)
      .width(container.clientWidth || 600)
      .height(container.clientHeight || 600)
      .nodeId('id')
      .nodeLabel(() => '') // tooltip 由 DOM 覆盖层接管，禁用默认 title
      .nodeVal((nd) => Math.max(1, nd.count ?? 1))
      .nodeColor(nodeColor)
      .nodeRelSize(4)
      .linkSource('from')
      .linkTarget('to')
      .nodeCanvasObjectMode(() => 'after')
      .onRenderFramePre((ctx, scale) => { // 每帧规划标签避让；低 zoom 只留高度数节点
        const cand = scale < 0.22
          ? state.nodes.filter((nd) => (state.degrees.get(nd.id) || 0) >= 3)
          : state.nodes;
        state.labelPlan = planLabels(cand, state.degrees, (nd) => measureLabel(nd, ctx, scale));
      })
      .nodeCanvasObject((nd, ctx, scale) => {
        if (nodeAlphaFor(nd) < 1) return; // 淡化节点不画标签
        if (state.searchIds?.has(nd.id)) drawRing(nd, ctx, scale);
        if (state.labelPlan.has(nd.id)) drawNodeLabel(nd, ctx, scale, uiPalette());
      })
      .onNodeClick(onNodeClick)
      .onNodeRightClick((nd) => { releasePin(nd); repaint(); }) // 右键释放固定
      .onNodeHover((nd) => {
        state.hoverId = nd ? nd.id : null;
        if (nd) tooltip.show(tooltipLines(nd), state.mouse.x, state.mouse.y);
        else tooltip.hide();
        repaint();
      })
      .onBackgroundClick(() => { // 点空白退出聚焦模式
        if (state.focusId) { state.focusId = null; repaint(); }
        tooltip.hide();
      })
      .onNodeDragEnd((nd) => { // 拖拽 = 固定
        if (!nd) return;
        nd.fx = nd.x; nd.fy = nd.y;
        state.pinned.add(nd.id);
        showDetail(nd);
      })
      .onZoom((t) => { state.zoom = t.k; })
      .onEngineStop(() => { fitToGraph(); })
      .warmupTicks(20)
      .cooldownTicks(220)
      .cooldownTime(4000);
    // 布局手感经验值（d3Force 返回力实例，不能串链）
    const charge = fg.d3Force('charge');
    if (charge && typeof charge.strength === 'function') charge.strength(-90);
    const link = fg.d3Force('link');
    if (link && typeof link.distance === 'function') link.distance(70);
    applyVisibility();
  }

  /* ---------- 交互 ---------- */
  let lastClick = { id: null, t: 0 };
  function onNodeClick(nd) {
    state.selectedId = nd.id;
    showDetail(nd);
    const now = Date.now();
    if (state.pinned.has(nd.id)) { releasePin(nd); repaint(); lastClick = { id: null, t: 0 }; return; } // 再次点击释放固定
    if (lastClick.id === nd.id && now - lastClick.t < 350) { centerOn(nd, 1.2); lastClick = { id: null, t: 0 }; return; } // 双击居中
    lastClick = { id: nd.id, t: now };
    state.focusId = nd.id; // 单击 = 聚焦模式
    repaint();
  }
  function releasePin(nd) {
    if (!nd) return;
    nd.fx = undefined; nd.fy = undefined;
    state.pinned.delete(nd.id);
    if (fg && typeof fg.d3ReheatSimulation === 'function') fg.d3ReheatSimulation();
    showDetail(nd);
  }
  function centerOn(nd, k) {
    if (!fg || !nd) return;
    fg.centerAt(nd.x || 0, nd.y || 0, 600);
    fg.zoom(k, 600);
    state.center = { x: nd.x || 0, y: nd.y || 0 };
  }
  function relayout() { // 重新布局：释放全部固定并重热模拟
    for (const nd of state.nodes) { nd.fx = undefined; nd.fy = undefined; }
    state.pinned.clear();
    if (fg && typeof fg.d3ReheatSimulation === 'function') fg.d3ReheatSimulation();
    showDetail(null);
  }
  function toggleKind(kind) {
    const off = state.ui.kindsOff;
    if (off.has(kind)) off.delete(kind); else off.add(kind);
    saveUiState({ kindsOff: [...off] });
    applyVisibility();
    buildToolbar();
  }
  function applySearch(v) {
    state.ui.search = v;
    state.searchIds = matchNodes(state.nodes, v);
    repaint();
    saveUiState({ search: v });
  }
  function toggleScope() {
    state.ui.onlyThisScope = !state.ui.onlyThisScope;
    saveUiState({ onlyThisScope: state.ui.onlyThisScope });
    buildToolbar();
    reload();
  }
  const zoomBy = (k) => fg && fg.zoom(state.zoom * k, 300);
  function clearModes() { // Esc：清空聚焦与搜索
    state.focusId = null;
    state.hoverId = null;
    state.ui.search = '';
    state.searchIds = null;
    if (refs.searchInput) refs.searchInput.value = '';
    saveUiState({ search: '' });
    tooltip.hide();
    repaint();
  }

  /* rAF 驱动环绕漂移（createOrbit 只做步进；后台标签页节流只是转得慢） */
  function tick() {
    if (state.destroyed) return;
    state.rafId = requestAnimationFrame(tick);
    orbit.step();
  }
  const onResize = () => {
    if (!fg) return;
    fg.width(container.clientWidth || 600).height(container.clientHeight || 600);
  };
  const onMouseMove = (ev) => {
    const rect = container.getBoundingClientRect();
    state.mouse = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };
  window.addEventListener('resize', onResize);
  container.addEventListener('mousemove', onMouseMove);
  detachKeys = attachKeyboard({
    zoomIn: () => zoomBy(1.3),
    zoomOut: () => zoomBy(1 / 1.3),
    fit: () => fitToGraph(),
    focusSelected: () => { // f：聚焦当前选中节点
      const nd = nodeById.get(state.selectedId);
      if (!nd) return;
      state.focusId = nd.id;
      centerOn(nd, 1.2);
      showDetail(nd);
      repaint();
    },
    relayout, clear: clearModes,
  });

  /* ---------- 装配 ---------- */
  function buildToolbar() {
    renderToolbar({
      toolbarEl, state, pref: state.pref, optionalEdgeTypes: OPTIONAL_EDGE_TYPES,
      checks: {}, refs, saveEdgePref: persistEdgePref, render: applyVisibility,
      kindColors, kindsOff: state.ui.kindsOff, onKindToggle: toggleKind,
      onlyThisScope: state.ui.onlyThisScope, search: state.ui.search,
      onSearch: applySearch,
      onSearchEnter: () => { // 回车：聚焦第一个命中（居中 zoom 1.2）
        const first = state.searchIds && state.searchIds.values().next();
        const nd = first && !first.done ? nodeById.get(first.value) : null;
        if (nd) { state.selectedId = nd.id; centerOn(nd, 1.2); showDetail(nd); }
      },
      actions: {
        zoomIn: () => zoomBy(1.3),
        zoomOut: () => zoomBy(1 / 1.3),
        fit: () => fitToGraph(),
        relayout,
        toggleScope,
      },
    });
  }

  container.style.position = 'relative';
  buildGraph();
  window.__sedimemGraphState = state;
  try {
    const data = await fetchData();
    await loadKindColors();
    applyData(data);
    fitToGraph();
  } catch (err) {
    loadError = err;
    showDetail(null);
  }
  buildToolbar(); // 数据/颜色就绪后再建工具栏（图例需要 policy.kinds 颜色）
  showDetail(null);
  state.rafId = requestAnimationFrame(tick);

  async function reload() {
    try {
      const data = await fetchData();
      loadError = null;
      await loadKindColors();
      applyData(data);
      fitToGraph();
    } catch (err) {
      loadError = err;
      showDetail(null);
    }
  }

  return {
    destroy() {
      state.destroyed = true;
      cancelAnimationFrame(state.rafId);
      detachKeys();
      window.removeEventListener('resize', onResize);
      container.removeEventListener('mousemove', onMouseMove);
      tooltip.hide();
      if (fg && typeof fg._destructor === 'function') fg._destructor();
      fg = null;
      container.replaceChildren();
      if (detailEl) detailEl.textContent = '';
      if (toolbarEl) toolbarEl.replaceChildren();
    },
    reload,
    focus(id) {
      const nd = nodeById.get(id);
      if (!nd) return;
      state.focusId = id;
      centerOn(nd, 1.2);
      repaint();
    },
    /** 新增接口：setSearch(text) 程序化设置搜索；relayout() 重新布局并释放固定。 */
    setSearch(text) { applySearch(String(text ?? '')); if (refs.searchInput) refs.searchInput.value = state.ui.search; },
    relayout,
  };
}
