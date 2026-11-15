// I52 — 任务库管理（listSessions/rename/remove + records tombstone 的 Web 契约）
// 用户要求「任务库按任务标题命名」「可以自由删减」。钉住：
//   1. GET /api/tasks 列出任务库（含 title，来自 sessions/<id>.json 登记文件）
//   2. POST /api/tasks/rename 改 title 后 GET 立即生效
//   3. POST /api/tasks/remove 把任务库移入 trash/，之后 /api/scopes 不再列出该 scope
//   4. POST /api/records/tombstone 对任务库单条记录打墓碑，之后 /api/records?scope= 不含该 id
//   5. 只读模式下三个 POST 全部 403 {code:'E_READ_ONLY'}；参数非法 400，不暴露内部路径

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';
import { writeSessionRegistry } from '../../src/session/lifecycle.js';

const SRC = { agent: 'test' };
const SESSION_SCOPE = 'session:20261114-2200-i52a';

async function setup({ write } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i52-'));
  const main = await createMemoryService({ memoHome: home, scope: 'repo:i52', cwd: home });
  // 造一个任务库：登记文件 + 两条记录（像 `memo session start` 一样）
  writeSessionRegistry(home, SESSION_SCOPE, {
    id: '20261114-2200-i52a', title: '重构任务库管理', status: 'open',
    startedAt: '2026-11-14T22:00:00Z', parentScope: 'repo:i52',
  });
  const sess = await createMemoryService({ memoHome: home, scope: SESSION_SCOPE, cwd: home, session: true });
  const w1 = await sess.write({ text: '任务：把任务库列表接到 UI', kind: 'state', source: SRC });
  await sess.write({ text: '坑：listSessions 忘了读 sessions/ 登记文件', kind: 'gotcha', source: SRC });
  await sess.close();
  const web = await createWebServer({
    memoHome: home, scope: 'repo:i52', service: main, port: 0, includeUi: false, write,
  });
  return { home, main, web, recordId: w1.record.id };
}

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('I52 GET /api/tasks 列出任务库（含 title）；rename 后生效；remove 后 /api/scopes 不含该 scope', async (t) => {
  const { home, main, web, recordId } = await setup({ write: true });
  t.after(async () => { await web.close(); await main.close(); });

  // 1) 列表含 title
  const listRes = await fetch(`${web.url}api/tasks`);
  assert.equal(listRes.status, 200);
  const { ok, tasks } = await listRes.json();
  assert.equal(ok, true);
  const task = tasks.find((x) => x.scope === SESSION_SCOPE);
  assert.ok(task, `任务库应在 /api/tasks 里: ${JSON.stringify(tasks)}`);
  assert.equal(task.title, '重构任务库管理');
  assert.equal(task.status, 'open');
  assert.ok(task.records >= 2, `records 应计入 active 行: ${task.records}`);

  // 2) rename 后 GET 生效
  const rn = await post(`${web.url}api/tasks/rename`, { scope: SESSION_SCOPE, title: 'I52 收尾' });
  assert.equal(rn.status, 200);
  const rnBody = await rn.json();
  assert.equal(rnBody.ok, true);
  assert.equal(rnBody.task.title, 'I52 收尾');
  assert.equal(rnBody.task.scope, SESSION_SCOPE);
  const list2 = await (await fetch(`${web.url}api/tasks`)).json();
  assert.equal(list2.tasks.find((x) => x.scope === SESSION_SCOPE).title, 'I52 收尾');

  // rename 参数校验：缺 title / 坏 scope / 换行 title → 400，且不暴露内部路径
  const noTitle = await post(`${web.url}api/tasks/rename`, { scope: SESSION_SCOPE });
  assert.equal(noTitle.status, 400);
  assert.equal((await noTitle.json()).code, 'E_INVALID_ARG');
  const badScope = await post(`${web.url}api/tasks/rename`, { scope: 'repo:x', title: 't' });
  assert.equal(badScope.status, 400);
  const nlTitle = await post(`${web.url}api/tasks/rename`, { scope: SESSION_SCOPE, title: 'a\nb' });
  assert.equal(nlTitle.status, 400);
  const nlBody = await nlTitle.json();
  assert.ok(!JSON.stringify(nlBody).includes(home), '错误响应不得带内部路径');

  // 3) 单条记录 tombstone：/api/records?scope= 不再含该 id
  const tb = await post(`${web.url}api/records/tombstone`, { scope: SESSION_SCOPE, id: recordId, reason: 'i52 测试' });
  assert.equal(tb.status, 200);
  assert.equal((await tb.json()).id, recordId);
  const recs = await (await fetch(`${web.url}api/records?scope=${encodeURIComponent(SESSION_SCOPE)}`)).json();
  const ids = (recs.records ?? []).map((r) => r.id);
  assert.ok(!ids.includes(recordId), `墓碑后的记录不应再出现: ${ids.join(',')}`);

  // 4) remove 后 /api/scopes 不含该 scope，且文件进了 trash/
  const rm = await post(`${web.url}api/tasks/remove`, { scope: SESSION_SCOPE });
  assert.equal(rm.status, 200);
  const rmBody = await rm.json();
  assert.equal(rmBody.ok, true);
  assert.match(rmBody.movedTo, /^\d{8}-\d{6}$/, 'movedTo 只回 trash 子目录名，不递绝对路径');
  const scopes = (await (await fetch(`${web.url}api/scopes`)).json()).scopes.map((s) => s.scope);
  assert.ok(!scopes.includes(SESSION_SCOPE), `移除后不应再列出: ${scopes.join(',')}`);
  const trashDir = path.join(home, 'trash', rmBody.movedTo);
  assert.ok(await fsp.stat(path.join(trashDir, `${SESSION_SCOPE}.jsonl`)).then(() => true, () => false), 'items 文件应在 trash/');

  // remove 不存在的 scope → 404 E_NOT_FOUND
  const gone = await post(`${web.url}api/tasks/remove`, { scope: SESSION_SCOPE });
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).code, 'E_NOT_FOUND');
});

test('I52 只读模式：三个 POST 全部 403 {code:"E_READ_ONLY"}，不改任何文件', async (t) => {
  // 显式 write:false：write:true 的服务会把 MEMO_WRITE 写进进程环境（server.js W7），
  // 不显式关掉会让本用例读到「上一个服务开了写」的残留
  const { home, main, web } = await setup({ write: false });
  t.after(async () => { await web.close(); await main.close(); });
  const itemsBefore = await fsp.readFile(path.join(home, 'items', `${SESSION_SCOPE}.jsonl`), 'utf8');

  for (const [pathn, body] of [
    ['/api/tasks/rename', { scope: SESSION_SCOPE, title: '不该生效' }],
    ['/api/tasks/remove', { scope: SESSION_SCOPE }],
    ['/api/records/tombstone', { scope: SESSION_SCOPE, id: 'whatever', reason: 'x' }],
  ]) {
    const r = await post(`${web.url}${pathn.slice(1)}`, body);
    assert.equal(r.status, 403, `${pathn} 应 403`);
    const jb = await r.json();
    assert.equal(jb.code, 'E_READ_ONLY', `${pathn} 应回 E_READ_ONLY`);
  }
  const itemsAfter = await fsp.readFile(path.join(home, 'items', `${SESSION_SCOPE}.jsonl`), 'utf8');
  assert.equal(itemsAfter, itemsBefore, '只读模式不得改动真相层');
});
