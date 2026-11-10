/**
 * palette.js —— 画布配色跟随系统外观（与 style.css 的 prefers-color-scheme 同步）。
 * 每次绘制时调用 uiPalette()（读 matchMedia 很便宜），系统切换深浅后下一帧即生效，
 * 无需刷新页面。
 */

/** 深色与浅色两套画布色。字段与 style.css 的 --node-* / --grid 一一对应。 */
const DARK = {
  nodeFg: '#cfd6e4',   // 活跃节点
  nodeDim: '#8b93a3',  // superseded 节点
  label: '#475569',    // 节点标签
  grid: '#262b36',     // 参考线/坐标
  badge: '#e7e9ee',    // ×N 徽标
  bg: '#11141b',
};

const LIGHT = {
  nodeFg: '#1f2430',
  nodeDim: '#8b93a3',
  label: '#475569',
  grid: '#dce0e7',
  badge: '#1f2430',
  bg: '#f5f6f8',
};

/**
 * @returns {{nodeFg:string,nodeDim:string,label:string,grid:string,badge:string,bg:string}}
 *          当前系统外观对应的画布配色。
 */
export function uiPalette() {
  const dark = typeof matchMedia === 'function'
    ? matchMedia('(prefers-color-scheme: dark)').matches
    : true;
  return dark ? DARK : LIGHT;
}
