// session/handoff.js — 交接文档渲染与落盘（v0.6 W2，契约：docs/plans/v0.6 §2.5）
// 六节模板：做了什么 / 关键决策 / 踩过的坑 / 改了哪些文件 / 未完成事项 / 下次开工入口。

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/** 数组转 Markdown 列表；空数组 → 占位行（六节必须节节在场，不能整节消失） */
function bulletList(items) {
  const list = Array.isArray(items) ? items.map(String).filter((s) => s !== '') : [];
  if (list.length === 0) return '（无）\n';
  return list.map((s) => `- ${s}`).join('\n') + '\n';
}

function para(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  return s === '' ? '（无）\n' : s + '\n';
}

/**
 * 渲染交接文档（六节 Markdown）。
 * @param {{sessionId: string, meta?: object, checkpoint?: object,
 *          promoted?: Array<{kind: string, title?: string, text?: string, id?: string}>,
 *          pending?: string[]}} args
 *   promoted：已晋升主库的记录（close 时传入）；pending：未完成事项补充（checkpoint 之外的）。
 * @returns {string} Markdown
 */
export function renderHandoff({ sessionId, meta, checkpoint, promoted = [], pending = [] }) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw err('E_INVALID_ARG', `renderHandoff: sessionId is required, got ${JSON.stringify(sessionId)}`);
  }
  const cp = checkpoint ?? {};
  const decisions = promoted.filter((p) => p && p.kind === 'decision');
  const gotchas = promoted.filter((p) => p.kind === 'gotcha');
  const lines = [];
  lines.push(`# 会话交接：${sessionId}\n`);
  if (meta) {
    const started = meta.startedAt ? `（开始于 ${meta.startedAt}）` : '';
    lines.push(meta.title ? `- 标题：${meta.title} ${started}` : `- ${started}`.trim());
    if (meta.repo) lines.push(`- 仓库：${meta.repo}`);
    lines.push('');
  }

  lines.push('## 做了什么\n');
  lines.push(para(cp.intent ? `${cp.intent}` : ''));
  if (cp.currentState) lines.push(`${cp.currentState}\n`);

  lines.push('## 关键决策\n');
  if (decisions.length > 0) {
    for (const d of decisions) lines.push(`- ${d.title ?? d.text ?? d.id ?? '(decision)'}`);
    lines.push('');
  } else {
    lines.push('（无）\n');
  }

  lines.push('## 踩过的坑\n');
  if (cp.errorsAndFixes && cp.errorsAndFixes.length > 0) {
    lines.push(bulletList(cp.errorsAndFixes));
  }
  if (gotchas.length > 0) {
    for (const g of gotchas) lines.push(`- ${g.title ?? g.text ?? g.id ?? '(gotcha)'}`);
    lines.push('');
  }
  if ((!cp.errorsAndFixes || cp.errorsAndFixes.length === 0) && gotchas.length === 0) {
    lines.push('（无）\n');
  }

  lines.push('## 改了哪些文件\n');
  lines.push(bulletList(cp.files));

  lines.push('## 未完成事项\n');
  const pendingAll = [...(Array.isArray(cp.pendingJobs) ? cp.pendingJobs : []), ...pending];
  lines.push(bulletList(pendingAll));

  lines.push('## 下次开工入口\n');
  if (Array.isArray(cp.nextSteps) && cp.nextSteps.length > 0) {
    lines.push(bulletList(cp.nextSteps));
  } else {
    lines.push('（无）\n');
  }
  if (cp.criticalContext) lines.push(`> 关键上下文：${cp.criticalContext}\n`);
  return lines.join('\n');
}

/**
 * 写交接文档到 <memoHome>/handoffs/<sessionId>.md（幂等覆盖）。
 * @param {{memoHome: string, sessionId: string, markdown: string}} args
 * @returns {string} 绝对路径
 */
export function writeHandoff({ memoHome, sessionId, markdown }) {
  if (!memoHome) throw err('E_INVALID_ARG', 'writeHandoff: memoHome is required');
  if (!sessionId || typeof sessionId !== 'string') {
    throw err('E_INVALID_ARG', `writeHandoff: sessionId is required, got ${JSON.stringify(sessionId)}`);
  }
  if (typeof markdown !== 'string' || markdown === '') {
    throw err('E_INVALID_ARG', 'writeHandoff: markdown (non-empty string) is required');
  }
  const dir = path.join(memoHome, 'handoffs');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.md`);
  writeFileSync(file, markdown, 'utf8');
  return file;
}
