/**
 * handoff-view.js —— 交接页：浏览交接文档指针（只读）。
 *
 * 数据来源（复用现有只读接口，不改后端；无 /api/handoffs 端点时沿用指针记录方案）：
 * - 交接列表：GET api/records?q=handoff&status=all 里 predicate=handoff 的指针记录，
 *   value 字段是落盘路径（docs/handoffs/ 或 $MEMO_HOME/handoffs/）
 * - 正文：点击一项后 GET api/records?q=<文件名>，命中的记录正文按 markdown 摘要渲染
 *
 * 布局：顶部 .page-head；左 .task-list（.task-item：.tt 文件名 / .tm 元信息）+ 右 .md 摘要。
 * 安全约定：只读；所有接口数据一律 textContent / createElement，禁用 HTML 字符串拼接。
 */
import { el } from './dom.js';

/**
 * 从一条指针记录里取落盘路径；predicate 不是 handoff 时返回空串（防御式）。
 * @param {object} record
 * @returns {string}
 */
export function pickHandoffPath(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.predicate !== 'handoff') return '';
  const v = record.value;
  return typeof v === 'string' ? v : '';
}

/** 路径的文件名部分（含扩展名）；非字符串或空串时返回空串。 */
export function baseName(path) {
  const s = String(path ?? '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 一条指针记录 → 列表行数据（时间 / 任务 id / 路径）。
 * @param {object} record
 * @returns {{ts: string, sessionId: string, path: string, label: string}}
 */
export function buildHandoffRow(record) {
  const ts = String(record?.createdAt ?? record?.ts ?? '');
  const sessionId = String(record?.source?.session ?? record?.session ?? '');
  const path = pickHandoffPath(record);
  return { ts, sessionId, path, label: `${ts || '–'} · ${sessionId || '未知任务'} · ${path}` };
}

/**
 * 极简 markdown → DOM（只认标题/列表/代码块/段落；全部 createElement + textContent）。
 * 不追求完整 markdown 覆盖，够交接文档摘要展示即可；未知语法按普通段落原样展示。
 * @param {Element} container 渲染目标（会被清空）
 * @param {string} text markdown 文本
 */
export function renderMarkdown(container, text) {
  container.replaceChildren();
  const lines = String(text ?? '').split(/\r?\n/);
  let i = 0;
  const flushPar = (buf) => {
    if (buf.length === 0) return;
    container.append(el('p', '', buf.join('\n')));
    buf.length = 0;
  };
  const par = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flushPar(par);
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i += 1; }
      container.append(el('pre', '', code.join('\n')));
      i += 1; // 跳过闭合 ```
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPar(par);
      const level = Math.min(h[1].length + 1, 4); // # → h2，## → h3（.md 已定义样式）
      container.append(el(`h${level}`, '', h[2]));
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPar(par);
      const ul = el('ul');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        ul.append(el('li', '', lines[i].replace(/^\s*[-*]\s+/, '')));
        i += 1;
      }
      container.append(ul);
      continue;
    }
    if (line.trim() === '') { flushPar(par); i += 1; continue; }
    par.push(line);
    i += 1;
  }
  flushPar(par);
}

/**
 * 挂载交接页（app.js 懒加载后调用；apiGet 由 app.js 注入，自动带当前 scope）。
 * @param {{container: Element, apiGet: Function}} deps
 * @returns {Promise<void>}
 */
export async function mountHandoffView({ container, apiGet }) {
  container.replaceChildren();


  let data;
  try {
    data = await apiGet('/records?q=handoff&status=all');
  } catch (err) {
    container.append(el('div', 'err', `加载失败 · ${err.message}`));
    return;
  }

  const rows = (Array.isArray(data?.records) ? data.records : [])
    .filter((r) => pickHandoffPath(r) !== '')
    .map(buildHandoffRow)
    .sort((a, b) => b.ts.localeCompare(a.ts));
  if (rows.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'big', '没有交接文档'));
    empty.append(el('div', '', '任务关闭（session close）后会生成交接指针，出现在这里。'));
    container.append(empty);
    return;
  }

  // 左列表 + 右正文两栏（.split.list）
  const layout = el('div', 'split list');
  const listBox = el('div', 'card');
  const cardH = el('div', 'card-h');
  cardH.append(el('h4', '', `交接文档（${rows.length}）`));
  listBox.append(cardH);
  const list = el('div', 'task-list');
  listBox.append(list);
  const detail = el('div', 'card task-detail');
  const detailEmpty = el('div', 'empty');
  detailEmpty.append(el('div', 'big', '选择一份交接文档'));
  detailEmpty.append(el('div', '', '点击左侧一项查看 markdown 摘要。'));
  detail.append(detailEmpty);
  layout.append(listBox, detail);
  container.append(layout);

  for (const row of rows) {
    const item = el('button', 'task-item');
    item.type = 'button';
    item.append(el('div', 'tt', baseName(row.path)));
    const tm = el('div', 'tm');
    tm.textContent = `${row.sessionId || '未知任务'} · ${row.ts || '–'}`;
    item.append(tm);
    item.addEventListener('click', () => showHandoff(detail, apiGet, row, item, list));
    list.append(item);
  }
}

/** 按文件名搜记录，把命中的正文按 markdown 摘要渲染进 detail。 */
async function showHandoff(detail, apiGet, row, item, list) {
  for (const n of list.children) n.classList.toggle('active', n === item);
  const name = baseName(row.path);
  const tb = el('div', 'tb');
  const loading = el('p', 'dim', '加载中…');
  tb.append(loading);
  renderDetailHead(detail, row, tb);

  let data;
  try {
    data = await apiGet(`/records?q=${encodeURIComponent(name)}&status=all`);
  } catch (err) {
    tb.replaceChildren(el('div', 'err', `加载失败 · ${err.message}`));
    return;
  }
  const hits = Array.isArray(data?.records) ? data.records : [];
  if (hits.length === 0) {
    tb.replaceChildren(el('p', 'dim', `没有按「${name}」命中的记录。`));
    return;
  }
  // 多条命中时按记录逐块拼接（\n\n 分隔）；正文交给 renderMarkdown（纯 DOM 构建）
  const text = hits
    .map((r) => String(r?.text ?? r?.value ?? ''))
    .filter((t) => t !== '')
    .join('\n\n');
  tb.replaceChildren();
  const md = el('div', 'md');
  tb.append(md);
  renderMarkdown(md, text);
}

/** 详情头部：.th（路径大标题）+ 会话元信息。 */
function renderDetailHead(detail, row, tb) {
  const th = el('div', 'th');
  const thText = el('div');
  thText.append(el('h3', '', baseName(row.path)));
  if (row.sessionId) {
    thText.append(el('div', 'faint mono', row.sessionId));
  }
  th.append(thText);
  const badge = el('span', 'badge', 'handoff');
  th.append(badge);
  detail.replaceChildren(th, tb);
}
