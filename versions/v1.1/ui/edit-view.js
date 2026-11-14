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
 * 结构约定（设计系统）：.split.list 左 .task-list（.task-item > .tt/.tm）
 * + 右 .task-detail（.th 标题 + .acts 保存/取消，字段用 .kv 两列布局）。
 * 安全约定：渲染全部经 renderEditForm / renderRecordList 输出转义 HTML，再用
 * DOMParser 挂载；模块内禁止 HTML 拼接用户数据与 eval。
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
 * 渲染左侧记录选择列表（点击项 → 选中态；.tt 标题 / .tm 元信息）。
 * 输出为 .task-item 按钮序列（无外层包裹，挂载方直接放进 .task-list）。
 * @param {{items: Array<object>, selectedId?: string}} args
 * @returns {string}
 */
export function renderRecordList({ items = [], selectedId = '' } = {}) {
  const parts = [];
  for (const r of items) {
    const raw = String(r?.text ?? r?.value ?? r?.id ?? '');
    const text = raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
    const on = r?.id && r.id === selectedId ? ' active' : '';
    const selAttr = r?.id && r.id === selectedId ? ' data-selected="1"' : '';
    const kind = String(r?.kind ?? 'fact');
    const id = String(r?.id ?? '');
    parts.push(
      `<button type="button" class="task-item${on}" data-id="${escapeHtml(id)}"${selAttr}>`,
      `<span class="tt"><span class="badge b-${escapeHtml(kind)}">${escapeHtml(kind)}</span> ${escapeHtml(text)}</span>`,
      `<span class="tm">${escapeHtml(kind)} · ${escapeHtml(id.slice(0, 12))}</span>`,
      '</button>',
    );
  }
  if (parts.length === 0) {
    parts.push('<div class="empty"><span class="big">没有匹配的记录</span><span>试试其他关键词。</span></div>');
  }
  return parts.join('');
}

/* ---------------- 表单 HTML（转义后经 DOMParser 挂载） ---------------- */

/**
 * 渲染编辑表单（.task-detail 片段：.th 标题 + .acts 保存/取消；.tb 内 .kv 两列表单）。
 * 所有动态值（记录字段、kind 列表）一律 escapeHtml；提交按钮经 form 属性关联表单。
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
  const field = (name, label, control) =>
    `<label class="k" for="sd-f-${name}">${label}</label>${control}`;
  const v = (f) => esc(record?.[f] ?? '');
  const banner = ro
    ? '<div class="note edit-readonly-note">当前为只读模式，用 <code>memo serve --write</code> 启动后才能提交。</div>'
    : '';
  return [
    '<div class="task-detail">',
    '<div class="th">',
    `<h3>${record ? '编辑记录' : '新建记录'}</h3>`,
    '<div class="acts">',
    `<button type="submit" form="sd-edit-form" class="primary edit-submit"${disabled}>${record ? '保存（supersede）' : '新增（write）'}</button>`,
    '<button type="button" class="ghost edit-cancel">取消</button>',
    '</div>',
    '</div>',
    '<div class="tb">',
    '<form id="sd-edit-form" class="kv" autocomplete="off">',
    field('kind', 'kind', `<select name="kind" id="sd-f-kind"${disabled}>${opts}</select>`),
    field('title', 'title', `<textarea name="title" id="sd-f-title" rows="2"${disabled}>${v('title')}</textarea>`),
    field('subject', 'subject', `<input name="subject" id="sd-f-subject" value="${v('subject')}"${disabled}>`),
    field('predicate', 'predicate', `<input name="predicate" id="sd-f-predicate" value="${v('predicate')}"${disabled}>`),
    field('value', 'value', `<input name="value" id="sd-f-value" value="${v('value')}"${disabled}>`),
    field('text', 'text', `<textarea name="text" id="sd-f-text" rows="4"${disabled}>${v('text')}</textarea>`),
    '</form>',
    `<div class="edit-msg" role="status"></div>`,
    banner,
    '</div>',
    '</div>',
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

  /* 布局骨架：.split.list（左 .task-list 卡 + 右 .task-detail 卡）。 */
  const wrap = document.createElement('div');
  wrap.className = 'split list';
  const left = document.createElement('div');
  left.className = 'task-list';
  const right = document.createElement('div');
  right.className = 'task-detail';
  wrap.append(left, right);
  container.replaceChildren(wrap);

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '按关键词搜索记录，回车查询';
  search.setAttribute('aria-label', '记录搜索');
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'sm';
  newBtn.textContent = '+ 新建记录';
  const listBox = document.createElement('div');
  listBox.style.display = 'contents'; // 让 .task-item 直接落在 .task-list 布局里
  left.append(search, newBtn, listBox);

  const setMsg = (text, isErr = false) => {
    const m = right.querySelector('.edit-msg');
    if (m) m.textContent = text, m.classList.toggle('err', isErr);
  };

  /** 表单当前值 → form 对象。 */
  const readForm = () => {
    const f = right.querySelector('form');
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
    right.replaceChildren(...Array.from(doc.body.childNodes));
    right.querySelector('form')?.addEventListener('submit', onSubmit);
    right.querySelector('.edit-cancel')?.addEventListener('click', () => renderForm()); // 取消=还原当前记录
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
      for (const li of listBox.querySelectorAll('.task-item')) {
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
      for (const li of listBox.querySelectorAll('.task-item')) {
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
