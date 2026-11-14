/**
 * graph-ui.js —— 图谱 UI 纯辅助（不持有 force-graph 实例，可在 Node 单测直接覆盖）。
 *
 * 从 graph.js 拆出：搜索匹配、邻居/度数、标签避让与绘制、tooltip、键盘、环绕漂移、
 * 边偏好、详情渲染、localStorage 状态（键 sedimem.graph.ui）。
 * 零依赖、零构建，只用浏览器内置 API；Node 无 window/localStorage 时安全降级。
 */

/** localStorage 持久化键（图 UI 状态） */
export const UI_KEY = 'sedimem.graph.ui';
/** 搜索高亮环 / 强调色（palette 无 accent，独立定一个） */
export const ACCENT = '#f59e0b';

/** hex → 带透明度的颜色。非法输入原样返回。 */
export function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color || ''));
  if (!m) return color;
  const h = m[1];
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

/** 读取持久化 UI 状态；损坏或缺键时返回安全默认值。 */
export function loadUiState() {
  const def = { onlyThisScope: true, kindsOff: [], edgeTypes: null, search: '' };
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return def;
    const p = JSON.parse(raw);
    return {
      onlyThisScope: p.onlyThisScope !== false, // 缺省按「只看当前分库」
      kindsOff: Array.isArray(p.kindsOff) ? p.kindsOff.filter((k) => typeof k === 'string') : [],
      edgeTypes: p.edgeTypes && typeof p.edgeTypes === 'object' ? p.edgeTypes : null,
      search: typeof p.search === 'string' ? p.search : '',
    };
  } catch { return def; }
}

/** 合并保存 UI 状态（读旧 → 浅合并 → 写回），localStorage 不可用时静默跳过。 */
export function saveUiState(patch) {
  try {
    const cur = loadUiState();
    localStorage.setItem(UI_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch { /* 静默降级（隐私模式等） */ }
}

/** 读取边类型偏好 {all,'duplicate-of','disputed-with'}（键由调用方传入）。 */
export function loadEdgePref(key) {
  const fallback = { all: false, 'duplicate-of': false, 'disputed-with': false };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    return {
      all: !!p.all,
      'duplicate-of': !!(p.all || p['duplicate-of']),
      'disputed-with': !!(p.all || p['disputed-with']),
    };
  } catch { return fallback; }
}

/** 保存边类型偏好到 key，并同步一份进 sedimem.graph.ui.edgeTypes。 */
export function saveEdgePref(key, pref) {
  try { localStorage.setItem(key, JSON.stringify(pref)); } catch { /* 静默降级 */ }
  saveUiState({ edgeTypes: { ...pref } });
}

/** 节点度数表：Map<id, 度数>（按边两端各计 1）。 */
export function computeDegrees(nodes, edges) {
  const deg = new Map();
  for (const nd of nodes || []) deg.set(nd.id, 0);
  for (const e of edges || []) {
    if (deg.has(e.source)) deg.set(e.source, deg.get(e.source) + 1);
    if (deg.has(e.target)) deg.set(e.target, deg.get(e.target) + 1);
  }
  return deg;
}

/** 邻居集合：id 的所有直接邻居（不含自身）。 */
export function neighborSet(id, edges) {
  const set = new Set();
  for (const e of edges || []) {
    if (e.source === id) set.add(e.target);
    else if (e.target === id) set.add(e.source);
  }
  return set;
}

/** 搜索匹配：命中 id 集合（label 子串、大小写不敏感）；空查询返回 null（无搜索态）。 */
export function matchNodes(nodes, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const hits = new Set();
  for (const nd of nodes || []) {
    if (String(nd.label ?? nd.id ?? '').toLowerCase().includes(q)) hits.add(nd.id);
  }
  return hits;
}

/**
 * 标签避让：按度数降序逐个放置标签矩形，重叠则跳过（度数低者让位）。
 * @returns {Set<string>} 允许绘制标签的节点 id 集合
 */
export function planLabels(nodes, degrees, measure) {
  const ok = new Set();
  const rects = [];
  const sorted = [...(nodes || [])].sort(
    (a, b) => (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0) || String(a.id).localeCompare(String(b.id)),
  );
  for (const nd of sorted) {
    const r = measure(nd);
    if (!r) continue;
    if (rects.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h)) continue;
    rects.push(r);
    ok.add(nd.id);
  }
  return ok;
}

/** 标签字号（画布世界坐标；force-graph 缩放后屏幕上恒定约 12px）。 */
function labelFont(scale) { return Math.min(80, 12 / scale); }

/** 测量节点标签的世界坐标矩形（供 planLabels 避让）。 */
export function measureLabel(nd, ctx, scale) {
  const r = Math.sqrt(Math.max(1, nd.count ?? 1)) * 4 + 3;
  const fs = labelFont(scale);
  ctx.font = `${fs}px system-ui, -apple-system, 'PingFang SC', sans-serif`;
  const w = ctx.measureText(String(nd.label ?? nd.id ?? '')).width + r + 6 / scale;
  return { x: nd.x ?? 0, y: (nd.y ?? 0) - fs / 2, w, h: fs * 1.2 };
}

/** 搜索命中 / 固定节点的高亮环（accent 色）。 */
export function drawRing(nd, ctx, scale) {
  const r = Math.sqrt(Math.max(1, nd.count ?? 1)) * 4 + 6;
  ctx.beginPath();
  ctx.arc(nd.x ?? 0, nd.y ?? 0, r, 0, 2 * Math.PI);
  ctx.lineWidth = 2 / scale;
  ctx.strokeStyle = ACCENT;
  ctx.stroke();
}

/** 画节点标签：halo 描边保证浅/深两主题可读；超 18 字截断。 */
export function drawNodeLabel(nd, ctx, scale, pal) {
  const raw = String(nd.label ?? nd.id ?? '');
  const label = raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
  if (!label) return;
  const r = Math.sqrt(Math.max(1, nd.count ?? 1)) * 4 + 3;
  const fs = labelFont(scale);
  ctx.save();
  ctx.font = `${fs}px system-ui, -apple-system, 'PingFang SC', sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const x = (nd.x ?? 0) + r + 4 / scale;
  const y = nd.y ?? 0;
  ctx.lineWidth = 3 / scale;
  ctx.strokeStyle = pal.light ? 'rgba(255,255,255,0.92)' : 'rgba(11,13,18,0.85)';
  ctx.strokeText(label, x, y);
  ctx.fillStyle = nd.status === 'superseded' ? pal.nodeDim : pal.label;
  ctx.fillText(label, x, y);
  ctx.restore();
}

/** 创建 tooltip（DOM 覆盖层，textContent 防注入）。返回 {show, hide, el}。 */
export function createTooltip(container) {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;display:none;max-width:280px;padding:6px 10px;'
    + 'font:12px/1.5 sans-serif;border-radius:6px;pointer-events:none;z-index:5;'
    + 'background:rgba(15,18,26,0.92);color:#e2e8f0;white-space:pre-wrap;';
  container.appendChild(el);
  return {
    el,
    show(lines, x, y) {
      el.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
      el.style.display = 'block';
      const w = container.clientWidth || 600;
      const h = container.clientHeight || 400;
      const px = x + 14 + el.offsetWidth > w ? x - el.offsetWidth - 8 : x + 14;
      const py = y + 14 + el.offsetHeight > h ? y - el.offsetHeight - 8 : y + 14;
      el.style.left = `${Math.max(2, px)}px`;
      el.style.top = `${Math.max(2, py)}px`;
    },
    hide() { el.style.display = 'none'; },
  };
}

/** 悬停 tooltip 的三行文案：label / kind+状态 / 记录数。 */
export function tooltipLines(nd) {
  return [
    String(nd.label ?? nd.id ?? ''),
    `类型：${nd.kind ?? '-'}　状态：${nd.status ?? '-'}`,
    `记录：${nd.hits ?? nd.count ?? 1} 条`,
  ];
}

/**
 * 自动缓慢环绕：rotateMode 开时中心点沿小圆周漂移（半径按 zoom 折算屏幕约 30px）。
 * 纯步进函数，rAF 由调用方驱动。getFg() 返回当前 force-graph 实例或 null。
 */
export function createOrbit(getFg, state) {
  return {
    step() {
      const fg = getFg();
      if (!fg || !state.center) return;
      if (state.rotateMode) {
        state.angle += 0.01;
        const r = 30 / Math.max(0.2, state.zoom);
        fg.centerAt(state.center.x + Math.cos(state.angle) * r, state.center.y + Math.sin(state.angle) * r);
      } else if (state.angle !== 0) {
        state.angle = 0;
        fg.centerAt(state.center.x, state.center.y);
      }
    },
  };
}

/** 渲染节点详情到 detailEl（textContent 防注入）。nd 为空显示提示/错误。 */
export function renderDetail(detailEl, nd, opts = {}) {
  if (!detailEl) return;
  if (!nd) {
    detailEl.textContent = opts.loadError ? `加载失败：${opts.loadError.message}` : '点击节点查看详情';
    return;
  }
  const records = Array.isArray(nd.chain) && nd.chain.length
    ? nd.chain : [{ title: nd.label ?? nd.id, text: nd.text ?? nd.value, createdAt: nd.createdAt, status: nd.status }];
  const lines = [`标签：${nd.label ?? nd.id}`, ...(nd.count > 1 ? [`同主题记录：${nd.count} 条`] : []), ''];
  for (const rec of records) {
    lines.push(`标题：${rec.title ?? String(rec.id ?? '').slice(0, 12)}`);
    lines.push(`时间：${String(rec.createdAt ?? '-').slice(0, 10)}${rec.status && rec.status !== 'active' ? `（${rec.status}）` : ''}`);
    if (rec.text) lines.push(`摘要：${String(rec.text).slice(0, 120)}`);
    lines.push('');
  }
  lines.push(`类型：${nd.kind ?? '-'}　状态：${nd.status ?? '-'}　主体：${nd.subject ?? '-'}`
    + (opts.pinned ? '　（已固定，点击/右键释放）' : ''));
  detailEl.textContent = lines.join('\n');
}

/**
 * 键盘处理：+/- 缩放、0 适应视图、f 聚焦选中、r 重新布局、Esc 清空。
 * 焦点在 input/textarea/contenteditable 内时不生效。返回解绑函数。
 */
export function attachKeyboard(handlers) {
  const onKey = (ev) => {
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = ev.key;
    if (k === '+' || k === '=') { ev.preventDefault(); handlers.zoomIn(); }
    else if (k === '-' || k === '_') { ev.preventDefault(); handlers.zoomOut(); }
    else if (k === '0') { ev.preventDefault(); handlers.fit(); }
    else if (k === 'f' || k === 'F') { handlers.focusSelected(); }
    else if (k === 'r' || k === 'R') { handlers.relayout(); }
    else if (k === 'Escape') { handlers.clear(); }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/* ---- 图谱视觉常量（原 layout.js，v1.0 W6 合并进来） ---- */
export const KIND_COLORS = Object.freeze({
  fact: '#5b9cf5',
  pref: '#c084fc',
  decision: '#34d399',
  gotcha: '#fbbf24',
  state: '#94a3b8',
});

/**
 * 由 policy.kinds 生成 kind → 颜色映射（issue #33：颜色唯一真相随 policy 下发）。
 * kinds 缺失或某 kind 缺色时回落 KIND_COLORS，视觉与数据化之前保持一致。
 * @param {{kinds?: Record<string,{color?:string}>}} policy /api/summary 返回的 policy 对象
 * @returns {Record<string,string>} 新建的普通对象（可自由覆写，不含 fallback 语义）
 */
export function kindColorsFromPolicy(policy) {
  const colors = {};
  const entries = policy?.kinds && typeof policy.kinds === 'object' ? policy.kinds : {};
  // 先铺兜底表再允许 policy 覆盖：policy 只需给出差异项也能得到完整色表
  for (const [k, v] of Object.entries(KIND_COLORS)) {
    const c = typeof entries[k]?.color === 'string' && entries[k].color ? entries[k].color : v;
    colors[k] = c;
  }
  // policy 新增的 kind（兜底表没有）也要带上，否则新 kind 节点画不出专属色
  for (const [k, meta] of Object.entries(entries)) {
    if (!(k in colors) && typeof meta?.color === 'string' && meta.color) colors[k] = meta.color;
  }
  return colors;
}

/** 默认开启的边类型（v0.3.3：same-entity 复活为「跨主题实体共现」，默认画） */
export const DEFAULT_EDGE_TYPES = ['supersedes', 'same-entity'];
/** 可选边类型（工具栏单独勾选） */
export const OPTIONAL_EDGE_TYPES = ['duplicate-of', 'disputed-with'];
/** localStorage 持久化键 */
export const EDGE_PREF_KEY = 'sedimem.graph.edges';

/** 交互阈值（graph.js 的缩放与停帧判断共用，避免两处各写一份魔法数字） */
export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2.5;
export const ALPHA_MIN = 0.005;
/* 说明：v1.0 W6 起图谱换成 force-graph（vendor），本文件只保留「视觉常量 + kind 配色」，
 * 原 3D 力导向实现（layoutTick / 球壳约束 / 深度雾化）随自研渲染器一起删除 —— 约 -170 行。
 * 常量仍从这里出口，是为了不动 graph.js 与既有测试的 import 路径。
 */
