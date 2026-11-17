// tests/unit/web-auth.test.js — B4：Web 最小鉴权（token / cookie / Host / Origin）
// 契约：docs/02 §3.24、docs/08 §7。
// 负向用例必须走 rawFetch / 裸 http.request：测试垫片会自动补 token，补上就测不出 401。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createWebServer } from '../../src/web/server.js';
import { createMemoryService } from '../../src/api/service.js';
import { AUTH_COOKIE } from '../../src/web/auth.js';

const SCOPE = 'repo:web-auth';

function rawReq(port, reqPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function setup({ write = true } = {}) {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-auth-'));
  const service = await createMemoryService({ memoHome, scope: SCOPE });
  const web = await createWebServer({ memoHome, scope: SCOPE, port: 0, includeUi: true, service, write });
  return { memoHome, service, web, port: web.server.address().port, origin: new URL(web.url).origin };
}

test('B4 Web 鉴权：无 token → 401；Bearer / cookie → 200', async (t) => {
  const { memoHome, service, web, port } = await setup();
  t.after(async () => { await web.close(); await service.close(); fs.rmSync(memoHome, { recursive: true, force: true }); });

  // 1) 没 token：所有 /api/* 一律 401，且不泄漏端点是否存在
  for (const p of ['/api/summary', '/api/nope', '/api/today']) {
    const r = await rawReq(port, p);
    assert.equal(r.status, 401, `${p} 无 token 应 401，实际 ${r.status}`);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'E_UNAUTHORIZED');
    assert.match(String(r.headers['www-authenticate'] ?? ''), /^Bearer/);
  }
  // 写端点同样先认证：未认证时拿不到 403 E_READONLY / 405
  const post = await rawReq(port, '/api/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 401);

  // 2) Bearer → 200
  const bear = await rawReq(port, '/api/summary', { headers: { authorization: `Bearer ${web.token}` } });
  assert.equal(bear.status, 200);
  assert.equal(JSON.parse(bear.body).ok, true);

  // 3) cookie → 200（值与 token 相同，页面 JS 读不到）
  const cook = await rawReq(port, '/api/summary', { headers: { cookie: `${AUTH_COOKIE}=${web.token}` } });
  assert.equal(cook.status, 200);

  // 4) 错 token → 401
  const bad = await rawReq(port, '/api/summary', { headers: { authorization: `Bearer ${'x'.repeat(43)}` } });
  assert.equal(bad.status, 401);
});

test('B4 Web 鉴权：GET / 下发 HttpOnly+SameSite=Strict cookie，页面不含 token', async (t) => {
  const { memoHome, service, web, port } = await setup();
  t.after(async () => { await web.close(); await service.close(); fs.rmSync(memoHome, { recursive: true, force: true }); });

  const r = await rawReq(port, '/');
  assert.equal(r.status, 200);
  const setCookie = String(r.headers['set-cookie']?.[0] ?? '');
  assert.match(setCookie, new RegExp(`^${AUTH_COOKIE}=${web.token};`), 'cookie 值必须是会话 token');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal(r.body.includes(web.token), false, '页面正文不得出现 token（JS 读 token 的前提就是它不在 DOM 里）');
  assert.equal(r.headers['cache-control'], 'no-store', '带凭据的页面不得被缓存');
});

test('B4 Web 鉴权：错误 Host / 非回环 / 端口不符 → 403，且不下发 cookie', async (t) => {
  const { memoHome, service, web, port } = await setup();
  t.after(async () => { await web.close(); await service.close(); fs.rmSync(memoHome, { recursive: true, force: true }); });

  // DNS rebinding 形状：Host 是外域，连接却是 127.0.0.1
  const evil = await rawReq(port, '/', { headers: { host: 'evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(JSON.parse(evil.body).code, 'E_BAD_HOST');
  assert.equal(evil.headers['set-cookie'], undefined, '错误 Host 不得拿到会话 cookie');

  // 端口不符
  const wrongPort = await rawReq(port, '/', { headers: { host: `127.0.0.1:${port + 1}` } });
  assert.equal(wrongPort.status, 403);

  // 已持有 cookie 也不能绕过 Host 校验（cookie 是「同一信任域内」的凭据，不是网络边界）
  const api = await rawReq(port, '/api/summary', { headers: { host: 'evil.example', cookie: `${AUTH_COOKIE}=${web.token}` } });
  assert.equal(api.status, 403);

  // 合法 Host（localhost）仍可用
  const ok = await rawReq(port, '/api/summary', { headers: { host: `localhost:${port}`, authorization: `Bearer ${web.token}` } });
  assert.equal(ok.status, 200);
});

test('B4 Web 鉴权：写请求必须同源且带 Origin；缺失 / 跨源 → 403', async (t) => {
  const { memoHome, service, web, port, origin } = await setup({ write: true });
  t.after(async () => { await web.close(); await service.close(); fs.rmSync(memoHome, { recursive: true, force: true }); });

  const payload = JSON.stringify({ text: 'B4 写请求同源校验', kind: 'fact', source: { agent: 'test' } });
  const post = (headers = {}) => rawReq(port, '/api/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${web.token}`, ...headers },
    body: payload,
  });

  // 缺 Origin：旧实现放行，B4 起一律拒绝（这正是「本地脚本/CSRF 都能不带 Origin」的缺口）
  const missing = await post();
  assert.equal(missing.status, 403);
  assert.equal(JSON.parse(missing.body).code, 'E_BAD_ORIGIN');

  // 跨源 Origin
  const cross = await post({ origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(JSON.parse(cross.body).code, 'E_BAD_ORIGIN');

  // 同回环但端口不同（另一个本地页面）
  const otherPort = await post({ origin: `http://127.0.0.1:${port + 1}` });
  assert.equal(otherPort.status, 403);

  // 同源 → 200 且真的落库
  const same = await post({ origin });
  assert.equal(same.status, 200);
  const body = JSON.parse(same.body);
  assert.equal(body.ok, true);
  const svc = await createMemoryService({ memoHome, scope: SCOPE });
  t.after(() => svc.close());
  const rec = await svc.get(body.id);
  assert.equal(rec.text, 'B4 写请求同源校验');
});
