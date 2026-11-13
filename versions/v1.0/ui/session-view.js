/**
 * session-view.js —— 会话页（W8）：浏览 session:* 临时分库（只读）。
 *
 * 数据来源（全部复用现有只读接口，不改后端）：
 * - 会话列表：GET api/scopes 里 scope 以 `session:` 开头的分库（records 计数直接用列表返回值）
 * - 会话详情：GET api/records?scope=<session 库>&status=active，按 kind 分组展示
 *
 * 安全约定：只读、无写操作；所有接口数据一律 textContent / createElement 写入，
 * 禁用 HTML 字符串拼接与 eval。state 记录的 8 段 checkpoint 用 <pre> 渲染。
 */
import { el } from './dom.js';

/** checkpoint 的 8 段固定顺序（与会话临时库契约一致）。 */
const CHECKPOINT_SECTIONS = [
  'intent', 'concepts', 'files', 'errorsAndFixes',
  'pendingJobs', 'currentState', 'nextSteps', 'criticalContext',
];

/**
 * 把记录数组按 kind 分组（保持出现顺序）。
 * @param {Array<object>} records
 * @returns {Object<string, Array<object>>} kind → records（输入非数组时返回 {}）
 */
export function groupByKind(records) {
  const out = {};
  if (!Array.isArray(records)) return out;
  for (const r of records) {
    const kind = typeof r?.kind === 'string' && r.kind !== '' ? r.kind : 'unknown';
    (out[kind] ??= []).push(r);
  }
  return out;
}

/** 单段 checkpoint 值 → 多行文本（数组逐行、对象 JSON、其余 String）。 */
function sectionText(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

/**
 * state 记录 → 8 段 checkpoint 的纯文本（用 <pre> + textContent 展示，天然免疫注入）。
 * checkpoint 缺失或不是对象时回退到 record.text。
 * @param {object} record
 * @returns {string}
 */
export function formatCheckpoint(record) {
  const cp = record?.checkpoint;
  if (!cp || typeof cp !== 'object' || Array.isArray(cp)) return String(record?.text ?? '');
  const lines = [];
  for (const key of CHECKPOINT_SECTIONS) {
    if (cp[key] === undefined || cp[key] === null) continue; // 未给的段不出现；空数组段保留标题
    const body = sectionText(cp[key]);
    lines.push(`## ${key}`, body, '');
  }
  return lines.join('\n').trimEnd();
}

/**
 * 一条会话分库 → 列表行数据（scope + 记录数）。
 * @param {string} scope
 * @param {{records?: number}} [stats] —— /api/scopes 的单条分库对象
 * @returns {{scope: string, records: number, label: string}}
 */
export function buildSessionRow(scope, stats) {
  const records = Number(stats?.records ?? 0) || 0;
  return { scope: String(scope ?? ''), records, label: `${scope} · ${records} 条记录` };
}

/** 顶部只读说明（会话库可丢弃，关闭走 CLI，UI 不提供按钮）。 */
function renderNote(container) {
  const note = el('p', 'dim');
  note.textContent = '会话库是临时记忆（可丢弃）。关闭会话请用 CLI：`memo session close <id>`（UI 只读，不提供按钮）';
  container.append(note);
}

/**
 * 挂载会话页（app.js 懒加载后调用；apiGet 由 app.js 注入，自动带当前 scope）。
 * @param {{container: Element, apiGet: Function}} deps
 * @returns {Promise<void>}
 */
export async function mountSessionView({ container, apiGet }) {
  container.replaceChildren();
  renderNote(container);

  let data;
  try {
    data = await apiGet('/scopes');
  } catch (err) {
    container.append(el('div', 'err', `加载失败 · ${err.message}`));
    return;
  }

  const sessions = (Array.isArray(data?.scopes) ? data.scopes : [])
    .filter((s) => typeof s?.scope === 'string' && s.scope.startsWith('session:'));
  if (sessions.length === 0) {
    container.append(el('p', 'dim', '当前没有会话临时库（session:*）。'));
    return;
  }

  // 左列表 + 右详情两栏
  const layout = el('div', 'session-layout');
  const listBox = el('div', 'card session-list');
  const detail = el('div', 'card session-detail');
  detail.append(el('p', 'dim', '点击左侧会话查看其中的记录。'));
  layout.append(listBox, detail);
  container.append(layout);

  for (const s of sessions) {
    const row = buildSessionRow(s.scope, s);
    const item = el('button', 'session-item');
    item.type = 'button';
    item.textContent = row.label;
    item.addEventListener('click', () => showSession(detail, apiGet, row.scope));
    listBox.append(item);
  }
}

/** 拉取一个会话库的 active 记录并按 kind 分组渲染进 detail。 */
async function showSession(detail, apiGet, scope) {
  detail.replaceChildren(el('h3', 'h3', scope), el('p', 'dim', '加载中…'));
  let data;
  try {
    // 显式 scope 放在最前：服务端取第一个 scope 参数，覆盖 api() 追加的当前分库
    data = await apiGet(`/records?scope=${encodeURIComponent(scope)}&status=active`);
  } catch (err) {
    detail.replaceChildren(el('div', 'err', `加载失败 · ${err.message}`));
    return;
  }
  detail.replaceChildren(el('h3', 'h3', scope));
  const grouped = groupByKind(data?.records);
  const kinds = Object.keys(grouped);
  if (kinds.length === 0) {
    detail.append(el('p', 'dim', '该会话库没有 active 记录。'));
    return;
  }
  for (const kind of kinds) {
    const group = el('div', 'session-kind');
    group.append(el('h4', 'h4', `${kind}（${grouped[kind].length}）`));
    for (const r of grouped[kind]) group.append(renderRecord(r));
    detail.append(group);
  }
}

/** 单条记录：state → <pre> checkpoint；其余 → 一行正文（textContent）。 */
function renderRecord(r) {
  const box = el('div', 'session-record');
  if (r?.kind === 'state') {
    const pre = el('pre', 'session-checkpoint');
    pre.textContent = formatCheckpoint(r);
    box.append(pre);
    return box;
  }
  const text = el('div', 'session-text');
  text.textContent = String(r?.text ?? r?.value ?? '');
  if (r?.title) {
    const t = el('div', 'm', '');
    t.textContent = String(r.title);
    box.append(t);
  }
  box.append(text);
  return box;
}
