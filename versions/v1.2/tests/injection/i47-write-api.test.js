// I47 — 人类可写入口（W7）：写 API 契约与安全门禁
// 钉住：只读 403 E_READONLY、坏 Origin 403 E_BAD_ORIGIN、正常 write、
// supersede + ifMatch 冲突 409、每次成功写入出现 op=ui_edit 审计事件。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';

const SRC = { agent: 'test' };

async function setup({ write } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i47-'));
  const service = await createMemoryService({ memoHome: home, scope: 'repo:i47', cwd: home });
  const web = await createWebServer({ memoHome: home, scope: 'repo:i47', service, port: 0, includeUi: false, write });
  return { home, service, web };
}

test('I47 默认只读：POST /api/write 未开启写模式 → 403 E_READONLY', async (t) => {
  const { service, web } = await setup();
  t.after(async () => { await web.close(); await service.close(); });
  const r = await fetch(`${web.url}api/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '一条事实', kind: 'fact', source: SRC }),
  });
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.code, 'E_READONLY');
  // 只读模式下确实没写进去
  const got = await service.search('事实');
  assert.equal(got.items.length, 0);
});

test('I47 坏 Origin：外域 / 端口不同 → 403 E_BAD_ORIGIN；同源放行', async (t) => {
  const { service, web } = await setup({ write: true });
  t.after(async () => { await web.close(); await service.close(); });
  const port = new URL(web.url).port;
  const post = (headers) => fetch(`${web.url}api/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ text: '本机端口事实', kind: 'fact', subject: 'i47', predicate: 'p', value: 'v', source: SRC }),
  });
  const evil = await post({ origin: 'https://evil.example.com' });
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).code, 'E_BAD_ORIGIN');
  const otherPort = await post({ referer: `http://127.0.0.1:${Number(port) + 1}/admin` });
  assert.equal(otherPort.status, 403);
  // 同源（本服务自己的 URL）正常写入；无 Origin 的 fetch 同源默认不带 header
  const ok = await fetch(`${web.url}api/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(web.url).origin },
    body: JSON.stringify({ text: '本机端口事实', kind: 'fact', subject: 'i47', predicate: 'p', value: 'v', source: SRC }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

test('I47 write/supersede/forget 全链路：审计 ui_edit 事件 + ifMatch 冲突 409', async (t) => {
  const { service, web } = await setup({ write: true });
  t.after(async () => { await web.close(); await service.close(); });

  // 正常 write
  const w = await fetch(`${web.url}api/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '观察台端口是 7788', kind: 'fact', subject: 'observer', predicate: 'port', value: '7788', source: SRC }),
  });
  assert.equal(w.status, 200);
  const wBody = await w.json();
  assert.equal(wBody.ok, true);
  assert.equal(wBody.action, 'created');
  const id = wBody.id;

  // 非 JSON body → 400
  const bad = await fetch(`${web.url}api/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'E_INVALID_JSON');
  // 超限 body → 413
  const big = await fetch(`${web.url}api/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(big.status, 413);

  // supersede 不带 ifMatch → 成功，旧记录关闭
  const s1 = await fetch(`${web.url}api/supersede`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, value: '7789', text: '观察台端口是 7789', reason: '端口改了' }),
  });
  assert.equal(s1.status, 200);
  const newId = (await s1.json()).id;

  // ifMatch 传旧 validFrom（记录已被改过）→ 409 E_CONFLICT
  const cur = await service.get(newId);
  const s2 = await fetch(`${web.url}api/supersede`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: newId, value: '7800', reason: '再改', ifMatch: '2020-01-01T00:00:00.000Z' }),
  });
  assert.equal(s2.status, 409);
  assert.equal((await s2.json()).code, 'E_CONFLICT');

  // ifMatch 匹配当前 validFrom → 成功
  const s3 = await fetch(`${web.url}api/supersede`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: newId, value: '7800', reason: '再改', ifMatch: cur.validFrom }),
  });
  assert.equal(s3.status, 200);

  // forget → 墓碑
  const fid = (await s3.json()).id;
  const f = await fetch(`${web.url}api/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: fid, mode: 'tombstone', reason: '过期' }),
  });
  assert.equal(f.status, 200);
  const fRec = await service.get(fid);
  assert.equal(fRec.status, 'tombstoned');

  // 审计：ui_edit 事件已出现（write/supersede/forget 各至少一条）
  const evs = await service.events({ ops: ['ui_edit'] });
  const ops = evs.events?.map((e) => e.detail?.action) ?? [];
  assert.ok(ops.includes('created'), `审计缺 created: ${JSON.stringify(evs)}`);
  assert.ok(ops.includes('supersede'), '审计缺 supersede');
  assert.ok(ops.includes('forget'), '审计缺 forget');
});
