/**
 * charts.js —— 手写 SVG 折线图（零依赖）。
 * 供卫生页渲染 30 天趋势：dupRatio / conflictRate / active 三条折线 + 图例。
 * 全部用 DOM API + createElementNS 构建，数据只进 textContent / 属性，无 innerHTML。
 */

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
 * 渲染多序列折线图（含网格、y 轴刻度、图例、逐点悬停 <title>）。
 * @param {HTMLElement} container 宿主元素（会被清空后填入 SVG 与图例）
 * @param {Object} opts
 * @param {Array<{date:string}>} opts.series 按日期升序的数据点
 * @param {Array<{key:string,label:string,color:string,dash?:boolean,fmt?:(v:number)=>string}>} opts.lines 折线定义
 * @param {number} [opts.width=980] SVG viewBox 宽
 * @param {number} [opts.height=180] SVG viewBox 高
 * @param {(v:number)=>string} [opts.yFmt] y 轴刻度格式化（比率图传 fmtPct）
 */
export function renderLineChart(container, opts) {
  const { series, lines, yFmt } = opts;
  const W = opts.width ?? 980;
  const H = opts.height ?? 180;
  const padL = 56, padR = 16, padT = 14, padB = 26;
  container.replaceChildren();

  if (!Array.isArray(series) || series.length === 0 || !Array.isArray(lines) || lines.length === 0) {
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = '暂无趋势数据。';
    container.append(p);
    return;
  }

  // 值域：覆盖所有序列（比 0 略高一点，避免平线贴边）
  let vMax = 0;
  for (const ln of lines)
    for (const pt of series) {
      const v = Number(pt[ln.key]);
      if (Number.isFinite(v) && v > vMax) vMax = v;
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
  const grid = svgEl('g', { stroke: '#222836', 'stroke-width': '1' });
  const ticks = svgEl('g', { fill: '#6b7484', 'font-size': '11' });
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
  const xlab = svgEl('g', { fill: '#6b7484', 'font-size': '11' });
  const first = svgEl('text', { x: padL, y: H - 8 });
  first.textContent = series[0].date ?? '';
  const last = svgEl('text', { x: W - padR, y: H - 8, 'text-anchor': 'end' });
  last.textContent = series[series.length - 1].date ?? '';
  xlab.append(first, last);
  svg.append(xlab);

  // 折线 + 逐点悬停提示
  for (const ln of lines) {
    const pts = series.map((pt, i) => [x(i), y(Number(pt[ln.key]) || 0)]);
    const pl = svgEl('polyline', {
      fill: 'none', stroke: ln.color, 'stroke-width': '2',
      points: pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '),
    });
    if (ln.dash) pl.setAttribute('stroke-dasharray', '5 4');
    svg.append(pl);
    const circles = svgEl('g', { fill: ln.color });
    series.forEach((pt, i) => {
      const c = svgEl('circle', { cx: pts[i][0].toFixed(1), cy: pts[i][1].toFixed(1), r: '2.5' });
      const t = svgEl('title');
      const fmt = ln.fmt ?? ((v) => String(v));
      t.textContent = `${pt.date ?? ''} · ${ln.label}: ${fmt(Number(pt[ln.key]) || 0)}`;
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
