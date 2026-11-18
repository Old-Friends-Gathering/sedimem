/**
 * ledger-checkpoints.js —— 任务账本的 checkpoint 列表（v1.4.1 从 ledger-view.js 拆出）。
 *
 * checkpoint 由 MCP memory_session_checkpoint 写入 items（不在 segments.jsonl），
 * 服务端 /api/task-segments 已合并进响应。本模块只做形状防御与列表项构造，
 * 渲染时由调用方注入 el()/listGroup()（保持 ui/ 零构建、无框架）。
 */

/** checkpoint 8 段的中文标签。 */
export const CP_KEY_LABELS = {
  concepts: '概念', files: '关键文件', errorsAndFixes: '错误与修复',
  pendingJobs: '待办', nextSteps: '下一步',
  intent: '意图', currentState: '当前状态', criticalContext: '关键上下文',
};

/**
 * `/api/task-segments` 返回 → checkpoint 数组（v1.4.x）。
 * 缺字段/旧服务端 → []（不抛，账本页照常渲染段）。
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

/**
 * 把 checkpoint 列表渲染进 cpBox。
 * @param {HTMLElement} cpBox 容器
 * @param {Array} checkpoints 归一化后的 checkpoint 数组
 * @param {{el:Function, listGroup:Function}} deps DOM 构造依赖（来自 ledger-view）
 */
export function renderCheckpointsInto(cpBox, checkpoints, deps) {
  const { el, listGroup } = deps;
  cpBox.replaceChildren();
  const rows = buildCheckpointRows(checkpoints);
  if (rows.length === 0) {
    cpBox.append(el('div', 'faint ledger-cp-empty', 'checkpoint 0 条（由 memory_session_checkpoint 写入，随段一起展示）'));
    return;
  }
  cpBox.append(el('div', 'ledger-lg-h', `checkpoint（${rows.length}）`));
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
}
