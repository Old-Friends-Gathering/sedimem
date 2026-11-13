/**
 * import-view.js —— 导入页（W7 / B2）：选来源 → 填路径 → 预览 → 写入。
 *
 * 契约（与后端 A 对齐）：POST /api/import?dryRun=1|apply=1，body { src, path }
 * → { ok, src, path, dryRun, parsed, byKind, samples? }
 * apply 成功响应应带 written / skipped 计数（预览响应无）。
 *
 * 安全约定：预览表格经 renderImportPreview 输出转义 HTML，DOMParser 挂载；
 * 模块内禁止 HTML 拼接与 eval。
 */
import { escapeHtml } from './search-view.js';
import { readOnlyFromSummary } from './edit-view.js';

/** 五个导入来源（值需与后端 importer 的 src 白名单一致，错位时后端会报 E_INVALID_ARG）。 */
export const SOURCES = [
  { src: 'markdown', label: 'Markdown' },
  { src: 'jsonl', label: 'JSONL' },
  { src: 'csv', label: 'CSV' },
  { src: 'chat-export', label: '聊天导出' },
  { src: 'dsh-memory', label: 'DSH 记忆迁移' },
];

/**
 * import 查询串：预览 dryRun=1；写入 apply=1。
 * @param {{apply?: boolean}} args
 * @returns {string}
 */
export function importQuery({ apply = false } = {}) {
  return apply ? 'apply=1' : 'dryRun=1';
}

/** byKind 对象 → 「fact:3 · pref:1」展示串。 */
function byKindText(byKind) {
  const entries = Object.entries(byKind ?? {});
  if (entries.length === 0) return '–';
  return entries.map(([k, n]) => `${k}:${n}`).join(' · ');
}

/**
 * 渲染导入预览表格（来源 / 解析条数 / kind 分布 / 前 5 条样例）。所有动态值转义。
 * @param {{result: object}} args
 * @returns {string}
 * @throws {Error} code=E_INVALID_ARG 当 result 缺 parsed/byKind
 */
export function renderImportPreview({ result } = {}) {
  if (!result || typeof result !== 'object' || !('parsed' in result)) {
    const err = new Error('renderImportPreview: result with `parsed` is required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }
  const esc = escapeHtml;
  const samples = Array.isArray(result.samples) ? result.samples.slice(0, 5) : [];
  const rows = samples.map((s) => {
    const raw = typeof s === 'string' ? s : String(s?.text ?? s?.value ?? s?.id ?? '');
    const cut = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    const kind = typeof s === 'object' ? String(s?.kind ?? 'fact') : 'fact';
    return `<tr><td><span class="badge b-${esc(kind)}">${esc(kind)}</span></td><td>${esc(cut)}</td></tr>`;
  }).join('');
  return [
    '<table class="table import-preview">',
    '<thead><tr><th>来源</th><th>解析条数</th><th>kind 分布</th></tr></thead>',
    '<tbody>',
    `<tr><td>${esc(result.src ?? '')}</td><td>${esc(result.parsed)}</td><td>${esc(byKindText(result.byKind))}</td></tr>`,
    '</tbody>',
    '</table>',
    samples.length > 0 ? '<h4 class="h4">样例（前 5 条）</h4>' : '',
    `<table class="table import-samples"><tbody>${rows}</tbody></table>`,
  ].join('');
}

/**
 * 渲染写入结果（written / skipped）。
 * @param {{written?: number, skipped?: number, parsed?: number}} result
 * @returns {string}
 */
export function renderImportApplied(result = {}) {
  const written = Number(result.written ?? 0);
  const skipped = Number(result.skipped ?? 0);
  return escapeHtml(`写入完成：written ${written} · skipped ${skipped}`);
}

/* ---------------- 挂载（app.js 懒加载后调用） ---------------- */

/**
 * 挂载导入页。apiGet / apiPost 由 app.js 注入。
 * @param {{container: Element, apiGet: Function, apiPost: Function}} deps
 * @returns {Promise<void>}
 */
export async function mountImportView({ container, apiGet, apiPost }) {
  let readonly = true;
  let src = SOURCES[0]?.src ?? 'markdown';
  let lastPreview = null; // 预览通过后允许写入

  try {
    readonly = readOnlyFromSummary(await apiGet('/summary'));
  } catch { /* 拿不到按只读兜底 */ }

  const wrap = document.createElement('div');
  wrap.className = 'import-layout card';
  const srcRow = document.createElement('div');
  srcRow.className = 'import-sources';
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'form-control';
  pathInput.placeholder = '导入文件/目录的绝对路径';
  pathInput.setAttribute('aria-label', '导入路径');
  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'btn';
  previewBtn.textContent = '预览';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-primary';
  applyBtn.textContent = '写入';
  applyBtn.disabled = true; // 必须先预览
  const msg = document.createElement('div');
  msg.className = 'import-msg';
  msg.setAttribute('role', 'status');
  const resultBox = document.createElement('div');
  wrap.append(srcRow, pathInput, previewBtn, applyBtn, msg, resultBox);
  container.replaceChildren(wrap);

  if (readonly) {
    msg.textContent = '当前为只读模式，用 `memo serve --write` 启动后才能导入。';
    previewBtn.disabled = true;
    applyBtn.disabled = true;
  }

  // 五个来源按钮：单选高亮
  for (const s of SOURCES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn import-src${s.src === src ? ' btn-primary' : ''}`;
    b.dataset.src = s.src;
    b.textContent = s.label;
    b.disabled = readonly;
    b.addEventListener('click', () => {
      src = s.src;
      for (const x of srcRow.querySelectorAll('.import-src')) {
        x.classList.toggle('btn-primary', x.dataset.src === src);
      }
    });
    srcRow.append(b);
  }

  const setMsg = (text, isErr = false) => {
    msg.textContent = text;
    msg.classList.toggle('err', isErr);
  };

  const showResult = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    resultBox.replaceChildren(...Array.from(doc.body.childNodes));
  };

  async function doImport(apply) {
    const path = pathInput.value.trim();
    if (!path) { setMsg('请先填写导入路径', true); return; }
    setMsg(apply ? '写入中…' : '解析中…');
    const { status, body: r } = await apiPost(`/api/import?${importQuery({ apply })}`, { src, path });
    if (status === 409 || (r?.ok === false && r?.code === 'E_READONLY')) {
      setMsg('当前为只读模式，用 `memo serve --write` 启动后才能导入。', true);
      return;
    }
    if (status >= 400 || r?.ok === false) {
      setMsg(`导入失败 · ${r?.code ?? status}: ${r?.message ?? ''}`, true);
      return;
    }
    if (apply) {
      setMsg(renderImportApplied(r), false);
      applyBtn.disabled = true;
      lastPreview = null;
      return;
    }
    lastPreview = r;
    showResult(renderImportPreview({ result: r }));
    setMsg(`解析出 ${r?.parsed ?? 0} 条，确认无误后点「写入」。`);
    applyBtn.disabled = false;
  }

  previewBtn.addEventListener('click', () => doImport(false));
  applyBtn.addEventListener('click', () => {
    if (!lastPreview) { setMsg('请先预览再写入', true); return; }
    doImport(true);
  });
}
