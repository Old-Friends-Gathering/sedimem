/**
 * settings-view.js —— 设置页（W8）：一屏讲清「这个库现在是怎么配置的」（只读）。
 *
 * 契约（与后端对齐，不新增接口）：
 * - GET api/summary  → { version, scope, memoHome, writeEnabled, policy:{ kinds, maxActive,
 *     nearDupThreshold, scanThreshold, scanDiceThreshold, ...可能缺 write/index/llm 段 } }
 * - GET api/hygiene  → { series:[{ date, dupRatio, conflictRate, active, ... }] }（健康数字取最近一条）
 *
 * summary 里没有的字段一律显示 —，语义道 summary 未下发 → 写「见 policy.llm」，不编造。
 * 安全约定：全部 createElement / textContent 渲染，禁 HTML 字符串拼接与动态执行。
 * 结构约定（设计系统）：.card > .card-h(h3 + .badge) > .card-b；键值用 .set-grid/.kv，
 * kind 注册表用 table（色块 .dotk + 色值文本），健康用 .kpis/.kpi。
 */

const MISSING = '—';

/* ---------------- 纯函数（node 可测） ---------------- */

/**
 * 策略值格式化：null/undefined → —；boolean → 是/否；数字 → 十进制字符串；
 * 字符串原样；对象 → JSON 一行（valueRecommendChars 等契约字段都是标量，对象兜底防崩）。
 * @param {unknown} v
 * @returns {string}
 */
export function formatPolicyValue(v) {
  if (v === null || v === undefined) return MISSING;
  if (v === true) return '是';
  if (v === false) return '否';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : MISSING;
  if (typeof v === 'string') return v === '' ? MISSING : v;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return MISSING; }
  }
  return MISSING;
}

/**
 * summary → 分组行（设置页的数据形状，node 可测、DOM 无关）。
 * 每组 { title, rows: [{ k, v, badge? }] }；badge = 'ok'（可写）/ 'ro'（只读）时渲染徽标。
 * @param {object|null} summary GET api/summary 的返回体
 * @returns {Array<{title: string, rows: Array<{k: string, v: string, badge?: string}>}>}
 */
export function rowsForSummary(summary) {
  const s = (summary && typeof summary === 'object') ? summary : {};
  const pol = (s.policy && typeof s.policy === 'object') ? s.policy : {};
  const write = (pol.write && typeof pol.write === 'object') ? pol.write : {};
  const index = (pol.index && typeof pol.index === 'object') ? pol.index : {};
  const llm = (pol.llm && typeof pol.llm === 'object') ? pol.llm : {};
  const fmt = formatPolicyValue;
  return [
    {
      title: '版本与分库',
      rows: [
        { k: 'version', v: fmt(s.version) },
        { k: 'scope', v: fmt(s.scope) },
        { k: 'memoHome', v: fmt(s.memoHome) },
        {
          k: 'writeEnabled',
          v: s.writeEnabled === true ? '可写' : '只读',
          badge: s.writeEnabled === true ? 'ok' : 'ro',
        },
      ],
    },
    {
      title: '写侧契约（policy.write）',
      rows: [
        { k: 'valueRecommendChars', v: fmt(write.valueRecommendChars) },
        { k: 'textHardMaxChars', v: fmt(write.textHardMaxChars) },
        { k: 'titleEnforce', v: fmt(write.titleEnforce) },
      ],
    },
    {
      title: '检索（policy.dedupe / index）',
      rows: [
        { k: 'dedupe.nearDupThreshold', v: fmt(pol.nearDupThreshold) },
        { k: 'dedupe.scanThreshold', v: fmt(pol.scanThreshold) },
        { k: 'dedupe.scanDiceThreshold', v: fmt(pol.scanDiceThreshold) },
        { k: 'index.backend', v: fmt(index.backend) },
        // summary 未下发语义道状态：如实指路，不编造「已启用/未启用」
        { k: '语义道', v: (llm.semantic ?? llm.enabled) != null ? fmt(llm.semantic ?? llm.enabled) : '见 policy.llm' },
      ],
    },
    {
      title: 'LLM 派生层（policy.kinds / llm）',
      rows: [
        {
          k: 'LLM 总结',
          v: llm.provider
            ? `provider=${llm.provider}`
            : '由 policy.llm.provider 决定，默认 none（关闭）',
        },
      ],
    },
  ];
}

/**
 * summary.policy.kinds → kind 表格行（表头单独返回）：kind / halfLifeMs / weight / color。
 * @param {object|null} kinds
 * @returns {{header: string[], rows: string[][]}}
 */
export function kindsTable(kinds) {
  if (!kinds || typeof kinds !== 'object') return { header: ['kind', 'halfLifeMs', 'weight', 'color'], rows: [] };
  const rows = Object.entries(kinds).map(([name, m]) => [
    name,
    formatPolicyValue(m?.halfLifeMs),
    formatPolicyValue(m?.weight),
    formatPolicyValue(m?.color),
  ]);
  return { header: ['kind', 'halfLifeMs', 'weight', 'color'], rows };
}

/**
 * hygiene → 最近一条健康指标行；series 为空/缺失时全 —。
 * @param {object|null} hygiene GET api/hygiene 的返回体
 * @returns {Array<{k: string, v: string}>}
 */
export function rowsForHygiene(hygiene) {
  const series = Array.isArray(hygiene?.series) ? hygiene.series : [];
  const last = series.length ? series[series.length - 1] : {};
  return [
    { k: '日期', v: formatPolicyValue(last.date) },
    { k: 'dupRatio', v: formatPolicyValue(last.dupRatio) },
    { k: 'conflictRate', v: formatPolicyValue(last.conflictRate) },
    { k: 'active', v: formatPolicyValue(last.active) },
  ];
}

/* ---------------- DOM 挂载 ---------------- */

/** el 的本地兜底：node 测试环境不 import dom.js，浏览器路径才用到。 */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** card 骨架：.card > .card-h(h3 + 右侧 .badge 状态) > .card-b。 */
function cardShell(title, badgeText, badgeClass) {
  const card = el('div', 'card');
  const head = el('div', 'card-h');
  head.append(el('h3', '', title));
  if (badgeText !== undefined && badgeText !== null) {
    head.append(el('span', `badge ${badgeClass ?? ''}`.trim(), badgeText));
  }
  const body = el('div', 'card-b');
  card.append(head, body);
  return { card, body };
}

/** 一组 k/v 行 → .kv（k 左列、v 右列等宽）；badge 行附徽标。 */
function kvBlock(rows) {
  const kv = el('div', 'kv');
  for (const row of rows) {
    kv.append(el('span', 'k', `${row.k}`));
    const val = el('span', 'v', row.v);
    if (row.badge === 'ok') val.append(el('span', 'badge b-ok', '可写'));
    else if (row.badge === 'ro') val.append(el('span', 'badge', '只读'));
    kv.append(val);
  }
  return kv;
}

/** kind 颜色串是否可安全用作 background（仅 #hex，其余不染色只留文本）。 */
function safeHex(c) {
  return /^#[0-9a-f]{3,8}$/i.test(String(c ?? '')) ? String(c) : null;
}

/** 「版本与分库」卡：card-h 带可写/只读徽标，body 为 .set-grid > .kv。 */
function versionCard(section) {
  const writable = section.rows.some((r) => r.badge === 'ok');
  const { card, body } = cardShell(
    section.title,
    writable ? '可写' : '只读',
    writable ? 'b-ok' : '',
  );
  const grid = el('div', 'set-grid');
  grid.append(kvBlock(section.rows));
  body.append(grid);
  return card;
}

/** 「写侧契约 / 检索阈值」卡：多个子组，每组 h4 小标 + .kv。 */
function policyCard(sections) {
  const { card, body } = cardShell('写侧契约 / 检索阈值', 'policy', 'b-info');
  for (const section of sections) {
    body.append(el('h4', 'h4', section.title));
    body.append(kvBlock(section.rows));
  }
  return card;
}

/** kind 注册表卡：table（KIND / HALFLIFE / WEIGHT / COLOR），色列前置 .dotk 色块。 */
function kindsCard(kinds) {
  const { header, rows } = kindsTable(kinds);
  const { card, body } = cardShell('kind 注册表', `${rows.length} 种`, '');
  const table = el('table', 'table');
  const thead = el('thead');
  const trh = el('tr');
  const displayHeader = header.map((h) => h === 'kind' ? 'KIND'
    : h === 'halfLifeMs' ? 'HALFLIFE' : h === 'weight' ? 'WEIGHT' : 'COLOR');
  for (const h of displayHeader) trh.append(el('th', '', h));
  thead.append(trh);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    r.forEach((c, i) => {
      if (header[i] === 'color' && safeHex(c)) {
        const td = el('td');
        const dot = el('span', 'dotk');
        dot.style.background = safeHex(c);
        td.append(dot, document.createTextNode(` ${c}`));
        tr.append(td);
      } else {
        tr.append(el('td', '', c));
      }
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  body.append(table);
  return card;
}

/** 健康卡：日期进头部徽标，dupRatio/conflictRate/active 渲染为 .kpis 三格。 */
function healthCard(hygiene) {
  const rows = rowsForHygiene(hygiene);
  const date = rows[0]?.v ?? MISSING;
  const { card, body } = cardShell('健康', date, '');
  const kpis = el('div', 'kpis');
  for (const row of rows.slice(1)) {
    const kpi = el('div', 'kpi');
    kpi.append(el('div', 'v', row.v), el('div', 'k', row.k));
    kpis.append(kpi);
  }
  body.append(kpis);
  return card;
}

/**
 * 挂载设置页：并行取 summary + hygiene，渲染只读卡片组；失败整段显示错误文案。
 * @param {{container: HTMLElement, api: (path: string) => Promise<object>}} args
 */
export async function mountSettingsView({ container, api: apiGet }) {
  container.replaceChildren(el('p', 'dim', '加载中…'));
  let summary = null;
  let hygiene = null;
  try {
    const [s, h] = await Promise.all([
      apiGet('/summary'),
      apiGet('/hygiene').catch(() => null), // 健康段失败不拖垮整页，卡片内显示 —
    ]);
    summary = s;
    hygiene = h;
  } catch (err) {
    container.replaceChildren(el('p', 'err', `加载失败：${err?.message ?? String(err)}`));
    return;
  }
  const groups = rowsForSummary(summary);
  container.replaceChildren(
    versionCard(groups[0]),
    policyCard(groups.slice(1)),
    kindsCard(summary?.policy?.kinds),
    healthCard(hygiene),
  );
}

/** W8 共享懒加载器 loadLazyView 的统一入口（app.js 只认 mount）。 */
export function mount({ container, apiGet }) {
  return mountSettingsView({ container, api: apiGet });
}
