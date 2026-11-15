/**
 * graph-style.js —— 图谱的「线/点」绘制参数（与绘制循环分离，便于单测与控行数）。
 * 深色/浅色差异统一走 palette.js 的三个纯函数，这里只负责把深度雾化与线型组合成参数。
 */
import { contrastColor, fogAlphaFloor, PALETTES } from './palette.js';

const { DARKEN } = PALETTES;

/** 四类边的线型与基色（基色按深色底取，浅色底由 contrastColor 压暗）。 */
export const EDGE_STYLE = Object.freeze({
  'same-entity': { color: 'rgba(148,163,184,0.5)', dash: [], width: 1 },
  supersedes: { color: 'rgba(100,116,139,0.7)', dash: [6, 3], width: 1.25 },
  'duplicate-of': { color: '#f97316', dash: [7, 5], width: 1 },
  'disputed-with': { color: '#ef4444', dash: [2, 4], width: 1.25 },
});

const FALLBACK = EDGE_STYLE['same-entity'];

/** 取某类边的线型（未知类型回退 same-entity）。 */
export function edgeStyleFor(type) {
  return EDGE_STYLE[type] || FALLBACK;
}

/** 边的最终描边色（浅色下压暗，深色原样）。 */
export function edgeStrokeColor(type, pal) {
  return contrastColor(edgeStyleFor(type).color, pal, DARKEN.edge);
}

/** 边的深度雾化 alpha：远侧更淡，但浅色底有更高的下限（否则线看不见）。 */
export function edgeAlpha(depth, pal) {
  const floor = fogAlphaFloor('edge', pal);
  return Math.max(floor, Math.min(1, (depth - 0.78) / 0.5));
}

/** 节点深度雾化 alpha：背面更淡，浅色底抬高下限。 */
export function nodeAlpha(persp, pal, superseded = false) {
  const floor = fogAlphaFloor('node', pal);
  const fog = Math.max(floor, Math.min(1, (persp - 0.72) / 0.55));
  const dim = superseded ? (pal && pal.light ? 0.62 : 0.4) : 1;
  return dim * fog;
}

/** 节点半径：命中次数开方 + 基数（纯函数，便于单测与控行数）。 */
export function nodeRadius(nd) {
  return Math.sqrt(Math.max(Number(nd && nd.hits) || 0, 0)) + 3;
}

/** 节点填充色（浅色下压暗，保证在浅底上有对比）。 */
export function nodeFillColor(baseColor, pal) {
  return contrastColor(baseColor, pal, DARKEN.node);
}
