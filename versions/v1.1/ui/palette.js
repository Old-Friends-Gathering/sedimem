/**
 * palette.js —— 画布配色跟随系统外观（与 style.css 的 prefers-color-scheme 同步）。
 * 每次绘制时调用 uiPalette()（读 matchMedia 很便宜），系统切换深浅后下一帧即生效，
 * 无需刷新页面。
 *
 * 深色底的取色规则不能直接搬到浅色底：粉彩节点色与浅灰边在白底上会「消失」。
 * 因此这里除两套基础色外，还提供三个**纯函数**做浅色适配（无 DOM、可单测）：
 *   - contrastColor(color, { light })  浅色下把给定颜色定向压暗，深色原样返回
 *   - fogAlphaFloor(kind, { light })   浅色下抬高深度雾化下限（背面节点仍可辨）
 *   - nodeStroke({ light })            浅色下节点描边（与边/背景分离）
 */

/** 深色与浅色两套画布色。字段与 style.css 的 --node-* / --grid 一一对应。 */
const DARK = {
  light: false,
  nodeFg: '#cfd6e4',   // 活跃节点
  nodeDim: '#8b93a3',  // superseded 节点
  label: '#acb5cf',    // 节点标签
  grid: '#253047',     // 参考线/坐标
  badge: '#e7e9ee',    // ×N 徽标
  bg: '#151517',
};

const LIGHT = {
  light: true,
  nodeFg: '#1f2430',
  nodeDim: '#6b7280',  // 浅色下比深色的 #8b93a3 更深，否则被 superseded 的 0.4 alpha 抹平
  label: '#334155',    // 浅底上标签再压深一档
  grid: '#e6eaf2',
  badge: '#1f2430',
  bg: '#ffffff',
};

/** 浅色下各类元素的压暗比例（0=不压暗，1=纯黑）。边比节点更需要压暗。 */
const DARKEN = Object.freeze({ edge: 0.58, node: 0.26, label: 0.18 });

/** parseColor('rgba(148,163,184,0.5)') / parseColor('#5b9cf5') → {r,g,b,a} */
export function parseColor(color) {
  if (typeof color !== 'string') return null;
  const s = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const m = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(s);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

/** 把颜色定向压暗（与黑色混合），保留 alpha；无法解析就原样返回。 */
export function contrastColor(color, pal, ratio = DARKEN.edge) {
  if (!pal || !pal.light) return color;
  const c = parseColor(color);
  if (!c) return color;
  const k = 1 - Math.max(0, Math.min(1, ratio));
  const [r, g, b] = [Math.round(c.r * k), Math.round(c.g * k), Math.round(c.b * k)];
  return c.a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${c.a})`;
}

/** 浅色下深度雾化的下限（深色底可以更淡，浅色底必须抬高否则「消失」）。 */
export function fogAlphaFloor(kind, pal) {
  const light = Boolean(pal && pal.light);
  if (kind === 'edge') return light ? 0.46 : 0.12;
  return light ? 0.55 : 0.35;
}

/** 节点描边：浅色底给一圈近白描边，把节点从边与背景里「抠」出来；深色底不需要。 */
export function nodeStroke(pal) {
  return pal && pal.light ? { color: 'rgba(255,255,255,0.92)', width: 1.25 } : null;
}

/**
 * @returns {{light:boolean,nodeFg:string,nodeDim:string,label:string,grid:string,badge:string,bg:string}}
 *          当前系统外观对应的画布配色。
 */
export function uiPalette() {
  // 与宿主色板同源：?theme=light|dark 或系统偏好，画布与 CSS 一起切换
  const forced = typeof window !== 'undefined'
    ? new URLSearchParams(window.location?.search ?? '').get('theme') : null;
  if (forced === 'light') return LIGHT;
  if (forced === 'dark') return DARK;
  const dark = typeof matchMedia === 'function'
    ? matchMedia('(prefers-color-scheme: dark)').matches
    : true;
  return dark ? DARK : LIGHT;
}

/** 供测试与其它模块复用的常量（避免测试里手抄魔法值）。 */
export const PALETTES = Object.freeze({ DARK, LIGHT, DARKEN });

/* 宿主（DSH）配色对齐：观察台要嵌进 DSH 插件面板，颜色必须像同一个软件。
 * 取值为 DSH 客户端包内出现频次最高的品牌/背景色（grep 字面量所得，非公开令牌）；
 * 换主题只改这里，style.css 只消费 --sd-*。 */
export const HOST_LIGHT = Object.freeze({
  light: true, bg: '#ffffff', surface: '#f5f6fc', panel: '#ffffff', panel2: '#f0f2f9',
  border: '#e6eaf2', text: '#1f2a44', muted: '#7a859e', faint: '#acb5cf',
  accent: '#4d6bfe', accentSoft: '#e8edff', danger: '#fc5c5c', ok: '#97b552',
  info: '#0188fb', warn: '#ffb980',
});
export const HOST_DARK = Object.freeze({
  light: false, bg: '#151517', surface: '#0f1115', panel: '#1f2433', panel2: '#253047',
  border: '#253047', text: '#e8edff', muted: '#acb5cf', faint: '#7a859e',
  accent: '#4d6bfe', accentSoft: '#1f2a44', danger: '#fc5c5c', ok: '#97b552',
  info: '#5ab1ef', warn: '#ffb980',
});

/** 当前宿主色板：?theme=light|dark 可强制（截图/回归用），否则跟随系统。 */
export function hostPalette() {
  if (typeof window === 'undefined') return HOST_LIGHT;
  const forced = new URLSearchParams(window.location?.search ?? '').get('theme');
  if (forced === 'light') return HOST_LIGHT;
  if (forced === 'dark') return HOST_DARK;
  const dark = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? HOST_DARK : HOST_LIGHT;
}

/** 把宿主色板写进 --sd-* 变量。 */
export function applyHostVars(root) {
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!el || !el.style) return null;
  const p = hostPalette();
  const map = {
    '--sd-bg': p.bg, '--sd-surface': p.surface, '--sd-panel': p.panel, '--sd-panel2': p.panel2,
    '--sd-border': p.border, '--sd-text': p.text, '--sd-muted': p.muted, '--sd-faint': p.faint,
    '--sd-accent': p.accent, '--sd-accent-soft': p.accentSoft,
    '--sd-danger': p.danger, '--sd-ok': p.ok, '--sd-info': p.info, '--sd-warn': p.warn,
  };
  for (const [k, v] of Object.entries(map)) el.style.setProperty(k, v);
  el.style.setProperty('color-scheme', p.light ? 'light' : 'dark');
  return p;
}
