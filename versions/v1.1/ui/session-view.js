/**
 * session-view.js —— 任务页：按任务标题浏览 / 管理任务库（session:*）。
 *
 * 数据来源（全部复用现有接口，不改后端）：
 * - 任务列表：GET /api/tasks → {tasks:[{scope,id,title,status,startedAt,closedAt,records,updatedAt}]}
 * - 任务详情：GET /api/records?scope=<session 库>&status=active，按 kind 分组展示
 * - 写操作（rename / remove / tombstone）走 fetch POST（credentials:'same-origin' + JSON body），
 *   仅在 /api/summary 的 writeEnabled===true 时可用，否则按钮 disabled。
 *
 * 安全约定：所有接口数据一律 textContent / createElement 写入，
 * 禁用 HTML 字符串拼接与 eval（Q9 门禁）。checkpoint 记录渲染成 .cp 里的 .kv 八段表格。
 */
import { el } from './dom.js';

/** checkpoint 的 8 段固定顺序（与任务库契约一致）。 */
export const CHECKPOINT_SECTIONS = [
  'intent', 'concepts', 'files', 'errorsAndFixes',
  'pendingJobs', 'currentState', 'nextSteps', 'criticalContext',
];

/** writeEnabled=false 时写操作按钮的 title 提示。 */
export const READ_ONLY_HINT = '用 memo serve --write 启动才可写';

/* ---------------- 纯函数（可单测） ---------------- */

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
 * 记录 → checkpoint 对象（或 null）。
 * /api/records 的投影不带 checkpoint 字段（真相层只存 value 字符串），
 * 所以先看 record.checkpoint，再把 value 当 JSON 解析；
 * 只有真含 checkpoint 段的 JSON 才算（session meta 也是 JSON，不能当 checkpoint 渲染）。
 * @param {object} record
 * @returns {object|null}
 */
export function parseCheckpoint(record) {
  let cp = record?.checkpoint;
  if ((!cp || typeof cp !== 'object') && typeof record?.value === 'string' && record.value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(record.value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && CHECKPOINT_SECTIONS.some((k) => parsed[k] !== undefined)) cp = parsed;
    } catch { /* 不是 checkpoint JSON */ }
  }
  return cp && typeof cp === 'object' && !Array.isArray(cp) ? cp : null;
}

/**
 * state 记录 → 8 段 checkpoint 的纯文本（兼容旧渲染路径；详情页现在用 parseCheckpoint + .kv 表格）。
 * checkpoint 缺失或不是对象时回退到 record.text。
 * @param {object} record
 * @returns {string}
 */
export function formatCheckpoint(record) {
  const cp = parseCheckpoint(record);
  if (!cp) return String(record?.text ?? '');
  const lines = [];
  for (const key of CHECKPOINT_SECTIONS) {
    if (cp[key] === undefined || cp[key] === null) continue; // 未给的段不出现；空数组段保留标题
    const body = sectionText(cp[key]);
    lines.push(`## ${key}`, body, '');
  }
  return lines.join('\n').trimEnd();
}

/**
 * checkpoint 对象 → [{k, v}] 八段表格行（给 .cp .kv 渲染；跳过未给的段）。
 * @param {object} record
 * @returns {Array<{k: string, v: string}>}
 */
export function checkpointRows(record) {
  const cp = parseCheckpoint(record);
  if (!cp) return [];
  const rows = [];
  for (const key of CHECKPOINT_SECTIONS) {
    if (cp[key] === undefined || cp[key] === null) continue;
    rows.push({ k: key, v: sectionText(cp[key]) });
  }
  return rows;
}

/**
 * /api/tasks 的单条任务 → 列表行数据（防御式：title 缺失回退 id，数字缺失按 0）。
 * @param {object} task
 * @returns {{scope:string,id:string,title:string,status:string,records:number,updatedAt:string,label:string}}
 */
export function buildTaskRow(task) {
  const t = task && typeof task === 'object' ? task : {};
  const id = String(t.id ?? '');
  const scope = String(t.scope ?? '');
  const title = String(t.title ?? '') || id || scope;
  const records = Number(t.records ?? 0) || 0;
  const updatedAt = String(t.updatedAt ?? '');
  return {
    scope, id, title,
    status: String(t.status ?? 'open'),
    records, updatedAt,
    label: `${title} · ${records} 条记录`,
  };
}

/** 任务状态 → badge 文案 / 变体类（只产出 style.css 已定义的 .badge 变体）。 */
export function statusBadge(status) {
  return String(status) === 'closed'
    ? { label: '已关闭', cls: '' }
    : { label: '进行中', cls: 'b-ok' };
}

/** ISO 时间 → 本地可读短格式；解析失败原样返回。 */
export function fmtTime(iso) {
  const s = String(iso ?? '');
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 记录 id 前 8 位（等宽小字用）。 */
export function shortId(id) {
  const s = String(id ?? '');
  return s.length > 8 ? s.slice(0, 8) : s;
}

/**
 * 一条任务分库 → 列表行数据（scope + 记录数）。保留给旧调用方 / 单测。
 * @param {string} scope
 * @param {{records?: number}} [stats]
 * @returns {{scope: string, records: number, label: string}}
 */
export function buildSessionRow(scope, stats) {
  const records = Number(stats?.records ?? 0) || 0;
  return { scope: String(scope ?? ''), records, label: `${scope} · ${records} 条记录` };
}

/* ---------------- POST 封装（credentials:'same-origin' + JSON） ---------------- */

/**
 * 统一 POST 出口：失败抛 Error（code: message），成功返回解析后的 body。
 * POST 端点（rename / remove / tombstone）的 scope 放在 JSON body 里。
 */
async function apiPost(path, payload) {
  let res;
  try {
    res = await fetch(`api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
  } catch {
    throw new Error('E_FETCH_FAILED: 无法连接本地服务，请确认 memo serve 正在运行。');
  }
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON 错误体走统一处理 */ }
  if (!res.ok || !body || body.ok === false) {
    throw new Error(`${body?.code ?? `E_HTTP_${res.status}`}: ${body?.message ?? res.statusText}`);
  }
  return body;
}

/* ---------------- 页面渲染 ---------------- */

/**
 * 挂载任务页（app.js 懒加载后调用；apiGet 由 app.js 注入，自动带当前 scope）。
 * @param {{container: Element, apiGet: Function, api?: Function}} deps
 * @returns {Promise<void>}
 */
export async function mountSessionView({ container, apiGet }) {
  container.replaceChildren();


  let tasks = [];
  let writeEnabled = false;
  try {
    const data = await apiGet('/tasks');
    tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  } catch (err) {
    container.append(el('div', 'err', `加载失败 · ${err.message}`));
    return;
  }
  try {
    const summary = await apiGet('/summary');
    writeEnabled = summary?.writeEnabled === true;
  } catch { /* 拿不到 summary 就按只读处理 */ }

  if (tasks.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'big', '还没有任务库'));
    empty.append(el('div', '', 'Agent 调用 memo session start 后，任务会出现在这里。'));
    container.append(empty);
    return;
  }

  const rows = tasks.map(buildTaskRow)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));

  // 左列表 + 右详情两栏（.split.list 已在 style.css 定义）
  const layout = el('div', 'split list');
  const listBox = el('div', 'card');
  const cardH = el('div', 'card-h');
  cardH.append(el('h4', '', `任务库（${rows.length}）`));
  listBox.append(cardH);
  const list = el('div', 'task-list');
  listBox.append(list);
  const detail = el('div', 'card task-detail');
  layout.append(listBox, detail);
  container.append(layout);

  const page = {
    rows, list, detail, apiGet, writeEnabled,
    selected: null,
  };

  renderListOnly(page);
  detail.append(el('div', 'empty'));
  detail.firstElementChild.append(el('div', 'big', '选择一个任务'));
  detail.firstElementChild.append(el('div', '', '点击左侧任务查看其中的记录。'));
}

/** 拉取一个任务库的 active 记录并渲染详情（.th 头 + .tb 按 kind 分组的记录）。 */
async function showTask(page, row) {
  const { detail, apiGet, writeEnabled } = page;
  detail.replaceChildren(el('p', 'dim', '加载中…'));
  let data;
  try {
    // 显式 scope 放在最前：服务端取第一个 scope 参数，覆盖 api() 追加的当前分库
    data = await apiGet(`/records?scope=${encodeURIComponent(row.scope)}&status=active`);
  } catch (err) {
    detail.replaceChildren(el('div', 'err', `加载失败 · ${err.message}`));
    return;
  }

  detail.replaceChildren();

  /* .th：大标题 + 状态 + 操作区（重命名 / 删除任务库 / 关闭提示） */
  const th = el('div', 'th');
  const thText = el('div');
  const badge = statusBadge(row.status);
  thText.append(el('h3', '', row.title));
  const sub = el('div', 'faint mono');
  sub.textContent = row.scope;
  thText.append(sub);
  const acts = el('div', 'acts');
  const renameBtn = el('button', 'sm', '重命名');
  const removeBtn = el('button', 'sm danger', '删除任务库');
  for (const btn of [renameBtn, removeBtn]) {
    if (!writeEnabled) { btn.disabled = true; btn.title = READ_ONLY_HINT; }
  }
  renameBtn.addEventListener('click', () => startRename(page, row, renameBtn));
  removeBtn.addEventListener('click', () => confirmRemoveTask(page, row));
  acts.append(renameBtn, removeBtn);
  const st = el('span', `badge ${badge.cls}`, badge.label);
  th.append(thText, st, acts);
  detail.append(th);

  /* .tb：按 kind 分组的记录 */
  const tb = el('div', 'tb');
  const grouped = groupByKind(data?.records);
  const kinds = Object.keys(grouped);
  if (kinds.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'big', '没有 active 记录'));
    tb.append(empty);
  }
  for (const kind of kinds) {
    const group = el('div', 'kind-group');
    group.append(el('div', 'kh', `${kind} · ${grouped[kind].length}`));
    for (const r of grouped[kind]) group.append(renderRecord(page, row, r));
    tb.append(group);
  }
  detail.append(tb);
}

/** 单条记录：state/checkpoint → .cp .kv 八段表格；其余 → .rt 标题 + .rx 正文 + .rf 元信息。 */
function renderRecord(page, taskRow, r) {
  const rec = el('div', 'rec');
  const title = String(r?.title ?? '') || String(r?.text ?? '').split('\n')[0] || '(无标题)';
  rec.append(el('div', 'rt', title));

  const cpRows = checkpointRows(r);
  if (cpRows.length > 0) {
    // checkpoint 记录：.cp 里的 .kv 八段表格（k 段名 / v 多行文本，textContent 写入）
    const cp = el('div', 'cp');
    const kv = el('div', 'kv');
    for (const { k, v } of cpRows) {
      kv.append(el('div', 'k', k), el('div', 'v', v));
    }
    cp.append(kv);
    rec.append(cp);
  } else {
    // 正文与标题相同时不重复渲染（session 的 state 记录 text 就是标题）
    const body = String(r?.text ?? r?.value ?? '');
    if (body && body !== title) rec.append(el('div', 'rx', body));
  }

  /* .rf：时间 · id 前 8 位 · 标签 · 出处 · 删除按钮 */
  const rf = el('div', 'rf');
  const bits = [fmtTime(r?.validFrom), shortId(r?.id)].filter(Boolean).join(' · ');
  if (bits) rf.append(el('span', 'mono', bits));
  for (const tag of (Array.isArray(r?.tags) ? r.tags.slice(0, 4) : [])) {
    rf.append(el('span', 'badge', String(tag)));
  }
  const src = r?.source?.agent ?? r?.source?.session;
  if (src) rf.append(el('span', 'faint', `来源 ${String(src)}`));
  const acts = el('div', 'acts');
  const del = el('button', 'sm ghost', '删除');
  if (!page.writeEnabled) { del.disabled = true; del.title = READ_ONLY_HINT; }
  del.addEventListener('click', () => tombstoneRecord(page, taskRow, r, del));
  acts.append(del);
  rf.append(acts);
  rec.append(rf);
  return rec;
}

/* ---------------- 写操作 ---------------- */

/** 重命名：把按钮换成内联输入框，Enter 提交 / Esc 取消；成功后刷新列表与详情。 */
function startRename(page, row, btn) {
  const input = el('input');
  input.type = 'text';
  input.value = row.title;
  input.placeholder = '新任务标题';
  input.style.minWidth = '200px';
  btn.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    input.replaceWith(btn);
  };
  input.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Enter') {
      const title = input.value.trim();
      if (!title || title === row.title) { restore(); return; }
      done = true;
      input.disabled = true;
      try {
        await apiPost('/tasks/rename', { scope: row.scope, title });
        await reloadPage(page, row.scope); // 刷新列表与详情
      } catch (err) {
        done = false;
        input.disabled = false;
        showAlert(page.detail, err.message);
      }
    } else if (ev.key === 'Escape') restore();
  });
  input.addEventListener('blur', restore);
}

/** 删除任务库：内联二次确认条（不要 window.confirm）；成功后从列表移除并清空右侧。 */
function confirmRemoveTask(page, row) {
  const detail = page.detail;
  clearAlert(detail);
  const bar = el('div', 'note');
  bar.setAttribute('data-confirm', '');
  bar.append(document.createTextNode(`确认删除任务库「${row.title}」及其全部记录？此操作不可撤销。`));
  const yes = el('button', 'sm danger', '确认删除');
  const no = el('button', 'sm', '取消');
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await apiPost('/tasks/remove', { scope: row.scope });
      page.rows = page.rows.filter((r) => r.scope !== row.scope);
      page.selected = null;
      renderListOnly(page);
      if (page.rows.length === 0) {
        detail.replaceChildren();
        const empty = el('div', 'empty');
        empty.append(el('div', 'big', '还没有任务库'));
        detail.append(empty);
      } else {
        detail.replaceChildren();
        const empty = el('div', 'empty');
        empty.append(el('div', 'big', '选择一个任务'));
        empty.append(el('div', '', '点击左侧任务查看其中的记录。'));
        detail.append(empty);
      }
    } catch (err) {
      yes.disabled = false;
      showAlert(detail, err.message);
    }
  });
  no.addEventListener('click', () => bar.remove());
  bar.append(yes, no);
  detail.prepend(bar);
}

/** 删除单条记录：POST /api/records/tombstone 成功后从详情里移除该 .rec。 */
async function tombstoneRecord(page, taskRow, r, btn) {
  btn.disabled = true;
  try {
    await apiPost('/records/tombstone', {
      scope: taskRow.scope,
      id: String(r?.id ?? ''),
      reason: 'ui: session-view 手动删除',
    });
    const recEl = btn.closest('.rec');
    if (recEl) {
      // 同步左列表计数：本地减一，避免整页刷新
      const row = page.rows.find((x) => x.scope === taskRow.scope);
      if (row) row.records = Math.max(0, row.records - 1);
      recEl.remove();
      renderListOnly(page);
    }
  } catch (err) {
    btn.disabled = false;
    showAlert(page.detail, err.message);
  }
}

/* ---------------- 小工具 ---------------- */

/** 重拉 /api/tasks + 当前任务记录，重渲染整页（rename 成功后用）。 */
async function reloadPage(page, scope) {
  const data = await page.apiGet('/tasks');
  page.rows = (Array.isArray(data?.tasks) ? data.tasks : [])
    .map(buildTaskRow)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const row = page.rows.find((x) => x.scope === scope) ?? null;
  page.selected = row;
  renderListOnly(page);
  if (row) await showTask(page, row);
  else page.detail.replaceChildren(el('p', 'dim', '该任务库已不存在。'));
}

/** 只重渲染左列表（选中态由 page.selected 决定）。 */
function renderListOnly(page) {
  const list = page.list;
  list.replaceChildren();
  for (const row of page.rows) {
    const item = el('button', `task-item${page.selected?.scope === row.scope ? ' active' : ''}`);
    item.type = 'button';
    item.append(el('div', 'tt', row.title));
    const badge = statusBadge(row.status);
    const tm = el('div', 'tm');
    const b = el('span', `badge ${badge.cls}`, badge.label);
    tm.append(b, document.createTextNode(` · ${row.records} 条记录 · ${fmtTime(row.updatedAt) || '–'}`));
    tm.append(el('div', 'faint mono', row.scope));
    item.append(tm);
    item.addEventListener('click', () => {
      page.selected = row;
      renderListOnly(page);
      showTask(page, row);
    });
    list.append(item);
  }
}

/** 在详情顶部显示一条错误（.err）；先清掉旧的确认条/错误条。 */
function showAlert(detail, message) {
  clearAlert(detail);
  const box = el('div', 'err', `操作失败 · ${message}`);
  box.setAttribute('data-confirm', '');
  detail.prepend(box);
}

/** 移除详情顶部的内联确认条 / 错误条。 */
function clearAlert(detail) {
  for (const n of Array.from(detail.children)) {
    if (n.hasAttribute('data-confirm')) n.remove();
  }
}
