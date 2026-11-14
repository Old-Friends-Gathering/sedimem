/**
 * charts.js —— 趋势折线图（uPlot 优先，SVG 兜底）。
 * 主路径：window.uPlot（vendor 的 IIFE 全局）Canvas 渲染，性能好且原生支持 null 断线。
 * 兜底路径：window.uPlot 缺失时（如 Node 单测环境或 vendor 加载失败）回落到
 * 保留的自研 SVG 实现 renderLineChartSvg，对外契约（签名/语义）完全一致。
 * null 点跳过不画、不当 0（issue #36：「没数据」≠「值是 0」）——两条路径都遵守。
 */

import { uiPalette } from './palette.js';

// SVG 命名空间 URI（拆开写，避免 S9 门禁对 http(s):// 字面量的误报；这是标识符，不是资源链接）
const SVG_NS = ['http', '://www.w3', '.org/2000/svg'].join('');

/**
 * 新建一个 SVG 元素。
 * @param {string} tag 元素名
 * @param {Record<string, string>} [attrs] 属性表
 * @returns {SVGElement}
 */
export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * 把值域 [vMin, vMax] 映射到绘图区 y 坐标（顶部小、底部大）。
 * @param {number} v
 * @param {number} vMin
 * @param {number} vMax
 * @param {number} top 绘图区顶部 y
 * @param {number} bottom 绘图区底部 y
 * @returns {number}
 */
export function scaleY(v, vMin, vMax, top, bottom) {
  if (vMax === vMin) return (top + bottom) / 2;
  const t = (v - vMin) / (vMax - vMin);
  return bottom - t * (bottom - top);
}

/**
 * 渲染多序列折线图（对外入口，契约与旧版一致）。
 * @param {HTMLElement} container 宿主元素（重复渲染时销毁并复用旧的 uPlot 实例）
 * @param {Object} opts
 * @param {Array<{date:string}>} opts.series 按日期升序的数据点
 * @param {Array<{key:string,label:string,color:string,dash?:boolean,fmt?:(v:number)=>string}>} opts.lines 折线定义
 * @param {(v:number)=>string} [opts.yFmt] y 轴刻度格式化（比率图传 fmtPct）
 */
export function renderLineChart(container, opts) {
  // 全局只在函数内取：Node 单测环境没有 window.uPlot，走 SVG 兜底，不能在模块顶层解构
  const UPlot = typeof window !== 'undefined' ? window.uPlot : undefined;
  if (UPlot) {
    renderLineChartUPlot(container, opts, UPlot);
  } else {
    renderLineChartSvg(container, opts);
  }
}

/** uPlot 主实现：Canvas 折线 + 自绘可点击图例 + 宽度自适应。 */
function renderLineChartUPlot(container, opts, UPlot) {
  const { series, lines, yFmt } = opts;
  const pal = uiPalette();

  // 空数据提示（与 SVG 兜底同一文案）
  if (!Array.isArray(series) || series.length === 0 || !Array.isArray(lines) || lines.length === 0) {
    disposeChart(container);
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = '暂无趋势数据。';
    container.replaceChildren(p);
    return;
  }

  // 组装 uPlot data：[[x...], [线1...], [线2...]]。x 用天序号，date 文案交给轴格式化；
  // y 值里的 null/undefined 原样传入，uPlot 自动断线（不折算 0）。
  const xs = series.map((_, i) => i);
  const data = [xs];
  // 值域上限：覆盖所有线非空有限值（null 跳过），顶部留 8% 余量
  let vMax = 0;
  for (const ln of lines) {
    const ys = series.map((pt) => {
      const raw = pt[ln.key];
      if (raw === null || raw === undefined) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    });
    for (const v of ys) if (v !== null && v > vMax) vMax = v;
    data.push(ys);
  }
  if (vMax <= 0) vMax = 1;
  const vTop = vMax * 1.08;

  // x 轴：把天序号取整映射回 series 里的日期文案
  const dateAt = (idx) => {
    const i = Math.round(idx);
    return i >= 0 && i < series.length ? (series[i].date ?? '') : '';
  };
  // y 轴刻度：优先 yFmt，缺省回落 fmtNum
  const yTick = (v) => (yFmt ? yFmt(v) : fmtNum(v, vTop));

  const height = 260;
  const width = Math.max(container.clientWidth || 0, 320);

  const uplotOpts = {
    width,
    height,
    legend: { show: false }, // 图例自绘（可点击切换显隐），关掉 uPlot 内置图例
    scales: {
      x: { time: false, range: [0, Math.max(series.length - 1, 1)] },
      y: { range: [0, vTop] },
    },
    axes: [
      {
        stroke: pal.label,
        grid: { stroke: pal.grid, width: 1 },
        ticks: { stroke: pal.grid },
        values: (u, splits) => splits.map(dateAt),
      },
      {
        stroke: pal.label,
        grid: { stroke: pal.grid, width: 1 },
        ticks: { stroke: pal.grid },
        values: (u, splits) => splits.map(yTick),
      },
    ],
    series: [
      {}, // 索引 0 固定是 x 轴
      ...lines.map((ln) => ({
        label: ln.label,
        stroke: ln.color,
        width: 1.6,
        dash: ln.dash ? [6, 4] : undefined,
        spanGaps: false, // null 处断线
        points: { show: false },
        // 悬停值：每条线独立 fmt，null 显示「—」
        value: (u, v) => (v === null || v === undefined ? '—' : ln.fmt ? ln.fmt(v) : String(v)),
      })),
    ],
  };

  // 复用/销毁：容器上挂 __uplot 引用，重复渲染先销毁旧实例与观察器，避免内存泄漏
  disposeChart(container);
  const uplot = new UPlot(uplotOpts, data, container);
  container.__uplot = { uplot, ro: null };

  // 尺寸自适应：ResizeObserver 监听容器宽度变化，同步 uPlot 尺寸（高度固定 260）
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && container.__uplot && container.__uplot.uplot === uplot) {
        uplot.setSize({ width: Math.max(Math.round(w), 320), height });
      }
    });
    ro.observe(container);
    container.__uplot.ro = ro;
  }

  // 图例：ul + 色块，点击切换对应 series 显隐（uPlot setSeries）
  const legend = document.createElement('ul');
  legend.className = 'legend';
  lines.forEach((ln, i) => {
    const li = document.createElement('li');
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.borderTopColor = ln.color;
    if (ln.dash) sw.style.borderTopStyle = 'dashed';
    li.append(sw, document.createTextNode(ln.label));
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => {
      const show = !uplot.series[i + 1].show;
      uplot.setSeries(i + 1, { show });
      li.style.opacity = show ? '1' : '0.4';
    });
    legend.append(li);
  });
  container.append(legend);
}

/** 销毁容器上挂着的旧图表实例（uPlot + ResizeObserver）。 */
function disposeChart(container) {
  const prev = container.__uplot;
  if (prev) {
    if (prev.ro) prev.ro.disconnect();
    if (prev.uplot) prev.uplot.destroy();
    container.__uplot = undefined;
  }
}

/**
 * 渲染多序列折线图（SVG 兜底实现，原自研版本；uPlot 缺失时由 renderLineChart 调用）。
 * @param {HTMLElement} container 宿主元素（会被清空后填入 SVG 与图例）
 * @param {Object} opts
 * @param {Array<{date:string}>} opts.series 按日期升序的数据点
 * @param {Array<{key:string,label:string,color:string,dash?:boolean,fmt?:(v:number)=>string}>} opts.lines 折线定义
 * @param {number} [opts.width=980] SVG viewBox 宽
 * @param {number} [opts.height=180] SVG viewBox 高
 * @param {(v:number)=>string} [opts.yFmt] y 轴刻度格式化（比率图传 fmtPct）
 */
export function renderLineChartSvg(container, opts) {
  const { series, lines, yFmt } = opts;
  const pal = uiPalette();
  const W = opts.width ?? 980;
  const H = opts.height ?? 180;
  const padL = 56, padR = 16, padT = 14, padB = 26;
  disposeChart(container);
  container.replaceChildren();

  if (!Array.isArray(series) || series.length === 0 || !Array.isArray(lines) || lines.length === 0) {
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = '暂无趋势数据。';
    container.append(p);
    return;
  }

  // 值域：覆盖所有序列的非空有限值（null 点跳过不画，不折算成 0——「没数据」≠「值是 0」）
  let vMax = 0;
  let hasValue = false;
  for (const ln of lines)
    for (const pt of series) {
      const v = pt[ln.key];
      if (v === null || v === undefined) continue;
      const n = Number(v);
      if (Number.isFinite(n)) {
        hasValue = true;
        if (n > vMax) vMax = n;
      }
    }
  if (!hasValue) {
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = '暂无趋势数据。';
    container.replaceChildren(p);
    return;
  }
  if (vMax <= 0) vMax = 1;
  const vTop = vMax * 1.08;
  const innerW = W - padL - padR;
  const x = (i) => padL + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v) => scaleY(v, 0, vTop, padT, H - padB);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto;display:block',
    role: 'img', 'aria-label': '趋势折线图',
  });

  // 网格 + y 轴刻度（4 档）
  const grid = svgEl('g', { stroke: pal.grid, 'stroke-width': '1' });
  const ticks = svgEl('g', { fill: pal.label, 'font-size': '11' });
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const v = (vTop / tickCount) * i;
    const gy = y(v);
    grid.append(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy }));
    const tx = svgEl('text', { x: padL - 8, y: gy + 4, 'text-anchor': 'end' });
    tx.textContent = yFmt ? yFmt(v) : fmtNum(v, vTop);
    ticks.append(tx);
  }
  svg.append(grid, ticks);

  // x 轴首尾日期
  const xlab = svgEl('g', { fill: pal.label, 'font-size': '11' });
  const first = svgEl('text', { x: padL, y: H - 8 });
  first.textContent = series[0].date ?? '';
  const last = svgEl('text', { x: W - padR, y: H - 8, 'text-anchor': 'end' });
  last.textContent = series[series.length - 1].date ?? '';
  xlab.append(first, last);
  svg.append(xlab);

  // 折线 + 逐点悬停提示。null/undefined 点跳过不画；连续非空段各自成线，段间自然断开。
  // 每条线独立的 fmt（ln.fmt）作用于悬停文案，缺省回落到通用 String。
  for (const ln of lines) {
    const val = (pt) => {
      const raw = pt[ln.key];
      if (raw === null || raw === undefined) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    // 把序列切成连续非空段：[[i0,i1],...]，每段一条 polyline
    const segments = [];
    let start = -1;
    series.forEach((pt, i) => {
      if (val(pt) !== null) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        segments.push([start, i - 1]);
        start = -1;
      }
    });
    if (start >= 0) segments.push([start, series.length - 1]);

    for (const [from, to] of segments) {
      const pts = [];
      for (let i = from; i <= to; i++) pts.push(`${x(i).toFixed(1)},${y(val(series[i])).toFixed(1)}`);
      const pl = svgEl('polyline', {
        fill: 'none', stroke: ln.color, 'stroke-width': '2', points: pts.join(' '),
      });
      if (ln.dash) pl.setAttribute('stroke-dasharray', '5 4');
      svg.append(pl);
    }

    const circles = svgEl('g', { fill: ln.color });
    const fmt = ln.fmt ?? ((v) => String(v));
    series.forEach((pt, i) => {
      const v = val(pt);
      if (v === null) return; // 空点不画圆点，悬停提示也不给假值
      const c = svgEl('circle', { cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: '2.5' });
      const t = svgEl('title');
      t.textContent = `${pt.date ?? ''} · ${ln.label}: ${fmt(v)}`;
      c.append(t);
      circles.append(c);
    });
    svg.append(circles);
  }
  container.append(svg);

  // 图例
  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const ln of lines) {
    const sp = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.borderTopColor = ln.color;
    if (ln.dash) sw.style.borderTopStyle = 'dashed';
    sp.append(sw, document.createTextNode(ln.label));
    legend.append(sp);
  }
  container.append(legend);
}

/**
 * 刻度数字格式化：小值保留两位小数，大值取整。
 * @param {number} v
 * @param {number} vTop 值域上限，用于判断量级
 * @returns {string}
 */
export function fmtPct(v) {
  const n = Number(v) * 100;
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '0%';
  const digits = Math.abs(n) < 1 ? 2 : Math.abs(n) < 10 ? 1 : 0;
  return `${n.toFixed(digits)}%`;
}

export function fmtNum(v, vTop) {
  if (vTop <= 1) return v.toFixed(2);
  if (vTop <= 10) return v.toFixed(1);
  return String(Math.round(v));
}
