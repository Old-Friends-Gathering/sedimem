/**
 * ledger-view.js —— 任务页「任务账本」三段（v1.2 B3）。
 *
 *   ① 顶部摘要徽标：`N 段` / `覆盖 1–470` / `简报 2.2K` / `上次捕获 09:53`
 *   ② .ledger 段时间线：[区间] [rules|llm] [⚠ 隔离] 60 字摘要 —— 点开看全文
 *   ③ .ledger-brief 简报面板：默认折叠，生成后渲染 <pre class="md">，可复制
 *
 * 数据契约（src/web/handlers.js，query 一律 task=<taskId>）：
 * - GET  /task-context?task=<id>  → {task:String, segments:Number, covered:[[from,to]],
 *                                    briefChars:Number, lastCapturedAt:ISO|null}
 * - GET  /task-segments?task=<id> → {task:String, segments:[段记录], checkpoints:[checkpoint], badLines, index}
 * - GET  /task-brief?task=<id>    → briefJson 顶层展开（task 为对象）
 * - POST /tasks/capture {task}    → {created, skipped, segments}
 * - POST /tasks/archive {task}    → {movedTo}
 *
 * 安全：三处外部数据（段摘要 / 简报文本 / 错误 message）一律 textContent，
 * 不用 HTML 字符串拼接，也不用任何可执行字符串（Q9 门禁）。
 */
import { el } from './dom.js';
import { apiPost } from './api.js';

export const READ_ONLY_HINT = '用 memo serve --write 启动才可写';
export const BRIEF_BLOCK_TAG = 'pre';
export const BRIEF_BLOCK_CLASS = 'md';
export const SUMMARY_MAX = 60;
export const LEDGER_EMPTY_BIG = '还没有账本段';
export const LEDGER_EMPTY_HINT = '点「捕获」把本任务已消费的上下文折叠成段，或在 CLI 跑 memo session capture。';
export const BRIEF_EMPTY = '还没有简报。点「生成简报」按当前账本生成。';
export const EXPAND_NO_SELECT = '先点开一个段，再点「导出 expand」。';
export const EXPAND_NO_TASK = '缺少任务 id，无法生成 expand 命令。';

const MODE_LABEL = { rules: 'rules', llm: 'llm' };
const MODE_CLASS = { rules: 'b-accent', llm: 'b-info' };

/** taskId 从 scope（`session:<id>`）里取；非法返回 ''。 */
export function taskIdFromScope(scope) {
  const s = String(scope ?? '');
  return s.startsWith('session:') ? s.slice('session:'.length) : '';
}

/** 简报字符数徽标：0 → '—'；1234 → '1.2K'；2200 → '2.2K'。 */
export function fmtBriefChars(chars) {
  const n = Number(chars);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '—';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
}

/** 覆盖区间按钮文案：`覆盖 1–470`；无覆盖 → '未覆盖'。 */
export function coveredLabel(covered) {
  let min = Infinity;
  let max = -Infinity;
  if (Array.isArray(covered)) {
    for (const r of covered) {
      if (!Array.isArray(r) || r.length < 2) continue;
      const from = Number(r[0]);
      const to = Number(r[1]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      if (from < min) min = from;
      if (to > max) max = to;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return '未覆盖';
  return `覆盖 ${fmtNum(min)}–${fmtNum(max - 1)}`;
}

function fmtNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.trunc(v)) : '?';
}

/** ISO → 本地 HH:MM（两位）；非法/空 → '—'。 */
export function fmtClock(iso) {
  const ts = iso ? Date.parse(String(iso)) : NaN;
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 摘要徽标数据源（纯数据，便于单测）。 */
export function buildSummaryBadges(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const segments = Number.isFinite(Number(ctx.segments)) ? Math.max(0, Math.trunc(Number(ctx.segments))) : 0;
  return [
    { key: 'segments', label: `${segments} 段`, cls: segments > 0 ? 'b-accent' : '' },
    { key: 'covered', label: coveredLabel(ctx.covered), cls: '' },
    { key: 'brief', label: `简报 ${fmtBriefChars(ctx.briefChars)}`, cls: '' },
    { key: 'captured', label: `上次捕获 ${fmtClock(ctx.lastCapturedAt)}`, cls: '' },
  ];
}

/** 写按钮状态：只读时 disabled + READ_ONLY_HINT。 */
export function writeState(writeEnabled, hint = READ_ONLY_HINT) {
  const ok = writeEnabled === true;
  return { disabled: !ok, hint: ok ? '' : hint };
}

/** 60 字截断（按码点，避免切断代理对）；空白折叠。 */
export function truncateSummary(text, max = SUMMARY_MAX) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, max).join('')}…`;
}

/** 段区间文案（半开区间 → 闭区间展示）：`1–121`；异常 → '—'。 */
export function segmentRange(seg) {
  const from = Number(seg?.fromSeq);
  const to = Number(seg?.toSeq);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '—';
  return `${fmtNum(from)}–${fmtNum(to - 1)}`;
}

/** 段来源徽标：rules / llm（未知模式兜底 rules）。 */
export function modeBadge(mode) {
  const m = String(mode ?? '');
  const key = m === 'llm' ? 'llm' : 'rules';
  return { key, label: MODE_LABEL[key], cls: MODE_CLASS[key] };
}

/** 段正文里的字符串列表（decisions/gotchas/nextSteps 可能为字符串或 {text}）。 */
function textList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push(t);
      continue;
    }
    const t = item && typeof item === 'object' && typeof item.text === 'string' ? item.text.trim() : '';
    if (t) out.push(t);
  }
  return out;
}

/** 单段 → 行视图模型。 */
export function buildSegmentRow(seg) {
  const rec = seg && typeof seg === 'object' ? seg : {};
  const quarantined = rec.quarantined === true;
  const summary = String(rec.summary ?? '');
  return {
    id: typeof rec.id === 'string' ? rec.id : '',
    range: segmentRange(rec),
    mode: modeBadge(rec.mode),
    quarantined,
    quarantineLabel: quarantined ? '⚠ 隔离' : '',
    excerpt: truncateSummary(summary),
    summary,
    decisions: textList(rec.decisions),
    gotchas: textList(rec.gotchas),
    nextSteps: textList(rec.nextSteps),
  };
}

/** 段数组 → 行视图模型数组（过滤非对象项）。 */
export function buildSegmentRows(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.filter((s) => s && typeof s === 'object').map(buildSegmentRow);
}

/** 空账本提示模型。 */
export function emptyLedgerState(segments, error) {
  const n = Array.isArray(segments) ? segments.length : 0;
  if (n > 0) return { empty: false, big: '', hint: '' };
  const msg = typeof error === 'string' ? error.trim() : '';
  return {
    empty: true,
    big: LEDGER_EMPTY_BIG,
    hint: msg ? `账本读取失败 · ${msg}` : LEDGER_EMPTY_HINT,
  };
}

/** 简报文本（与 src/session/ledger-brief.js 的 renderBriefText 同版式）。 */
export function buildBriefText(brief) {
  const b = normalizeBrief(brief);
  if (!b) return '';
  const lines = [];
  const t = b.task ?? {};
  lines.push(`任务 ${String(t.id ?? '?')}${t.title ? `：${t.title}` : ''}（${String(t.state ?? '?')}）`);
  if (b.summary) lines.push('', '— 上下文接力 —', String(b.summary));
  const dec = textList(b.decisions);
  if (dec.length > 0) lines.push('', '— 决策 —', ...dec.map((x) => `- ${x}`));
  const got = textList(b.gotchas);
  if (got.length > 0) lines.push('', '— 卡点 —', ...got.map((x) => `- ${x}`));
  const next = textList(b.nextSteps);
  if (next.length > 0) lines.push('', '— 下一步 —', ...next.map((x) => `- ${x}`));
  const refs = Array.isArray(b.references) ? b.references : [];
  const files = refs.map((r) => (r && typeof r === 'object' ? String(r.file ?? '') : '')).filter(Boolean);
  if (files.length > 0) lines.push('', '— 关键文件 —', ...files.map((x) => `- ${x}`));
  const budget = b.budget && typeof b.budget === 'object' ? b.budget : {};
  if (budget.truncated === true) {
    lines.push('', `（预算 ${fmtNum(budget.maxChars)} 字已截断，已用 ${fmtNum(budget.usedChars)} 字；展开全部请用 expand）`);
  }
  return lines.join('\n');
}


function coveredOf(segments) {
  const spans = segments
    .filter((s) => Number.isFinite(s?.fromSeq) && Number.isFinite(s?.toSeq))
    .map((s) => [s.fromSeq, s.toSeq])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [from, to] of spans) {
    const last = out.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** `/api/task-context` 返回 → 视图模型（容忍缺失/异常形状）。 */
export function normalizeContext(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const covered = Array.isArray(body.covered) ? body.covered : [];
  const segments = Number.isFinite(Number(body.segments)) ? Math.max(0, Math.trunc(Number(body.segments))) : 0;
  const briefChars = Number.isFinite(Number(body.briefChars)) ? Number(body.briefChars) : 0;
  return {
    task: typeof body.task === 'string' ? body.task : '',
    meta: body.meta && typeof body.meta === 'object' ? body.meta : null,
    segments,
    covered,
    briefChars,
    lastCapturedAt: typeof body.lastCapturedAt === 'string' ? body.lastCapturedAt : null,
  };
}

/** `/api/task-segments` 返回 → 段数组。 */
export function normalizeSegments(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  return Array.isArray(body.segments) ? body.segments.filter((s) => s && typeof s === 'object') : [];
}

/**
 * `/api/task-segments` 返回 → checkpoint 数组（v1.4.x）。
 * checkpoint 由 MCP memory_session_checkpoint 写在 items（不在 segments.jsonl），
 * 服务端已合并进响应；这里只做形状防御（缺字段/旧服务端 → []）。
 */
export function normalizeCheckpoints(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  return Array.isArray(body.checkpoints) ? body.checkpoints.filter((c) => c && typeof c === 'object') : [];
}

/** checkpoint 8 段 → UI 列表项（列表段取数组，文本段取字符串）。 */
export function buildCheckpointRows(checkpoints) {
  const LIST_KEYS = ['concepts', 'files', 'errorsAndFixes', 'pendingJobs', 'nextSteps'];
  const TEXT_KEYS = ['intent', 'currentState', 'criticalContext'];
  const rows = [];
  for (const c of Array.isArray(checkpoints) ? checkpoints : []) {
    const s = c?.sections && typeof c.sections === 'object' ? c.sections : null;
    // 列表标题：intent 优先；intent 为空串/缺失回落 currentState，再回落 id
    // （新式 checkpoint 可能只写 currentState/nextSteps——空标题会渲染成「（checkpoint）」）
    const first = (typeof s?.intent === 'string' && s.intent.trim())
      ? s.intent
      : (typeof s?.currentState === 'string' && s.currentState.trim())
        ? s.currentState
        : (s?.intent ?? c?.id ?? '');
    const excerpt = String(Array.isArray(first) ? first[0] ?? '' : first ?? '').slice(0, 60);
    rows.push({
      time: typeof c?.createdAt === 'string' ? c.createdAt.replace('T', ' ').slice(0, 19) : '—',
      excerpt,
      lists: LIST_KEYS.map((k) => ({ key: k, items: Array.isArray(s?.[k]) ? s[k].map((x) => String(x)) : [] })),
      texts: TEXT_KEYS.map((k) => ({ key: k, text: typeof s?.[k] === 'string' ? s[k] : '' })),
    });
  }
  return rows;
}

/** `/api/task-brief` 返回 → briefJson（顶层展开）；不像 briefJson 时返回 null。 */
export function normalizeBrief(raw) {
  const body = raw && typeof raw === 'object' ? raw : null;
  if (!body) return null;
  const task = body.task && typeof body.task === 'object' ? body.task : null;
  if (!task) return null;
  return {
    task: {
      id: String(task.id ?? '?'),
      title: typeof task.title === 'string' ? task.title : '',
      state: String(task.state ?? '?'),
    },
    summary: typeof body.summary === 'string' ? body.summary : '',
    decisions: Array.isArray(body.decisions) ? body.decisions.filter((x) => x && typeof x === 'object') : [],
    gotchas: Array.isArray(body.gotchas) ? body.gotchas.filter((x) => x && typeof x === 'object') : [],
    references: Array.isArray(body.references) ? body.references.filter((x) => x && typeof x === 'object') : [],
    nextSteps: Array.isArray(body.nextSteps) ? body.nextSteps.filter((x) => x && typeof x === 'object') : [],
    budget: body.budget && typeof body.budget === 'object' ? body.budget : { maxChars: 0, usedChars: 0, truncated: false },
    generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : null,
  };
}

/** 「导出 expand」按钮的 CLI 命令文案（只展示，不写文件）。 */
export function expandCommand(taskId, segmentId) {
  const id = String(taskId ?? '').trim();
  if (!id) return EXPAND_NO_TASK;
  const seg = String(segmentId ?? '').trim();
  if (!seg) return EXPAND_NO_SELECT;
  return `memo session expand --scope session:${id} --segment ${seg} --to-file`;
}

/** 摘要徽标行；只读时加 is-readonly 与 title 提示。 */
export function buildSummaryBar(context, opts = {}) {
  const writeEnabled = opts.writeEnabled !== false;
  const bar = el('div', writeEnabled ? 'ledger-sum' : 'ledger-sum is-readonly');
  if (!writeEnabled) bar.title = opts.hint || READ_ONLY_HINT;
  for (const b of buildSummaryBadges(context)) {
    const badge = el('span', `badge ledger-sum-badge${b.cls ? ` ${b.cls}` : ''}`, b.label);
    if (!writeEnabled) badge.setAttribute('aria-disabled', 'true');
    bar.append(badge);
  }
  return bar;
}

function listGroup(title, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const box = el('div', 'ledger-lg');
  box.append(el('div', 'ledger-lg-h', title));
  const ul = el('ul', 'ledger-list');
  for (const t of items) ul.append(el('li', '', t));
  box.append(ul);
  return box;
}

/**
 * 在任务详情里挂载「账本」三段，并把徽标填进标题旁的 summarySlot。
 * @param {{
 *   summarySlot: Element,
 *   container: Element,
 *   taskId: string,
 *   apiGet: (path: string) => Promise<any>,
 *   writeEnabled?: boolean,
 *   onArchived?: (body: object) => void,
 * }} deps
 * @returns {Promise<{ refresh: () => Promise<void> }>}
 */
export async function mountLedger(deps) {
  const summarySlot = deps?.summarySlot;
  const container = deps?.container;
  const taskId = String(deps?.taskId ?? '');
  const apiGet = deps?.apiGet;
  const writeEnabled = deps?.writeEnabled === true;
  const onArchived = deps?.onArchived;
  const hint = READ_ONLY_HINT;
  const ro = writeState(writeEnabled, hint);
  let context = normalizeContext(null);
  let segments = [];
  let checkpoints = [];
  let segmentsError = '';
  let hiddenOldSegments = 0;
  let selectedId = '';

  // ② .ledger 段区块
  const ledger = el('div', 'ledger');
  const head = el('div', 'ledger-h');
  head.append(el('h4', '', '账本'));
  const count = el('span', 'faint mono ledger-count', '0 段');
  head.append(count);
  const acts = el('div', 'acts');
  const captureBtn = el('button', 'sm', '捕获');
  const archiveBtn = el('button', 'sm ghost', '归档');
  const expandBtn = el('button', 'sm', '导出 expand');
  for (const btn of [captureBtn, archiveBtn]) {
    btn.disabled = ro.disabled;
    if (ro.disabled) btn.title = ro.hint;
  }
  acts.append(captureBtn, archiveBtn, expandBtn);
  head.append(acts);
  const note = el('div', 'ledger-note faint');
  const historyNote = el('div', 'ledger-note faint');
  const cmd = el('div', 'ledger-cmd mono');
  cmd.hidden = true;
  const segBox = el('div', 'ledger-segs');
  const cpBox = el('div', 'ledger-cps');
  ledger.append(head, note, historyNote, cmd, segBox, cpBox);

  // ③ .ledger-brief 简报面板（正文默认折叠，按钮常驻可点）
  const brief = el('div', 'ledger-brief');
  const briefHead = el('div', 'ledger-brief-h');
  briefHead.append(el('span', 'ledger-brief-t', '简报'), el('span', 'badge', 'briefJson'));
  const briefHint = el('span', 'faint ledger-brief-hint', '默认折叠；点「生成简报」按当前账本生成。');
  const briefActs = el('div', 'acts');
  const genBtn = el('button', 'sm primary', '生成简报');
  const copyBtn = el('button', 'sm', '复制');
  copyBtn.disabled = true;
  copyBtn.title = '生成简报后可复制';
  const toggleBtn = el('button', 'sm ghost', '展开');
  briefActs.append(genBtn, copyBtn, toggleBtn);
  briefHead.append(briefHint, briefActs);
  const briefBody = el('div', 'ledger-brief-b');
  briefBody.hidden = true;
  const pre = el(BRIEF_BLOCK_TAG, `${BRIEF_BLOCK_CLASS} ledger-brief-text`, BRIEF_EMPTY);
  briefBody.append(pre);
  brief.append(briefHead, briefBody);

  container.replaceChildren(ledger, brief);

  const setNote = (text, isError = false) => {
    note.className = isError ? 'ledger-note err' : 'ledger-note';
    note.textContent = text || '';
  };

  const renderSegments = () => {
    selectedId = '';
    segBox.replaceChildren();
    const state = emptyLedgerState(segments, segmentsError);
    if (state.empty) {
      const empty = el('div', 'empty ledger-empty');
      empty.append(el('div', 'big', state.big), el('div', '', state.hint));
      segBox.append(empty);
      return;
    }
    for (const row of buildSegmentRows(segments)) {
      const item = el('details', 'ledger-seg');
      const summary = el('summary', 'ledger-seg-h');
      summary.append(el('span', 'mono ledger-range', row.range));
      summary.append(el('span', `badge ledger-mode ${row.mode.cls}`, row.mode.label));
      if (row.quarantined) summary.append(el('span', 'badge b-warn ledger-q', row.quarantineLabel));
      summary.append(el('span', 'ledger-excerpt', row.excerpt || '（无摘要）'));
      item.append(summary);
      const body = el('div', 'ledger-seg-b');
      body.append(el('p', 'ledger-summary', row.summary || '（无摘要）'));
      for (const group of [
        listGroup('决策', row.decisions),
        listGroup('卡点', row.gotchas),
        listGroup('下一步', row.nextSteps),
      ]) {
        if (group) body.append(group);
      }
      item.append(body);
      if (row.id) {
        item.addEventListener('toggle', () => {
          if (!item.open) return;
          selectedId = row.id;
          cmd.hidden = true;
          cmd.textContent = '';
          setNote('');
        });
      }
      segBox.append(item);
    }
  };

  const CP_KEY_LABELS = {
    concepts: '概念', files: '关键文件', errorsAndFixes: '错误与修复',
    pendingJobs: '待办', nextSteps: '下一步',
    intent: '意图', currentState: '当前状态', criticalContext: '关键上下文',
  };

  const renderCheckpoints = () => {
    cpBox.replaceChildren();
    const rows = buildCheckpointRows(checkpoints);
    if (rows.length === 0) {
      cpBox.append(el('div', 'faint ledger-cp-empty', 'checkpoint 0 条（由 memory_session_checkpoint 写入，随段一起展示）'));
      return;
    }
    const h = el('div', 'ledger-lg-h', `checkpoint（${rows.length}）`);
    cpBox.append(h);
    for (const row of rows) {
      const item = el('details', 'ledger-seg ledger-cp');
      const summary = el('summary', 'ledger-seg-h');
      summary.append(el('span', 'mono ledger-range', row.time));
      // 与段行视觉对齐（issue #241 用户反馈）：checkpoint 不是捕获段、没有 rules/llm 模式，
      // 用独立的 cp 徽标占同一个位置，保持行结构一致。
      const cpBadge = el('span', 'badge ledger-mode b-accent', 'cp');
      cpBadge.setAttribute('title', 'memory_session_checkpoint 写入的检查点（非捕获段，无 rules/llm 模式）');
      summary.append(cpBadge);
      summary.append(el('span', 'ledger-excerpt', row.excerpt || '（checkpoint）'));
      item.append(summary);
      const body = el('div', 'ledger-seg-b');
      for (const t of row.texts) {
        if (t.text) body.append(el('p', 'ledger-summary', `${CP_KEY_LABELS[t.key] ?? t.key}：${t.text}`));
      }
      for (const l of row.lists) {
        if (l.items.length > 0) {
          const g = listGroup(CP_KEY_LABELS[l.key] ?? l.key, l.items);
          if (g) body.append(g);
        }
      }
      item.append(body);
      cpBox.append(item);
    }
  };

  const renderAll = () => {
    summarySlot?.replaceChildren?.(buildSummaryBar(context, { writeEnabled, hint }));
    historyNote.textContent = hiddenOldSegments > 0
      ? `已隐藏 ${hiddenOldSegments} 段旧转录（其它会话）；checkpoint 是任务级，不受影响。`
      : '';
    count.textContent = checkpoints.length > 0
      ? `${segments.length} 段 · ${checkpoints.length} checkpoint`
      : `${segments.length} 段`;
    renderSegments();
    renderCheckpoints();
  };

  const load = async () => {
    try {
      context = normalizeContext(await apiGet(`/task-context?task=${encodeURIComponent(taskId)}`));
    } catch {
      context = normalizeContext(null);
    }
    try {
      const segBody = await apiGet(`/task-segments?task=${encodeURIComponent(taskId)}`);
      const allSegments = normalizeSegments(segBody);
      const hostSessionId = context.meta?.hostSessionId;
      if (hostSessionId) {
        segments = allSegments.filter((s) => s?.source?.sessionId === hostSessionId);
        hiddenOldSegments = allSegments.length - segments.length;
      } else {
        segments = allSegments;
        hiddenOldSegments = 0;
      }
      context.segments = segments.length;
      context.covered = coveredOf(segments);
      checkpoints = normalizeCheckpoints(segBody);
      segmentsError = '';
    } catch (err) {
      segments = [];
      checkpoints = [];
      segmentsError = err?.message ? String(err.message) : 'unknown';
    }
    if (!container.isConnected) return;
    renderAll();
  };

  captureBtn.addEventListener('click', async () => {
    captureBtn.disabled = true;
    setNote('捕获中…');
    try {
      const res = await apiPost('/tasks/capture', { task: taskId });
      const body = res?.body && typeof res.body === 'object' ? res.body : {};
      if (res?.status === 403 || body.code === 'E_READ_ONLY') {
        throw new Error(body.message || '只读模式不可捕获');
      }
      if (res?.status >= 400 || body.ok === false) {
        throw new Error(`${body.code || `E_HTTP_${res?.status}`}: ${body.message || ''}`);
      }
      await load();
      setNote(`捕获完成 · 新增 ${Number(body.created ?? 0)} 段 · 跳过 ${Number(body.skipped ?? 0)} 段`);
    } catch (err) {
      setNote(`捕获失败 · ${err?.message ?? err}`, true);
    } finally {
      captureBtn.disabled = ro.disabled;
    }
  });

  archiveBtn.addEventListener('click', async () => {
    archiveBtn.disabled = true;
    try {
      const res = await apiPost('/tasks/archive', { task: taskId });
      const body = res?.body && typeof res.body === 'object' ? res.body : {};
      if (res?.status === 403 || body.code === 'E_READ_ONLY') {
        throw new Error(body.message || '只读模式不可归档');
      }
      if (res?.status >= 400 || body.ok === false) {
        throw new Error(`${body.code || `E_HTTP_${res?.status}`}: ${body.message || ''}`);
      }
      setNote(`已归档 → ${String(body.movedTo ?? '')}`);
      captureBtn.disabled = true;
      expandBtn.disabled = true;
      if (typeof onArchived === 'function') onArchived(body);
    } catch (err) {
      archiveBtn.disabled = ro.disabled;
      setNote(`归档失败 · ${err?.message ?? err}`, true);
    }
  });

  expandBtn.addEventListener('click', () => {
    cmd.hidden = false;
    cmd.textContent = expandCommand(taskId, selectedId);
  });

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    briefHint.textContent = '生成中…';
    try {
      const data = normalizeBrief(await apiGet(`/task-brief?task=${encodeURIComponent(taskId)}`));
      if (!data) throw new Error('返回体不像 briefJson');
      const text = buildBriefText(data);
      pre.textContent = text;
      copyBtn.disabled = false;
      copyBtn.title = '复制简报全文';
      const budget = data.budget ?? {};
      const used = fmtNum(budget.usedChars);
      const max = fmtNum(budget.maxChars);
      briefHint.textContent = `${fmtClock(data.generatedAt)} 生成 · ${used}/${max} 字${budget.truncated === true ? '（已截断）' : ''}`;
      briefBody.hidden = false;
      toggleBtn.textContent = '收起';
    } catch (err) {
      briefHint.textContent = `生成失败 · ${err?.message ?? err}`;
    } finally {
      genBtn.disabled = false;
    }
  });

  toggleBtn.addEventListener('click', () => {
    briefBody.hidden = !briefBody.hidden;
    toggleBtn.textContent = briefBody.hidden ? '展开' : '收起';
  });

  copyBtn.addEventListener('click', () => {
    const text = pre.textContent ?? '';
    if (!text) return;
    try {
      const p = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(text) : null;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 复制失败静默（非安全上下文 / 无剪贴板权限） */
    }
  });

  await load();
  return { refresh: load };
}
