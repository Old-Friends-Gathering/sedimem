/**
 * graph.js —— 图谱页渲染与交互（W5 / D 路）：力导向循环、canvas 绘制、缩放/平移/拖拽/详情。
 *
 * 零依赖、零构建：仅用浏览器内置 API（canvas 2D、fetch、requestAnimationFrame、localStorage）。
 * 数据来自 `/api/graph?limit=300&days=90` → { nodes, edges, sampled }。
 * 布局核心 `layoutTick()` 与视觉常量在 ./layout.js（纯函数，单测覆盖）。
 *
 * 交互契约（docs/08-web-ui.md §5.2）：
 * - 实时力导向：斥力 O(n²) + 弹簧 + 向心 + 阻尼 0.85；alpha 初值 1、每帧 ×0.985，< 0.005 停帧；拖拽唤醒。
 * - 拖节点（拖时固定 fx/fy）、滚轮缩放 0.4–2.5（鼠标为锚）、空白拖拽平移、
 *   单击节点渲染详情到 detailEl、双击锁定/释放。
 * - 边默认只画 same-entity + supersedes；工具栏「全开」+ duplicate-of / disputed-with 单独勾选；
 *   偏好存 localStorage 键 `strata.graph.edges`（JSON，只存偏好不存正文）。
 * - sampled.shown < sampled.total 时画布右上角常驻「已采样 shown / total 条」。
 */

import {
  KIND_COLORS, DEFAULT_EDGE_TYPES, OPTIONAL_EDGE_TYPES, EDGE_PREF_KEY, layoutTick,
  MIN_SCALE, MAX_SCALE, ALPHA_MIN,
} from './layout.js';

/** 画一条边各类型使用的样式 */
const EDGE_STYLE = {
  'same-entity': { color: 'rgba(148,163,184,0.5)', dash: [], width: 1 },
  supersedes: { color: 'rgba(100,116,139,0.7)', dash: [6, 3], width: 1.25 },
  'duplicate-of': { color: '#f97316', dash: [7, 5], width: 1 },
  'disputed-with': { color: '#ef4444', dash: [2, 4], width: 1.25 },
};

export async function initGraph({ canvas, detailEl, toolbarEl, apiBase = '/api', scope = '' }) {
  const ctx = canvas.getContext('2d');
  const state = {
    nodes: [],
    edges: [],
    sampled: { shown: 0, total: 0 },
    alpha: 1,
    view: { scale: 1, tx: 0, ty: 0 },
    selectedId: null,
    fitted: false,
    frames: 0,
    userAdjusted: false,
    running: true,
    destroyed: false,
    rafId: 0,
  };
  const pref = loadEdgePref();

  /* ---------- 坐标变换 ---------- */
  const toScreen = (x, y) => [x * state.view.scale + state.view.tx, y * state.view.scale + state.view.ty];
  const toWorld = (sx, sy) => [(sx - state.view.tx) / state.view.scale, (sy - state.view.ty) / state.view.scale];

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();

  /* ---------- 数据加载 ---------- */
  let loadError = null;
  try {
    // 分库必须跟着顶栏走，否则切了分库图谱还是老库（issue #25）
    const q = new URLSearchParams({ limit: '300', days: '90' });
    if (scope) q.set('scope', scope);
    const res = await fetch(`${apiBase}/graph?${q.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    state.edges = Array.isArray(data.edges) ? data.edges : [];
    state.sampled = data.sampled || { shown: state.nodes.length, total: state.nodes.length };
  } catch (err) {
    loadError = err;
    state.nodes = [];
    state.edges = [];
  }

  const nodeById = new Map(state.nodes.map((nd) => [nd.id, nd]));
  const radiusOf = (nd) => Math.sqrt(Math.max(Number(nd.hits) || 0, 0)) + 3;

  /* ---------- 边偏好 ---------- */
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
    try {
      localStorage.setItem(EDGE_PREF_KEY, JSON.stringify(pref));
    } catch { /* localStorage 不可用时静默降级为会话内记忆 */ }
  }
  function activeEdgeTypes() {
    const set = new Set(DEFAULT_EDGE_TYPES);
    if (pref['duplicate-of']) set.add('duplicate-of');
    if (pref['disputed-with']) set.add('disputed-with');
    return set;
  }

  /* ---------- 工具栏 ---------- */
  const checks = {};
  function buildToolbar() {
    toolbarEl.replaceChildren();
    const all = mkCheck('all', '全开', (v) => {
      pref.all = v;
      pref['duplicate-of'] = v;
      pref['disputed-with'] = v;
      checks['duplicate-of'].checked = v;
      checks['disputed-with'].checked = v;
      saveEdgePref();
      render();
    });
    toolbarEl.append(all.wrap);
    for (const t of OPTIONAL_EDGE_TYPES) {
      const c = mkCheck(t, t, (v) => {
        pref[t] = v;
        if (!v) pref.all = false;
        checks.all.checked = pref.all || (pref['duplicate-of'] && pref['disputed-with']);
        saveEdgePref();
        render();
      });
      toolbarEl.append(c.wrap);
    }
    checks.all.checked = pref.all || (pref['duplicate-of'] && pref['disputed-with']);
    checks['duplicate-of'].checked = !!pref['duplicate-of'];
    checks['disputed-with'].checked = !!pref['disputed-with'];
  }
  function mkCheck(key, label, onChange) {
    const labelEl = document.createElement('label');
    labelEl.style.marginRight = '12px';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    const span = document.createElement('span');
    span.textContent = ` ${label}`;
    labelEl.append(input, span);
    checks[key] = input;
    return { wrap: labelEl, input };
  }

  /* ---------- 详情 ---------- */
  function showDetail(nd) {
    if (!nd) {
      detailEl.textContent = loadError
        ? `加载失败：${loadError.message}`
        : '点击节点查看详情';
      return;
    }
    const lines = [
      `标签：${nd.label ?? nd.id}`,
      `类型：${nd.kind ?? '-'}　状态：${nd.status ?? '-'}`,
      `主体：${nd.subject ?? '-'}`,
      `创建时间：${nd.createdAt ?? '-'}`,
      `命中：${nd.hits ?? 0}　度数：${nd.degree ?? 0}`,
      '',
      '全文：',
      String(nd.text ?? nd.value ?? '（接口未提供正文）'),
    ];
    detailEl.textContent = lines.join('\n');
  }

  /* ---------- 命中检测 ---------- */
  function hitNode(sx, sy) {
    for (let i = state.nodes.length - 1; i >= 0; i--) {
      const nd = state.nodes[i];
      const [px, py] = toScreen(nd.x, nd.y);
      const r = radiusOf(nd) * state.view.scale + 4;
      if ((sx - px) ** 2 + (sy - py) ** 2 <= r * r) return nd;
    }
    return null;
  }

  /* ---------- 渲染 ---------- */
  /** 自适应视图：把当前布局按包围盒缩放到画布内（右侧留出详情面板宽度由 CSS 保证）。 */
  function fitView() {
    const rect = canvas.getBoundingClientRect();
    if (!state.nodes.length || rect.width < 40 || rect.height < 40) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const nd of state.nodes) {
      if (!Number.isFinite(nd.x) || !Number.isFinite(nd.y)) continue;
      minX = Math.min(minX, nd.x); maxX = Math.max(maxX, nd.x);
      minY = Math.min(minY, nd.y); maxY = Math.max(maxY, nd.y);
    }
    if (!Number.isFinite(minX)) return;
    const pad = 70;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const scale = Math.max(0.4, Math.min(2.5, Math.min((rect.width - pad * 2) / bw, (rect.height - pad * 2) / bh)));
    const cxWorld = (minX + maxX) / 2;
    const cyWorld = (minY + maxY) / 2;
    state.view.scale = scale;
    state.view.tx = rect.width / 2 - cxWorld * scale;
    state.view.ty = rect.height / 2 - cyWorld * scale;
  }

  function render() {
    state.frames++;
    // 自动适配：用户未手动缩放/平移前，每 20 帧把布局缩放回画布内，
    // 这样模拟过程中图不会缩成一小团，也不会因为持续外扩而跑出画布。
    if (!state.userAdjusted && state.frames % 20 === 0) fitView();
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (loadError) {
      ctx.fillStyle = '#ef4444';
      ctx.font = '13px sans-serif';
      ctx.fillText(`加载失败：${loadError.message}`, 12, 24);
      return;
    }
    const types = activeEdgeTypes();
    // 边
    for (const e of state.edges) {
      if (!types.has(e.type)) continue;
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) continue;
      const st = EDGE_STYLE[e.type] || EDGE_STYLE['same-entity'];
      const [x1, y1] = toScreen(a.x, a.y);
      const [x2, y2] = toScreen(b.x, b.y);
      ctx.beginPath();
      ctx.setLineDash(st.dash);
      const w = Number.isFinite(e.weight) ? Math.max(0.75, Math.min(3, e.weight)) : 1;
      ctx.lineWidth = e.type === 'duplicate-of' ? w : st.width;
      ctx.strokeStyle = st.color;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 节点
    for (const nd of state.nodes) {
      const [px, py] = toScreen(nd.x, nd.y);
      const r = radiusOf(nd) * state.view.scale;
      const color = KIND_COLORS[nd.kind] || KIND_COLORS.state;
      const superseded = nd.status === 'superseded';
      ctx.beginPath();
      ctx.globalAlpha = superseded ? 0.4 : 1;
      ctx.fillStyle = color;
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      if (superseded) {
        // 斜线标记
        ctx.save();
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(px - r, py + r);
        ctx.lineTo(px + r, py - r);
        ctx.strokeStyle = 'rgba(15,23,42,0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
      if (nd.status === 'disputed') {
        ctx.beginPath();
        ctx.arc(px, py, r + 2, 0, Math.PI * 2);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.75;
        ctx.stroke();
      }
      if (nd.id === state.selectedId) {
        ctx.beginPath();
        ctx.arc(px, py, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(15,23,42,0.65)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (state.alpha < 0.02 && !state.fitted) { state.fitted = true; if (!state.userAdjusted) fitView(); }

    // 标签（裁决 33：label 由服务端生成，这里只负责绘制；够放才画）
      if (state.view.scale >= 0.45 && nd.label) {
        const text = nd.label.length > 16 ? `${nd.label.slice(0, 16)}…` : nd.label;
        ctx.font = '11px -apple-system, "PingFang SC", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(11,13,18,0.85)';
        ctx.strokeText(text, px, py + r + 4);
        ctx.fillStyle = superseded ? '#8b93a3' : '#cfd6e4';
        ctx.fillText(text, px, py + r + 4);
      }
    }
    // 采样提示（右上角常驻）
    if (state.sampled.shown < state.sampled.total) {
      const text = `已采样 ${state.sampled.shown} / ${state.sampled.total} 条`;
      ctx.font = '12px sans-serif';
      const w = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(15,23,42,0.06)';
      ctx.fillRect(rect.width - w - 22, 10, w + 14, 24);
      ctx.fillStyle = '#475569';
      ctx.fillText(text, rect.width - w - 15, 26);
    }
  }

  /** 按画布尺寸给布局参数：节点少时弹簧更长，图形自然铺开；大屏不缩在中间一小团 */
  function layoutOpts(width, height) {
    const base = Math.max(120, Math.min(320, Math.min(width, height) / 2.6));
    return {
      springLength: base,
      repulsion: 4200 * (base / 120) ** 2,
      centering: 0.012,
    };
  }

  /* ---------- 主循环 ---------- */
  function frame() {
    if (state.destroyed) return;
    if (state.running && state.alpha >= ALPHA_MIN && state.nodes.length > 0) {
      const width = canvas.getBoundingClientRect().width || 600;
      const height = canvas.getBoundingClientRect().height || 600;
      const out = layoutTick(state.nodes, state.edges, { alpha: state.alpha, width, height, ...layoutOpts(width, height) });
      state.alpha = out.alpha;
    }
    render();
    state.rafId = requestAnimationFrame(frame);
  }

  /* ---------- 交互 ---------- */
  let drag = null; // { kind:'node'|'pan', node?, lastX,lastY, moved, downX, downY }
  function localPos(ev) {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }
  const onPointerDown = (ev) => {
    const [sx, sy] = localPos(ev);
    const nd = hitNode(sx, sy);
    if (nd) {
      nd.fx = nd.x;
      nd.fy = nd.y;
      drag = { kind: 'node', node: nd, moved: 0, downX: sx, downY: sy };
    } else {
      drag = { kind: 'pan', lastX: ev.clientX, lastY: ev.clientY, moved: 0, downX: sx, downY: sy };
    }
    canvas.setPointerCapture?.(ev.pointerId);
  };
  const onPointerMove = (ev) => {
    if (!drag) return;
    const [sx, sy] = localPos(ev);
    if (drag.kind === 'node') {
      const [wx, wy] = toWorld(sx, sy);
      drag.node.fx = wx;
      drag.node.fy = wy;
      drag.moved += Math.abs(ev.movementX || 0) + Math.abs(ev.movementY || 0);
      state.alpha = Math.max(state.alpha, 0.3); // 拖拽唤醒
    } else {
      state.userAdjusted = true;
      state.view.tx += ev.clientX - drag.lastX;
      state.view.ty += ev.clientY - drag.lastY;
      drag.moved += Math.abs(ev.clientX - drag.lastX) + Math.abs(ev.clientY - drag.lastY);
      drag.lastX = ev.clientX;
      drag.lastY = ev.clientY;
    }
  };
  const onPointerUp = (ev) => {
    if (!drag) return;
    if (drag.kind === 'node') {
      const nd = drag.node;
      const wasLocked = nd.__locked === true;
      if (drag.moved < 4) {
        // 单击：选中并渲染详情
        state.selectedId = nd.id;
        showDetail(nd);
      }
      // 拖时固定的 fx/fy：锁定节点保留，否则释放回模拟
      if (!wasLocked) {
        delete nd.fx;
        delete nd.fy;
      }
      state.alpha = Math.max(state.alpha, 0.2);
    } else if (drag.moved < 4) {
      state.selectedId = null;
      showDetail(null);
    }
    drag = null;
    canvas.releasePointerCapture?.(ev.pointerId);
  };
  const onDblClick = (ev) => {
    const [sx, sy] = localPos(ev);
    const nd = hitNode(sx, sy);
    if (!nd) return;
    if (nd.__locked) {
      delete nd.__locked;
      delete nd.fx;
      delete nd.fy;
      nd.status = nd.__prevStatus ?? nd.status;
      delete nd.__prevStatus;
    } else {
      nd.__locked = true;
      nd.fx = nd.x;
      nd.fy = nd.y;
      nd.__prevStatus = nd.status;
    }
    state.alpha = Math.max(state.alpha, 0.2);
  };
  const onWheel = (ev) => {
    ev.preventDefault();
    const [sx, sy] = localPos(ev);
    const old = state.view.scale;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, old * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
    // 以鼠标为锚：保持 (sx,sy) 对应的世界点不动
    state.userAdjusted = true;
    state.view.tx = sx - ((sx - state.view.tx) / old) * next;
    state.view.ty = sy - ((sy - state.view.ty) / old) * next;
    state.view.scale = next;
  };
  const onResize = () => { resizeCanvas(); render(); };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', onResize);

  buildToolbar();
  showDetail(null);
  // 同步热身：先跑 80 帧模拟再自适应缩放，保证首帧就是「铺满画布」的稳定布局
  // （rAF 在后台标签页/无头浏览器里可能被节流，不能只依赖逐帧自适应）
  if (state.nodes.length > 0) {
    const rect0 = canvas.getBoundingClientRect();
    for (let i = 0; i < 80; i++) {
      const w0 = rect0.width || 600;
      const h0 = rect0.height || 600;
      const out = layoutTick(state.nodes, state.edges, {
        alpha: state.alpha, width: w0, height: h0, ...layoutOpts(w0, h0),
      });
      state.alpha = out.alpha;
    }
    fitView();
  }

  state.rafId = requestAnimationFrame(frame);

  return {
    destroy() {
      state.destroyed = true;
      cancelAnimationFrame(state.rafId);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (detailEl) detailEl.textContent = '';
      if (toolbarEl) toolbarEl.replaceChildren();
    },
  };
}
