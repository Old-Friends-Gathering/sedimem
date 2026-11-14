/**
 * edit-view.js —— 编辑页（W7 / B1）：左侧记录搜索选择，右侧编辑表单。
 *
 * 契约（与后端 A 对齐）：
 * - GET  /api/records?q=&limit=  → { records:[{id,kind,title,subject,predicate,value,text,validFrom}] }
 * - GET  /api/summary           → { policy:{kinds}, readOnly? }（缺 readOnly 视为只读）
 * - POST /api/supersede         body { oldId, ifMatch, title, subject, predicate, value, text }
 * - POST /api/write             body { kind, title, subject, predicate, value, text }（新增）
 * 编辑必须带 ifMatch（当前记录的 validFrom）；409 = 并发改动冲突。
 *
 * 安全约定：渲染全部经 renderEditForm 输出转义 HTML，再用 DOMParser 挂载
 * （与 search 页同一模式）；模块内禁止 HTML 拼接与 eval。
 */
import { escapeHtml } from './search-view.js';

/* ---------------- 纯函数（node 可测） ---------------- */

/**
 * 只读判定：后端未显式声明可写（writeEnabled===true 或 readOnly===false）一律按只读。
 * @param {{writeEnabled?: boolean, readOnly?: boolean}} summary
 * @returns {boolean}
 */
export function readOnlyFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return true;
  if (summary.writeEnabled === true) return false;
  return summary.readOnly !== false;
}

/**
 * 提交按钮是否可用：只读永远不可提交；有脏变更才允许提交。
 * @param {{readonly: boolean, dirty: boolean}} args
 * @returns {boolean}
 */
export function canSubmit({ readonly, dirty }) {
  return readonly === false && dirty === true;
}

/**
 * 表单相对当前记录是否有变更（新增时 record 为 null：任一字段非空即视为 dirty）。
 * @param {{kind?: string, title?: string, subject?: string, predicate?: string, value?: string, text?: string}} form
 * @param {null | {kind?: string, title?: string, subject?: string, predicate?: string, value?: string, text?: string}} record
 * @returns {boolean}
 */
export function formIsDirty(form, record) {
  const fields = ['kind', 'title', 'subject', 'predicate', 'value', 'text'];
  if (!record) return fields.some((f) => String(form?.[f] ?? '').trim() !== '');
  return fields.some((f) => String(form?.[f] ?? '') !== String(record?.[f] ?? ''));
}

/**
 * 构造 supersede 请求体。ifMatch 显式传入优先，否则取当前记录的 validFrom；两者都没有则拒绝。
 * @param {{record: object, form: object, ifMatch?: string}} args
 * @returns {{oldId: string, ifMatch: string, title: string, subject: string, predicate: string, value: string, text: string}}
 * @throws {Error} code=E_INVALID_ARG 缺 record.id 或并发版本号
 */
export function buildSupersedePayload({ record, form, ifMatch }) {
  const oldId = record?.id;
  const match = ifMatch ?? record?.validFrom;
  if (!oldId) {
    const err = new Error('buildSupersedePayload: record.id is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  if (!match) {
    const err = new Error(`buildSupersedePayload: ifMatch (validFrom of ${oldId}) is required`);
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  return {
    oldId,
    ifMatch: match,
    title: String(form?.title ?? ''),
    subject: String(form?.subject ?? ''),
    predicate: String(form?.predicate ?? ''),
    value: String(form?.value ?? ''),
    text: String(form?.text ?? ''),
  };
}

/**
 * 构造 write（新增）请求体。
 * @param {{form: object}} args
 * @returns {{kind: string, title: string, subject: string, predicate: string, value: string, text: string}}
 */
export function buildWritePayload({ form }) {
  return {
    kind: String(form?.kind ?? 'fact'),
    title: String(form?.title ?? ''),
    subject: String(form?.subject ?? ''),
    predicate: String(form?.predicate ?? ''),
    value: String(form?.value ?? ''),
    text: String(form?.text ?? ''),
  };
}

/** kind 选项（服务端 policy.kinds 兜底 ['fact','pref','decision','gotcha','state']）。 */
const FALLBACK_KINDS = ['fact', 'pref', 'decision', 'gotcha', 'state'];

/**
 * 渲染左侧记录选择列表（点击项 → 选中态；前缀 = kind，正文截 64 字）。
 * @param {{items: Array<object>, selectedId?: string}} args
 * @returns {string}
 */
export function renderRecordList({ items = [], selectedId = '' } = {}) {
  const parts = [];
  for (const r of items) {
    const raw = String(r?.text ?? r?.value ?? r?.id ?? '');
    const text = raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
    const on = r?.id && r.id === selectedId ? ' selected' : '';
    parts.push(
      `<li class="edit-rec${on}" data-id="${escapeHtml(r?.id ?? '')}">`,
      `<span class="badge b-${escapeHtml(r?.kind ?? 'fact')}">${escapeHtml(r?.kind ?? 'fact')}</span> `,
      escapeHtml(text),
      '</li>',
    );
  }
  if (parts.length === 0) parts.push('<li class="dim">没有匹配的记录，试试其他关键词。</li>');
  return `<ul class="edit-rec-list">${parts.join('')}</ul>`;
}

/* ---------------- 表单 HTML（转义后经 DOMParser 挂载, 统一走 DOMParser） ---------------- */

/**
 * 渲染编辑表单。所有动态值（记录字段、kind 列表）一律 escapeHtml。
 * @param {{kinds?: string[], record?: null|object, readonly?: boolean}} args
 * @returns {string}
 */
export function renderEditForm({ kinds = null, record = null, readonly = true } = {}) {
  const list = Array.isArray(kinds) && kinds.length > 0 ? kinds : FALLBACK_KINDS;
  const esc = escapeHtml;
  const ro = !!readonly;
  const disabled = ro ? ' disabled' : '';
  const opts = list.map((k) => {
    const sel = record?.kind === k ? ' selected' : '';
    return `<option value="${esc(k)}"${sel}>${esc(k)}</option>`;
  }).join('');
  const v = (f) => esc(record?.[f] ?? '');
  const banner = ro
    ? '<div class="edit-readonly-note">当前为只读模式，用 <code>memo serve --write</code> 启动后才能提交。</div>'
    : '';
  return [
    '<form class="edit-form card">',
    `<div class="form-row"><label>kind</label><select name="kind" class="form-control"${disabled}>${opts}</select></div>`,
    `<div class="form-row"><label>title</label><input name="title" class="form-control" value="${v('title')}"${disabled}></div>`,
    `<div class="form-row"><label>subject</label><input name="subject" class="form-control" value="${v('subject')}"${disabled}></div>`,
    `<div class="form-row"><label>predicate</label><input name="predicate" class="form-control" value="${v('predicate')}"${disabled}></div>`,
    `<div class="form-row"><label>value</label><input name="value" class="form-control" value="${v('value')}"${disabled}></div>`,
    `<div class="form-row"><label>text</label><textarea name="text" class="form-control" rows="4"${disabled}>${v('text')}</textarea></div>`,
    `<div class="edit-msg" role="status"></div>`,
    `<button type="submit" class="btn btn-primary edit-submit"${disabled}>${record ? '保存（supersede）' : '新增（write）'}</button>`,
    banner,
    '</form>',
  ].join('');
}

/* ---------------- 挂载（app.js 懒加载后调用） ---------------- */

/**
 * 挂载编辑页。apiGet / apiPost 由 app.js 注入（统一拼 scope、统一错误格式）。
 * @param {{container: Element, apiGet: Function, apiPost: Function}} deps
 * @returns {Promise<void>}
 */
export async function mountEditView({ container, apiGet, apiPost }) {
  let kinds = null;
  let readonly = true;
  let record = null; // 当前选中的记录（null = 新建模式）
  let ifMatch = '';

  try {
    const s = await apiGet('/summary');
    if (Array.isArray(s?.policy?.kinds) && s.policy.kinds.length > 0) kinds = s.policy.kinds;
    readonly = readOnlyFromSummary(s);
  } catch { /* summary 拿不到按只读兜底，不阻塞页面 */ }

  /* 布局骨架：全部 createElement + textContent，杜绝 HTML 拼接。 */
  const wrap = document.createElement('div');
  wrap.className = 'edit-layout';
  const left = document.createElement('div');
  left.className = 'edit-left card';
  const right = document.createElement('div');
  right.className = 'edit-right';
  wrap.append(left, right);
  container.replaceChildren(wrap);

  const title = document.createElement('h3');
  title.textContent = record ? '编辑记录' : '新建记录';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'form-control';
  search.placeholder = '按关键词搜索记录，回车查询';
  search.setAttribute('aria-label', '记录搜索');
  const listBox = document.createElement('div');
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'btn';
  newBtn.textContent = '+ 新建记录';
  left.append(search, listBox, newBtn);

  const formBox = document.createElement('div');
  right.append(title, formBox);

  const setMsg = (text, isErr = false) => {
    const m = formBox.querySelector('.edit-msg');
    if (m) m.textContent = text, m.classList.toggle('err', isErr);
  };

  /** 表单当前值 → form 对象。 */
  const readForm = () => {
    const f = formBox.querySelector('form');
    if (!f) return {};
    const out = {};
    for (const k of ['kind', 'title', 'subject', 'predicate', 'value', 'text']) {
      out[k] = f.elements[k]?.value ?? '';
    }
    return out;
  };

  /** 重画表单；record=null 即新建。 */
  function renderForm() {
    const html = renderEditForm({ kinds, record, readonly });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    formBox.replaceChildren(...Array.from(doc.body.childNodes));
    title.textContent = record ? '编辑记录' : '新建记录';
    const f = formBox.querySelector('form');
    f?.addEventListener('submit', onSubmit);
  }

  /** 搜索（q 为空取最近记录）。 */
  async function doSearch() {
    const q = search.value.trim();
    listBox.replaceChildren(document.createTextNode('查询中…'));
    try {
      const d = await apiGet(`/records?q=${encodeURIComponent(q)}&limit=50`);
      const html = renderRecordList({ items: d?.records ?? [], selectedId: record?.id ?? '' });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      listBox.replaceChildren(...Array.from(doc.body.childNodes));
      for (const li of listBox.querySelectorAll('.edit-rec')) {
        li.addEventListener('click', () => selectRecord(String(li.dataset.id ?? '')));
      }
    } catch (err) {
      listBox.replaceChildren(document.createTextNode(`查询失败 · ${err.message}`));
    }
  }

  /** 按 id 从本地列表缓存选中记录；找不到就提示。 */
  async function selectRecord(id) {
    if (!id) return;
    try {
      const d = await apiGet(`/records?q=${encodeURIComponent(id)}&limit=50`);
      const hit = (d?.records ?? []).find((r) => r.id === id) ?? null;
      if (!hit) { setMsg(`记录 ${id} 不存在或已失效`, true); return; }
      record = hit;
      ifMatch = String(hit.validFrom ?? '');
      renderForm();
      const html = renderRecordList({ items: d.records, selectedId: id });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      listBox.replaceChildren(...Array.from(doc.body.childNodes));
      for (const li of listBox.querySelectorAll('.edit-rec')) {
        li.addEventListener('click', () => selectRecord(String(li.dataset.id ?? '')));
      }
    } catch (err) {
      setMsg(`加载记录失败 · ${err.message}`, true);
    }
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    if (readonly) return; // 只读双保险：按钮已 disabled
    const form = readForm();
    const url = record ? 'supersede' : 'write';
    const body = record
      ? buildSupersedePayload({ record, form, ifMatch })
      : buildWritePayload({ form });
    setMsg('提交中…');
    const { status, body: resp } = await apiPost(`/api/${url}`, body);
    if (status === 409) {
      setMsg('记录已被改动，请刷新后重试', true);
      return;
    }
    if (status >= 400 || resp?.ok === false) {
      setMsg(`提交失败 · ${resp?.code ?? status}: ${resp?.message ?? ''}`, true);
      return;
    }
    setMsg(record ? '已保存（旧记录被新记录取代）。' : '已写入。');
    if (record) ifMatch = String(resp?.record?.validFrom ?? ifMatch);
  }

  newBtn.addEventListener('click', () => { record = null; ifMatch = ''; renderForm(); });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); }
  });

  renderForm();
  await doSearch(); // 初始列表：最近记录
}
