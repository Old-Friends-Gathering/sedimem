/**
 * graph.js —— 图谱页渲染与交互（W6）：改用 vendor 的 force-graph（window.ForceGraph）。
 *
 * 零构建纪律不变：force-graph 由 index.html 以普通 <script> 引入（ui/vendor/VENDOR.md），
 * 本文件只在函数内部取 window.ForceGraph；Node 单测环境没有该全局 → 走降级路径（不抛错）。
 * 自研 3D 布局（layoutTick/球壳/投影）已不再被本文件调用，layout.js 里的纯函数与
 * KIND_COLORS / EDGE_PREF_KEY / edgeTypesFromPref 等常量继续复用并被单测覆盖。
 *
 * 交互契约（docs/08-web-ui.md §5.2）：
 * - 数据来自 `GET {apiBase}/graph?limit=300&days=90&scope=…` → { nodes, edges, sampled }。
 * - 节点：半径按聚合条数（node.count）、颜色按 kind（policy.kinds 或 KIND_COLORS）、
 *   superseded 半透明；标签用 node.label（后端已聚合 ×N）。
 * - 边默认 same-entity + supersedes；工具栏「全开」+ duplicate-of / disputed-with 勾选；
 *   偏好存 localStorage `sedimem.graph.edges`（对象形状 {all,"duplicate-of","disputed-with"}）。
 * - 交互：单击节点 → detailEl 渲染记录列表（textContent 防注入）；快速双击 → 聚焦；
 *   「旋转视角」= force-graph 下自动缓慢环绕（中心点小幅圆周漂移，可关）。
 * - sampled.shown < sampled.total 时右上角常驻「已采样 shown / total 条」（DOM 覆盖层）。
 * - 浅色/深色颜色全部取 uiPalette()；浅色连线经 contrastColor 压暗（v0.4.2 对比度规则）。
 * - window.ForceGraph 缺失 → container 内提示「图谱库未加载」，返回 {destroy(){}}。
 */

import { renderToolbar } from './graph-toolbar.js';
import { uiPalette } from './palette.js';
import { edgeStyleFor, edgeStrokeColor, nodeFillColor } from './graph-style.js';
import {
  KIND_COLORS, kindColorsFromPolicy, DEFAULT_EDGE_TYPES, OPTIONAL_EDGE_TYPES, EDGE_PREF_KEY,
} from './layout.js';

/** hex → 带透明度的颜色（superseded 半透明用）。非法输入原样返回。 */
function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
  if (!m) return color;
  const h = m[1];
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

export async function initGraph({ container, detailEl, toolbarEl, apiBase = 'api', scope = '' }) {
  /* ---------- 降级路径：全局缺失（如 Node 单测）→ 提示一行文本，不抛错 ---------- */
  const ForceGraph = (typeof window !== 'undefined' ? window.ForceGraph : undefined);
  if (typeof ForceGraph !== 'function') {
    if (container) {
      const tip = document.createElement('div');
      tip.textContent = '图谱库未加载';
      container.replaceChildren(tip);
    }
    return { destroy() { if (container) container.replaceChildren(); } };
  }

  const state = {
    nodes: [],
    edges: [],
    sampled: { shown: 0, total: 0 },
    pref: loadEdgePref(),
    rotateMode: false,
    selectedId: null,
    center: null,      // 环绕中心（世界坐标）
    angle: 0,          // 环绕相位
    zoom: 1,
    destroyed: false,
    rafId: 0,
  };
  let fg = null;
  let kindColors = KIND_COLORS;
  let loadError = null;
  const nodeById = new Map();

  /* ---------- 边偏好（对象形状 {all,"duplicate-of","disputed-with"}） ---------- */
  function loadEdgePref() {
    const fallback = { all: false, 'duplicate-of': false, 'disputed-with': false };
    try {
      const raw = localStorage.getItem(EDGE_PREF_KEY);
      if (!raw) return fallback;
      const p = JSON.parse(raw);
      return {
        all: !!p.all,
        'duplicate-of': !!(p.all || p['duplicate-of']),
        'disputed-with': !!(p.all || p['disputed-with']),
      };
    } catch {
      return fallback;
    }
  }
  function saveEdgePref() {
    try { localStorage.setItem(EDGE_PREF_KEY, JSON.stringify(state.pref)); } catch { /* 静默降级 */ }
  }
  function activeEdgeTypes() {
    const set = new Set(DEFAULT_EDGE_TYPES);
    if (state.pref['duplicate-of']) set.add('duplicate-of');
    if (state.pref['disputed-with']) set.add('disputed-with');
    return set;
  }

  /* ---------- 数据加载 ---------- */
  async function fetchData() {
    const q = new URLSearchParams({ limit: '300', days: '90' });
    if (scope) q.set('scope', scope); // 分库跟顶栏走（issue #25）
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

  /* ---------- 采样提示（DOM 覆盖层，force-graph 画不了文字叠加） ---------- */
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;top:10px;right:14px;padding:4px 10px;'
    + 'font:12px sans-serif;border-radius:6px;background:rgba(100,116,139,0.14);pointer-events:none;';
  function updateOverlay() {
    if (state.sampled.shown < state.sampled.total) {
      overlay.textContent = `已采样 ${state.sampled.shown} / ${state.sampled.total} 条`;
      overlay.style.display = 'block';
    } else {
      overlay.style.display = 'none';
    }
  }

  /* ---------- 详情（textContent 防注入） ---------- */
  function showDetail(nd) {
    if (!detailEl) return;
    if (!nd) {
      detailEl.textContent = loadError ? `加载失败：${loadError.message}` : '点击节点查看详情';
      return;
    }
    // 聚合节点：chain 是组内演化（旧 → 新）；没有 chain 就只有本节点一条
    const records = Array.isArray(nd.chain) && nd.chain.length
      ? nd.chain : [{ title: nd.label ?? nd.id, text: nd.text ?? nd.value, createdAt: nd.createdAt, status: nd.status }];
    const lines = [`标签：${nd.label ?? nd.id}`, ...(nd.count > 1 ? [`同主题记录：${nd.count} 条`] : []), ''];
    for (const rec of records) {
      lines.push(`标题：${rec.title ?? String(rec.id ?? '').slice(0, 12)}`);
      lines.push(`时间：${String(rec.createdAt ?? '-').slice(0, 10)}${rec.status && rec.status !== 'active' ? `（${rec.status}）` : ''}`);
      if (rec.text) lines.push(`摘要：${String(rec.text).slice(0, 120)}`);
      lines.push('');
    }
    lines.push(`类型：${nd.kind ?? '-'}　状态：${nd.status ?? '-'}　主体：${nd.subject ?? '-'}`);
    detailEl.textContent = lines.join('\n');
  }

  /* ---------- force-graph 实例 ---------- */
  function nodeColor(nd) {
    const base = nodeFillColor(kindColors[nd.kind] || KIND_COLORS.state, uiPalette());
    // superseded 半透明；浅色底再抬高一点 alpha 下限，否则看不见（v0.4.2 规则）
    return nd.status === 'superseded' ? withAlpha(base, uiPalette().light ? 0.55 : 0.4) : base;
  }
  function applyEdgeVisibility() {
    if (!fg) return;
    const types = activeEdgeTypes();
    fg.linkVisibility((e) => types.has(e.type)); // 重设 accessor 触发重算
    fg.linkColor((e) => edgeStrokeColor(e.type, uiPalette()));
    fg.linkWidth((e) => edgeStyleFor(e.type).width);
  }
  function fitToGraph() {
    if (!fg || !state.nodes.length) return;
    fg.zoomToFit(400, 46);
    // 环绕中心 = 节点包围盒中心（zoomToFit 之后取均值即可近似）
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
    updateOverlay();
    if (!fg) return;
    fg.graphData({ nodes: state.nodes, links: state.edges });
    applyEdgeVisibility();
    // 双保险：引擎停止回调之外，再在 400ms / 2000ms 各 fit 一次（数据量小时引擎可能瞬间停）
    setTimeout(() => fitToGraph(), 400);
    setTimeout(() => fitToGraph(), 2000);
  }
  function buildGraph() {
    const pal = uiPalette();
    fg = ForceGraph()(container)
      .backgroundColor(pal.bg)
      .width(container.clientWidth || 600)
      .height(container.clientHeight || 600)
      .nodeId('id')
      .nodeLabel((nd) => nd.label ?? nd.id)
      .nodeVal((nd) => Math.max(1, nd.count ?? 1)) // 半径按聚合条数
      .nodeColor(nodeColor)
      .nodeRelSize(4)
      .linkSource('from')
      .linkTarget('to')
      .nodeCanvasObjectMode(() => 'after')
      // 节点文字：force-graph 默认只给 tooltip，不给画布文字。
      // 缩放很小时不画（避免糊成一团），字体大小按 1/scale 抵消画布缩放，屏幕上恒定 11–13px。
      .nodeCanvasObject((nd, ctx, scale) => {
        if (!nd || scale < 0.22) return;
        const pal = uiPalette();
        const raw = String(nd.label ?? nd.id ?? '');
        const label = raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
        if (!label) return;
        const r = Math.sqrt(Math.max(1, nd.count ?? 1)) * 4 + 3;
        // 关键：font 必须是 12/scale（不做上下钳制），否则画布缩放后屏幕上就不是 12px 了
        const fs = Math.min(80, 12 / scale);
        ctx.save();
        ctx.font = `${fs}px system-ui, -apple-system, 'PingFang SC', sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const x = (nd.x ?? 0) + r + 4 / scale;
        const y = nd.y ?? 0;
        // 描边当 halo：浅色底用近白，深色底用近黑，保证两种主题都可读（v0.4.2 对比度规则）
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = pal.light ? 'rgba(255,255,255,0.92)' : 'rgba(11,13,18,0.85)';
        ctx.strokeText(label, x, y);
        ctx.fillStyle = nd.status === 'superseded' ? pal.nodeDim : pal.label;
        ctx.fillText(label, x, y);
        ctx.restore();
      })
      .onNodeClick(onNodeClick)
      .onZoom((t) => { state.zoom = t.k; })
      // 引擎停下后必须再 fit 一次：首次 zoomToFit 时节点还没散开，
      // 之后节点会飘出视口（v1.0 W6 首版实测：9s 后只剩左上角一小团）
      .onEngineStop(() => { fitToGraph(); })
      .warmupTicks(20)
      .cooldownTicks(220)
      .cooldownTime(4000);

    // 布局手感：默认 charge 太弱 → 节点挤成几坨、标签互相压。
    // 注意：d3Force(name) 返回的是 force 实例（不是 graph），不能串在链上。
    const charge = fg.d3Force('charge');
    if (charge && typeof charge.strength === 'function') charge.strength(-90);
    const link = fg.d3Force('link');
    if (link && typeof link.distance === 'function') link.distance(70);
    applyEdgeVisibility();
  }

  /* ---------- 交互 ---------- */
  let lastClick = { id: null, t: 0 };
  function onNodeClick(nd) {
    state.selectedId = nd.id;
    showDetail(nd);
    const now = Date.now();
    // 快速双击同一节点 = 聚焦（force-graph 2D 没有独立 dblclick 命中，用节流判断）
    if (lastClick.id === nd.id && now - lastClick.t < 350) {
      focusNode(nd);
      lastClick = { id: null, t: 0 };
    } else {
      lastClick = { id: nd.id, t: now };
    }
  }
  function focusNode(nd) {
    if (!fg || !nd) return;
    fg.centerAt(nd.x || 0, nd.y || 0, 600);
    fg.zoom(3, 600);
    state.center = { x: nd.x || 0, y: nd.y || 0 }; // 环绕中心跟着走
  }

  /* 自动缓慢环绕：rotateMode 开时中心点沿小圆周漂移；关则回正（自己的 rAF 驱动，
     与 force-graph 内部模拟解耦，后台标签页被节流也只是转得慢、不炸）。 */
  function tick() {
    if (state.destroyed) return;
    state.rafId = requestAnimationFrame(tick);
    if (!fg || !state.center) return;
    if (state.rotateMode) {
      state.angle += 0.01;
      const r = 30 / Math.max(0.2, state.zoom); // 屏幕上约 30px 的环绕半径
      fg.centerAt(state.center.x + Math.cos(state.angle) * r, state.center.y + Math.sin(state.angle) * r);
    } else if (state.angle !== 0) {
      state.angle = 0;
      fg.centerAt(state.center.x, state.center.y);
    }
  }

  const onResize = () => {
    if (!fg) return;
    fg.width(container.clientWidth || 600).height(container.clientHeight || 600);
  };
  window.addEventListener('resize', onResize);

  /* ---------- 装配 ---------- */
  function buildToolbar() {
    renderToolbar({
      toolbarEl,
      state,
      pref: state.pref,
      optionalEdgeTypes: OPTIONAL_EDGE_TYPES,
      checks: {},
      saveEdgePref,
      render: applyEdgeVisibility, // 工具栏只改 pref，这里把偏好刷到 force-graph
    });
  }

  container.style.position = 'relative'; // 覆盖层定位基准
  buildGraph();
  window.__sedimemGraphState = state; // 自动化验收用（只读快照，不参与业务）
  buildToolbar();
  showDetail(null);
  state.rafId = requestAnimationFrame(tick);

  try {
    const data = await fetchData();
    await loadKindColors();
    applyData(data);
    fitToGraph();
  } catch (err) {
    loadError = err;
    showDetail(null);
  }

  return {
    destroy() {
      state.destroyed = true;
      cancelAnimationFrame(state.rafId);
      window.removeEventListener('resize', onResize);
      if (fg && typeof fg._destructor === 'function') fg._destructor();
      fg = null;
      container.replaceChildren();
      if (detailEl) detailEl.textContent = '';
      if (toolbarEl) toolbarEl.replaceChildren();
    },
    async reload() {
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
    },
    focus(id) { focusNode(nodeById.get(id)); },
  };
}
