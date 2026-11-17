// web/api/task-ledger.js — 任务账本只读端点（v1.2 A1；契约：docs/SEGMENT-SPEC.md §1/§5/§7）
//
// 三条端点都以 `?task=<taskId>` 定位（taskId 形如 20261114-2221-6a5b），**不使用 ?scope=**：
//   任务账本落在 `$MEMO_HOME/sessions/<taskId>/`，而「分库」是 repo:/dir:/session: 这套记录命名空间，
//   两套目录互不隶属。UI 的 apiGet 会自动带上当前分库的 ?scope=，所以这里必须显式忽略它
//   （server.js 对这些路径直接跳过 scope 解析，见 TASK_QUERY_PATHS），
//   否则用户在任务页切分库时会 400（非法 scope）或看到别的分库截面。
//
// 错误契约（SPEC §7）：task 非法（不匹配 TASK_ID_RE）→ E_INVALID_ARG(400)；任务不存在 → E_NOT_FOUND(404)。

import { existsSync } from 'node:fs';
import path from 'node:path';

import { invalidArg, notFound } from '../../core/errors.js';
import { coveredSeqs, readIndex, readSegments } from '../../session/ledger.js';
import {
  DEFAULT_MAX_CHARS, briefJson, readTaskMeta,
} from '../../session/ledger-brief.js';
import { intArg } from './shared.js';

/** 任务 ID 契约（与 session start 的 id 形状一致：小写字母/数字开头，1..64 字符）。 */
export const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 任务账本端点表：这些路径**不吃 ?scope=**（理由见文件头）。
 * server.js 用它跳过 serviceFor(scope) 解析——否则 ?scope=session:<别的任务> 会白白现开一个 service。
 */
export const TASK_QUERY_PATHS = new Set(['/api/task-segments', '/api/task-brief', '/api/task-context']);

/** 解析并校验必填 query 参数 task。 */
export function parseTaskArg(query) {
  const raw = query.get('task');
  if (raw === null || raw === '') throw invalidArg('missing required query param: task');
  if (!TASK_ID_RE.test(raw)) {
    throw invalidArg(`task must look like 20261114-2221-6a5b (pattern ${TASK_ID_RE}), got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * 任务存在判定：账本目录（meta/segments/index 任一）或 v1.2 之前的登记文件
 * `sessions/<taskId>.json` 存在即视为存在。空任务（只有 meta、还没有段）也要能打开，
 * 所以不能只按 segments.jsonl 判断。
 */
function taskExists(memoHome, taskId) {
  const dir = path.join(memoHome, 'sessions', taskId);
  return existsSync(path.join(dir, 'meta.json'))
    || existsSync(path.join(dir, 'segments.jsonl'))
    || existsSync(path.join(dir, 'index.json'))
    || existsSync(path.join(memoHome, 'sessions', `${taskId}.json`));
}

function requireTask(service, query) {
  const taskId = parseTaskArg(query);
  if (!taskExists(service.memoHome, taskId)) {
    throw notFound(`task ${taskId} 不存在（sessions/${taskId}/ 与 sessions/${taskId}.json 均缺失）`);
  }
  return taskId;
}

/**
 * GET /api/task-segments?task=<id>
 * → { task, segments: 完整段记录[]（fromSeq 升序）, badLines, index }
 * 段记录原样返回（含 anchor/source/tokens/trust 等字段），供 UI 展示区间与展开入口。
 */
export async function apiTaskSegments(service, query) {
  const task = requireTask(service, query);
  const { segments, badLines } = readSegments({ memoHome: service.memoHome, taskId: task });
  return {
    task,
    segments: [...segments].sort((a, b) => {
      const fa = Number.isFinite(a?.fromSeq) ? a.fromSeq : 0;
      const fb = Number.isFinite(b?.fromSeq) ? b.fromSeq : 0;
      if (fa !== fb) return fa - fb;
      return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
    }),
    badLines,
    index: readIndex({ memoHome: service.memoHome, taskId: task }),
  };
}

/**
 * GET /api/task-brief?task=<id>&asOf=<ISO 可选>&maxChars=<int 可选，默认 2200>
 * → briefJson 的结果**展开在顶层**（task 是对象 {id,title,state}，与 task-context 的字符串 task 不同）。
 */
export async function apiTaskBrief(service, query) {
  const task = requireTask(service, query);
  const maxChars = intArg(query, 'maxChars', { min: 1, max: 100000, fallback: DEFAULT_MAX_CHARS });
  const asOf = query.get('asOf') || undefined;
  if (asOf !== undefined && !Number.isFinite(Date.parse(asOf))) {
    throw invalidArg(`asOf must be an ISO-8601 string, got ${JSON.stringify(asOf)}`);
  }
  return briefJson({
    memoHome: service.memoHome,
    taskId: task,
    ...(asOf !== undefined ? { asOf } : {}),
    maxChars,
  });
}

/**
 * GET /api/task-context?task=<id>
 * → { task: 字符串, meta, segments: 段数, covered: [[from,to)], briefChars, lastCapturedAt }
 * 供任务页顶栏一行摘要；不返回段正文（正文走 task-segments）。
 */
export async function apiTaskContext(service, query) {
  const task = requireTask(service, query);
  const memoHome = service.memoHome;
  const { segments } = readSegments({ memoHome, taskId: task });
  const brief = briefJson({ memoHome, taskId: task });
  const lastCapturedAt = segments
    .map((s) => s?.createdAt)
    .filter((t) => typeof t === 'string' && t !== '')
    .sort()
    .at(-1) ?? null;
  return {
    task,
    meta: readTaskMeta(memoHome, task)?.meta ?? null,
    segments: segments.length,
    covered: coveredSeqs({ memoHome, taskId: task }),
    // briefChars：简报预算已用量（与 GET /api/task-brief 的 budget.usedChars 同口径），
    // UI 顶栏用它显示「简报占 X 字符」；渲染后的可读字符数由 /api/task-brief 自己决定。
    briefChars: brief.budget.usedChars,
    lastCapturedAt,
  };
}
