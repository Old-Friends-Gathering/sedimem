/**
 * handoff-view.js —— 交接页（W8）：浏览交接文档指针（只读）。
 *
 * 数据来源（复用现有只读接口，不改后端）：
 * - 交接列表：GET api/records?q=handoff&status=all 里 predicate=handoff 的指针记录，
 *   value 字段是落盘路径（docs/handoffs/ 或 $MEMO_HOME/handoffs/）
 * - 正文：点击一项后 GET api/records?q=<文件名>，命中的记录正文用 <pre> 展示
 *
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
function baseName(path) {
  const s = String(path ?? '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 一条指针记录 → 列表行数据（时间 / 会话 id / 路径）。
 * @param {object} record
 * @returns {{ts: string, sessionId: string, path: string, label: string}}
 */
export function buildHandoffRow(record) {
  const ts = String(record?.createdAt ?? record?.ts ?? '');
  const sessionId = String(record?.source?.session ?? record?.session ?? '');
  const path = pickHandoffPath(record);
  return { ts, sessionId, path, label: `${ts || '–'} · ${sessionId || '未知会话'} · ${path}` };
}

/** 顶部只读说明。 */
function renderNote(container) {
  const note = el('p', 'dim');
  note.textContent = '交接文档落盘在 docs/handoffs/ 或 $MEMO_HOME/handoffs/，UI 只读展示';
  container.append(note);
}

/**
 * 挂载交接页（app.js 懒加载后调用；apiGet 由 app.js 注入，自动带当前 scope）。
 * @param {{container: Element, apiGet: Function}} deps
 * @returns {Promise<void>}
 */
export async function mountHandoffView({ container, apiGet }) {
  container.replaceChildren();
  renderNote(container);

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
    container.append(el('p', 'dim', '主库里没有 predicate=handoff 的指针记录。'));
    return;
  }

  // 左列表 + 右正文两栏
  const layout = el('div', 'handoff-layout');
  const listBox = el('div', 'card handoff-list');
  const detail = el('div', 'card handoff-detail');
  detail.append(el('p', 'dim', '点击左侧一项查看对应交接文档的记录正文。'));
  layout.append(listBox, detail);
  container.append(layout);

  for (const row of rows) {
    const item = el('button', 'handoff-item');
    item.type = 'button';
    item.textContent = row.label;
    item.addEventListener('click', () => showHandoff(detail, apiGet, row));
    listBox.append(item);
  }
}

/** 按文件名搜记录，把命中的正文渲染进 detail（<pre> + textContent）。 */
async function showHandoff(detail, apiGet, row) {
  const name = baseName(row.path);
  detail.replaceChildren(el('h3', 'h3', row.path), el('p', 'dim', '加载中…'));
  let data;
  try {
    data = await apiGet(`/records?q=${encodeURIComponent(name)}&status=all`);
  } catch (err) {
    detail.replaceChildren(el('div', 'err', `加载失败 · ${err.message}`));
    return;
  }
  detail.replaceChildren(el('h3', 'h3', row.path));
  const hits = Array.isArray(data?.records) ? data.records : [];
  if (hits.length === 0) {
    detail.append(el('p', 'dim', `没有按「${name}」命中的记录。`));
    return;
  }
  if (row.sessionId) {
    const meta = el('div', 'm', '');
    meta.textContent = `会话：${row.sessionId}`;
    detail.append(meta);
  }
  const pre = el('pre', 'handoff-content');
  // 多条命中时按记录逐块拼接；正文全部经 textContent 写入，不做任何 HTML 解析
  pre.textContent = hits
    .map((r) => String(r?.text ?? r?.value ?? ''))
    .filter((t) => t !== '')
    .join('\n\n');
  detail.append(pre);
}
