/**
 * layout.js —— 图谱力导向布局与视觉常量（纯函数，不碰 DOM）。
 *
 * 从 graph.js 拆出来（裁决 43）：布局可被 node 单测直接覆盖，渲染与交互留在 graph.js，
 * 两个文件各自在质量门禁 Q9 的单文件行数上限内。
 *
 * 零依赖、零构建：仅用浏览器内置 API（canvas 2D、fetch、requestAnimationFrame、localStorage）。
 * 数据来自 `/api/graph?limit=300&days=90` → { nodes, edges, sampled }。
 *
 * 布局核心 `layoutTick()` 是纯函数（不碰 DOM / rAF / Math.random），
 * 由 `initGraph()` 每帧调用，单元测试 tests/unit/graph-layout.test.js 直接覆盖它。
 *
 * 交互契约（docs/08-web-ui.md §5.2）：
 * - 实时力导向：斥力 O(n²) + 弹簧 + 向心 + 阻尼 0.85；alpha 初值 1、每帧 ×0.985，< 0.005 停帧；拖拽唤醒。
 * - 拖节点（拖时固定 fx/fy）、滚轮缩放 0.4–2.5（鼠标为锚）、空白拖拽平移、
 *   单击节点渲染详情到 detailEl、双击锁定/释放。
 * - 边默认只画 same-entity + supersedes；工具栏「全开」+ duplicate-of / disputed-with 单独勾选；
 *   偏好存 localStorage 键 `strata.graph.edges`（JSON，只存偏好不存正文）。
 * - sampled.shown < sampled.total 时画布右上角常驻「已采样 shown / total 条」。
 */

/**
 * kind → 基础色（docs §5.2 四色 + state 灰蓝）。
 * issue #33 后降级为「兜底色表」：正式颜色以 /api/summary 返回的 policy.kinds 为准
 * （kindColorsFromPolicy），本表只在接口缺 kinds / 未知 kind 时保底，保证画布永远有色可画。
 */
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
export const EDGE_PREF_KEY = 'strata.graph.edges';

/** 交互阈值（graph.js 的缩放与停帧判断共用，避免两处各写一份魔法数字） */
export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2.5;
export const ALPHA_MIN = 0.005;

/**
 * 力导向布局的单帧推进（纯函数）。
 *
 * 就地更新每个节点的 x/y/vx/vy；不碰 DOM、不用 rAF、不用 Math.random（默认完全确定性，
 * opts.rng 仅为注入位保留，默认不使用）。`initGraph` 每帧调用它。
 *
 * 力模型（v0.2 参数为经验值，n ≤ 300 可实时）：
 * - 斥力：两两库仑斥力 ~ k²/d（截断最小距离，防数值爆炸）；
 * - 弹簧：每条边把两端拉向 `springLength`，劲度 ×weight；
 * - 向心：所有节点受弱引力拉向画布中心，防漂移；
 * - 阻尼：每帧速度 ×damping（默认 0.85）；
 * - alpha：模拟"温度"，由调用方传入，帧内所有力 ×alpha；本函数只做 ×alphaDecay 衰减并返回新值。
 *
 * 节点带 `fx/fy` 时视为固定（拖拽/锁定），位置不变、速度清零、不参与积分。
 * 节点缺 x/y 时按索引以黄金角圆环确定性初始化（无需随机源）。
 *
 * @param {Array<{id:string,x?:number,y?:number,vx?:number,vy?:number,fx?:number,fy?:number,hits?:number}>} nodes
 * @param {Array<{from:string,to:string,weight?:number}>} edges
 * @param {{width?:number,height?:number,alpha?:number,alphaDecay?:number,damping?:number,
 *          repulsion?:number,spring?:number,springLength?:number,centering?:number,
 *          maxStep?:number,rng?:(()=>number)}} [opts]
 * @returns {{alpha:number,energy:number}} 衰减后的 alpha 与本帧总动能 Σ(vx²+vy²)
 */
export function layoutTick(nodes, edges, opts = {}) {
  const {
    width = 600,
    height = 600,
    alpha = 1,
    alphaDecay = 0.985,
    damping = 0.85,
    repulsion = 4200,
    spring = 0.04,
    springLength = 120,
    centering = 0.012,
    maxStep = 18,
  } = opts;

  const n = nodes.length;
  if (n === 0) return { alpha: alpha * alphaDecay, energy: 0 };

  const cx = width / 2;
  const cy = height / 2;

  // 确定性初始化缺失坐标（黄金角球面分布，避免 Math.random）。
  // z 轴也参与布局（3D 力导向）：斥力/弹簧/向心都在三维里算，投影时按 z 缩放。
  for (let i = 0; i < n; i++) {
    const nd = nodes[i];
    if (!Number.isFinite(nd.x) || !Number.isFinite(nd.y)) {
      // 斐波那契球面：均匀铺在半径 R 的球上，z 用 sinθ
      const R = 150;
      const phi = i * 2.399963229728653; // 黄金角
      const zz = 1 - (2 * i + 1) / n; // cosθ ∈ (-1,1)
      const rr = Math.sqrt(Math.max(0, 1 - zz * zz));
      nd.x = cx + R * rr * Math.cos(phi);
      nd.y = cy + R * zz * 0.72; // 压扁成椭球，适配宽屏
      nd.z = R * rr * Math.sin(phi) * 0.6;
    }
    if (!Number.isFinite(nd.vx)) nd.vx = 0;
    if (!Number.isFinite(nd.vy)) nd.vy = 0;
    if (!Number.isFinite(nd.vz)) nd.vz = 0;
  }

  const free = [];
  for (const nd of nodes) {
    if (Number.isFinite(nd.fx) && Number.isFinite(nd.fy)) {
      nd.x = nd.fx;
      nd.y = nd.fy;
      nd.vx = 0;
      nd.vy = 0;
    } else {
      free.push(nd);
    }
  }

  // 斥力（O(n²)，n≤300 可接受）：三维累积加速度
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const az = new Float64Array(n);
  const idx = new Map();
  for (let i = 0; i < n; i++) idx.set(nodes[i].id, i);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = nodes[i]; const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dz = (b.z ?? 0) - (a.z ?? 0);
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-6) {
        dx = (j - i) * 0.5 + 0.25;
        dy = (i - j) * 0.35 - 0.2;
        dz = ((i * 7 + j * 3) % 11 - 5) * 0.1;
        d2 = dx * dx + dy * dy + dz * dz;
      }
      const d = Math.sqrt(d2);
      const f = repulsion / d2;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      ax[i] -= ux * f; ay[i] -= uy * f; az[i] -= uz * f;
      ax[j] += ux * f; ay[j] += uy * f; az[j] += uz * f;
    }
  }

  // 弹簧（三维）+ 向心
  for (const e of edges || []) {
    const i = idx.get(e.from);
    const j = idx.get(e.to);
    if (i === undefined || j === undefined || i === j) continue;
    const a = nodes[i]; const b = nodes[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = (b.z ?? 0) - (a.z ?? 0);
    const d = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-6);
    const w = Number.isFinite(e.weight) ? e.weight : 1;
    const f = spring * w * (d - springLength);
    const ux = dx / d, uy = dy / d, uz = dz / d;
    ax[i] += ux * f; ay[i] += uy * f; az[i] += uz * f;
    ax[j] -= ux * f; ay[j] -= uy * f; az[j] -= uz * f;
  }
  for (let i = 0; i < n; i++) {
    ax[i] += (cx - nodes[i].x) * centering;
    ay[i] += (cy - nodes[i].y) * centering;
    az[i] += (0 - (nodes[i].z ?? 0)) * centering * 0.8; // z 向心：收向球心平面
  }

  // 积分：仅自由节点；限步防炸；阻尼
  let energy = 0;
  for (const nd of free) {
    const i = idx.get(nd.id);
    nd.vx = (nd.vx + ax[i] * alpha) * damping;
    nd.vy = (nd.vy + ay[i] * alpha) * damping;
    nd.vz = ((nd.vz ?? 0) + az[i] * alpha) * damping;
    const sp = Math.hypot(nd.vx, nd.vy, nd.vz ?? 0);
    if (sp > maxStep) {
      nd.vx = (nd.vx / sp) * maxStep;
      nd.vy = (nd.vy / sp) * maxStep;
      nd.vz = ((nd.vz ?? 0) / sp) * maxStep;
    }
    nd.x += nd.vx;
    nd.y += nd.vy;
    nd.z = (nd.z ?? 0) + (nd.vz ?? 0);
    energy += nd.vx * nd.vx + nd.vy * nd.vy + (nd.vz ?? 0) ** 2;
  }

  return { alpha: alpha * alphaDecay, energy };
}

/**
 * 初始化图谱页。
 *
 * @param {{canvas:HTMLCanvasElement, detailEl:HTMLElement, toolbarEl:HTMLElement, apiBase?:string}} cfg
 * @returns {Promise<{destroy:()=>void}>}
 */
