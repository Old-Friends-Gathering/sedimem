// web/api/write.js — 人类可写 HTTP 入口（W7 波次）
// 契约：
//   POST /api/write     {text, kind, title?, subject?, predicate?, value?, source?}
//   POST /api/supersede {id, text?, value?, title?, reason, ifMatch?}
//   POST /api/forget    {id, mode:"tombstone"|"purge", reason}
// 安全纪律：
//   1. 默认只读：未显式开启写模式 → 403 E_READONLY
//   2. 防 CSRF（B4 收紧）：写请求必须带 Origin，且与 Host 同源；缺失/跨源 → 403 E_BAD_ORIGIN
//   3. 请求体 ≤ 64KB（E_PAYLOAD_TOO_LARGE）；非法 JSON → 400 E_INVALID_JSON
//   4. 编辑审计：每次成功写入追加一条 op=ui_edit 事件（绝不原地改真相层：编辑走 supersede）
import { invalid, invalidArg, notFound } from '../../core/errors.js';
import { assertSameOriginStrict } from '../auth.js';
import { captureTask } from '../../session/capture.js';
import { archiveTask } from '../../session/ledger.js';
import { isSessionScope, listSessions, renameSession, removeSession } from '../../session/lifecycle.js';
import { TASK_ID_RE } from './task-ledger.js';

/** 请求体上限：64KB */
const MAX_BODY_BYTES = 64 * 1024;

/** 端点 → 处理函数注册表（由 handlers.js 组装后传入，避免循环 import） */

/** 构造带 code 的 HTTP 语义错误 */
function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 防 CSRF：**写请求必须带 Origin 且与 Host 同源**（B4 收紧，docs/02 §3.24）。
 *
 * 与旧实现的差别：旧版「没有 Origin/Referer 就放行」，而 curl/CLI 和 CSRF 页面都能做到
 * 「不带 Origin」，等于没防护。现在缺 Origin 一律 403；命令行写库应直接用 `memo` CLI 或
 * 带 Bearer + Origin 的脚本。
 * 具体比较逻辑在 src/web/auth.js（Host 校验也复用同一份），这里只保留对外契约名。
 * @param {http.IncomingMessage} req
 * @param {number} serverPort 本服务实际监听端口
 */
export function assertSameOrigin(req, serverPort) {
  return assertSameOriginStrict(req, serverPort);
}

/**
 * 读取并解析 JSON 请求体：>64KB → E_PAYLOAD_TOO_LARGE；解析失败 → E_INVALID_JSON。
 * @returns {Promise<object>}
 */
export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw coded('E_PAYLOAD_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节上限`);
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw coded('E_INVALID_JSON', '请求体不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw coded('E_INVALID_JSON', '请求体必须是 JSON 对象');
  }
  return parsed;
}

/** 写模式门禁：createWebServer 未传 {write:true} 且 MEMO_WRITE!==1 → 403 */
export function assertWritable(opts) {
  if (!opts || opts.write !== true) {
    throw coded('E_READONLY', '服务处于只读模式：需启动时传 {write:true} 或设置环境变量 MEMO_WRITE=1');
  }
}

/** 追加一条 ui_edit 审计事件（沿既有事件通道 service._event(op, id, detail)） */
async function audit(service, id, action, reason) {
  await service._event('ui_edit', id, { action, reason: reason ?? null });
}

/** POST /api/write — 走既有 service.write */
export async function apiWrite(service, body) {
  if (typeof body.text !== 'string' || body.text.length === 0) {
    throw invalid('write: text (non-empty string) is required');
  }
  const result = await service.write({
    text: body.text,
    kind: body.kind,
    title: body.title,
    subject: body.subject,
    predicate: body.predicate,
    value: body.value,
    source: body.source,
  });
  await audit(service, result.record.id, result.action, null);
  return { id: result.record.id, action: result.action };
}

/** POST /api/supersede — append 新记录 + 关闭旧记录；ifMatch 防并发覆盖 */
export async function apiSupersede(service, body) {
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw invalid('supersede: id is required');
  }
  // 乐观锁：ifMatch 是调用方看到的旧记录 validFrom；已被别人改过则拒绝（409）
  const current = await service.get(body.id);
  if (!current) throw notFound(`supersede: record ${body.id} not found`);
  if (body.ifMatch !== undefined && body.ifMatch !== current.validFrom) {
    throw coded('E_CONFLICT', `记录已被并发修改：当前 validFrom=${current.validFrom}，请求 ifMatch=${body.ifMatch}`);
  }
  const result = await service.supersede({
    oldId: body.id,
    text: body.text,
    value: body.value,
    title: body.title,
    source: body.source,
    reason: body.reason,
  });
  await audit(service, result.record.id, 'supersede', body.reason);
  return { id: result.record.id, oldId: body.id, action: 'supersede' };
}

/** POST /api/forget — 走既有 service.forget（tombstone 默认 / purge 标记） */
export async function apiForget(service, body) {
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw invalid('forget: id is required');
  }
  const result = await service.forget({ id: body.id, mode: body.mode, reason: body.reason });
  await audit(service, body.id, 'forget', body.reason);
  return result;
}

// ===== I52：任务库管理端点（GET /api/tasks 在 handlers.js 注册，POST 写端点在此）=====

/** GET /api/tasks — 任务库清单（复用 listSessions；只读） */
export function apiTasks(service) {
  const { tasks } = listSessions({ memoHome: service.memoHome });
  return { tasks };
}

function requireSessionScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0 || !isSessionScope(scope)) {
    throw invalidArg('tasks: scope 必须形如 session:<id>');
  }
  return scope;
}

/** POST /api/tasks/rename — body {scope, title} */
export async function apiTaskRename(service, body) {
  const scope = requireSessionScope(body.scope);
  if (typeof body.title !== 'string' || body.title.length === 0) {
    throw invalidArg('tasks/rename: title (non-empty string) is required');
  }
  try {
    const { title, previous } = renameSession({ memoHome: service.memoHome, scope, title: body.title });
    const task = listSessions({ memoHome: service.memoHome }).tasks.find((t) => t.scope === scope) ?? null;
    return { task, title, previous };
  } catch (e) {
    if (e?.code === 'E_INVALID_ARG') throw invalidArg('tasks/rename: title 须 1..80 字符（去空白）且不含换行');
    throw e;
  }
}

/** POST /api/tasks/remove — body {scope} */
export async function apiTaskRemove(service, body) {
  const scope = requireSessionScope(body.scope);
  const { movedTo, files } = removeSession({ memoHome: service.memoHome, scope });
  // 不把绝对路径递给浏览器：只回 trash 子目录名与文件名
  return { movedTo: movedTo.split(/[/\\]/).pop(), files };
}

/** POST /api/records/tombstone — body {scope, id, reason}；对指定分库的记录打墓碑 */
export async function apiRecordTombstone(service, body, opts = {}) {
  if (typeof body.id !== 'string' || body.id.length === 0) {
    throw invalidArg('records/tombstone: id is required');
  }
  const reason = typeof body.reason === 'string' && body.reason !== '' ? body.reason : 'ui-tombstone';
  // 指定了 scope 时对该分库现开/复用服务；未指定用启动分库
  let target = service;
  if (body.scope !== undefined && body.scope !== null && body.scope !== '') {
    if (typeof body.scope !== 'string' || !isSessionScope(body.scope)) {
      throw invalidArg('records/tombstone: scope 必须形如 session:<id> 或省略');
    }
    const { createMemoryService } = await import('../../api/service.js');
    target = await createMemoryService({ memoHome: service.memoHome, scope: body.scope });
  }
  try {
    const current = await target.get(body.id);
    if (!current) throw notFound(`records/tombstone: record ${body.id} not found`);
    await target.forget({ id: body.id, reason });
    await audit(target, body.id, 'forget', reason);
  } finally {
    if (target !== service) await target.close().catch(() => {});
  }
  return { id: body.id };
}

/** 校验 body.task：任务库端点统一用 task=<taskId>（与只读账本端点同名同形，UI 不必转两套字段）。 */
function requireTaskId(body, endpoint) {
  const task = body?.task;
  if (typeof task !== 'string' || task === '') {
    throw invalidArg(`${endpoint}: task (non-empty string) is required`);
  }
  if (!TASK_ID_RE.test(task)) {
    throw invalidArg(`${endpoint}: task 必须形如 20261114-2221-6a5b，收到 ${JSON.stringify(task)}`);
  }
  return task;
}

/**
 * 捕获事件的审计行（v1.2 A2）：`{ts, op:'task_capture', scope:'session:<task>', id:null, detail}`
 * 为什么 scope 直接写 session:<taskId> 而不走 service._event：_event 会把 scope 换成「当前分库」，
 * 而任务账本不属于任何分库——与 session/lifecycle.js removeSession 的审计行同一口径。
 * 复用 service.store.appendEvent（同一把 memoHome 写锁 + 同一个 events.jsonl），不另造 writer。
 */
async function appendCaptureEvent(service, taskId, { created, skipped, mode }) {
  await service.store.appendEvent({
    ts: service._nowIso(),
    op: 'task_capture',
    scope: `session:${taskId}`,
    id: null,
    detail: { created, skipped, mode },
  });
}

/**
 * POST /api/tasks/capture — body {task, mode?:'rules'|'llm', cwd?}
 * 调 captureTask 把 DSH 转录里尚未覆盖的区间抽成段；cwd 缺省用服务启动时的 cwd
 * （任务页面捕获的就是「本服务所在项目」的会话）。
 */
export async function apiTaskCapture(service, body) {
  const task = requireTaskId(body, 'tasks/capture');
  const mode = body?.mode ?? 'rules';
  if (mode !== 'rules' && mode !== 'llm') {
    throw invalidArg(`tasks/capture: mode 只能是 'rules' 或 'llm'，收到 ${JSON.stringify(mode)}`);
  }
  if (body?.cwd !== undefined && (typeof body.cwd !== 'string' || body.cwd === '')) {
    throw invalidArg('tasks/capture: cwd 必须是非空字符串（绝对路径）');
  }
  const cwd = body?.cwd ?? process.cwd();
  const result = await captureTask({ memoHome: service.memoHome, taskId: task, cwd, mode });
  await appendCaptureEvent(service, task, { created: result.created, skipped: result.skipped, mode });
  return { created: result.created, skipped: result.skipped, segments: result.segments };
}

/** POST /api/tasks/archive — body {task}；只回归档目录名（不把绝对路径递给浏览器）。 */
export async function apiTaskArchive(service, body) {
  const task = requireTaskId(body, 'tasks/archive');
  const { name } = await archiveTask({ memoHome: service.memoHome, taskId: task });
  return { movedTo: name };
}

/**
 * 分发一个 POST 写请求（handlers.js 调用）。
 * I52 任务库端点：未开启写模式 → 403 {code:'E_READ_ONLY'}（与既有 E_READONLY 语义一致，
 * 用独立 code 供 UI 区分「任务库写被拒」）。
 * @param {object} service MemoryService
 * @param {string} pathname 请求路径
 * @param {object} body 已解析的 JSON body
 * @param {{write?: boolean, serverPort?: number}} opts 写模式与端口上下文
 */
export async function handleWriteApi(service, pathname, body, opts) {
  const isTaskWrite = pathname === '/api/tasks/rename' || pathname === '/api/tasks/remove'
    || pathname === '/api/tasks/capture' || pathname === '/api/tasks/archive'
    || pathname === '/api/records/tombstone';
  if (isTaskWrite && opts?.write !== true) {
    throw coded('E_READ_ONLY', '服务处于只读模式：任务库写操作需启动时传 {write:true} 或设置 MEMO_WRITE=1');
  }
  assertWritable(opts);
  assertSameOrigin(opts?.req, opts?.serverPort);
  const routes = {
    '/api/write': apiWrite,
    '/api/supersede': apiSupersede,
    '/api/forget': apiForget,
    '/api/tasks/rename': apiTaskRename,
    '/api/tasks/remove': apiTaskRemove,
    '/api/tasks/capture': apiTaskCapture,
    '/api/tasks/archive': apiTaskArchive,
    '/api/records/tombstone': apiRecordTombstone,
  };
  const handler = routes[pathname];
  if (!handler) return { status: 404, body: { ok: false, code: 'E_NOT_FOUND', message: `unknown endpoint: ${pathname}` } };
  const payload = await handler(service, body);
  return { status: 200, body: { ok: true, ...payload } };
}
