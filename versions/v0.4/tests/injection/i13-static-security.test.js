// tests/injection/i13-static-security.test.js — I13：静态资源与接口安全
// 契约：docs/08-web-ui.md §7、docs/02 §3.9 裁决 32/34。
// 用例数据：eval/cases/i13-static-security.json（穿越/目录/写方法清单）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createWebServer } from '../../src/web/server.js';

const CASE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i13-static-security.json'),
  'utf8',
));

// 请求路径一律取自代码常量，不直接取文件内容（文件数据直接进网络请求会触发静态分析告警；
// 这里额外断言数据种子与常量一致，保证 JSON 不会悄悄漂移）
const TRAVERSAL_PATHS = Object.freeze([
  '/../package.json',
  '/..%2fpackage.json',
  '/%2e%2e/package.json',
  '/ui/../package.json',
  '/%2Fetc%2Fpasswd',
]);
const DIR_PATHS = Object.freeze(['/ui/', '/subdir']);
const WRITE_METHODS = Object.freeze(['POST', 'PUT', 'DELETE', 'PATCH']);

/** 发送「原始路径」请求：不经 URL 规范化（fetch/new URL 会把 /../ 吞掉），必须走裸 http.request。 */
function rawReq(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: rawPath },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('I13 静态资源与接口安全：可达性 / 穿越 404 / 只读 / 绑定回环', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i13-'));
  let web;
  try {
    web = await createWebServer({ memoHome, scope: 'repo:eval-i13', port: 0, includeUi: true });
    const base = web.url; // http://127.0.0.1:<port>/
    const port = web.server.address().port;

    // 8) 只绑回环（D1 / 裁决 34）
    assert.equal(web.server.address().address, '127.0.0.1', '服务必须只绑 127.0.0.1');

    // 1) GET / → 200 text/html
    const home = await rawReq(port, '/');
    assert.equal(home.status, 200, 'GET / 应 200');
    assert.ok(home.headers['content-type'].includes('text/html'), `GET / Content-Type 应含 text/html，实际 ${home.headers['content-type']}`);

    // 2) GET /app.js → 200 javascript
    const appjs = await rawReq(port, '/app.js');
    assert.equal(appjs.status, 200, 'GET /app.js 应 200');
    assert.ok(appjs.headers['content-type'].includes('javascript'), `GET /app.js Content-Type 应含 javascript，实际 ${appjs.headers['content-type']}`);

    // 3) 路径穿越全部 404（含未解码的 ../ 与绝对路径编码）
    assert.deepEqual(CASE.traversalPaths, [...TRAVERSAL_PATHS], '数据种子应与用例常量一致');
    assert.deepEqual(CASE.dirPaths, [...DIR_PATHS]);
    assert.deepEqual(CASE.writeMethods, [...WRITE_METHODS]);
    for (const p of TRAVERSAL_PATHS) {
      const r = await rawReq(port, p);
      assert.equal(r.status, 404, `路径穿越必须 404：${p} 实际 ${r.status}`);
    }

    // 4) 目录请求 404（不列目录）
    for (const p of DIR_PATHS) {
      const r = await rawReq(port, p);
      assert.equal(r.status, 404, `目录请求必须 404：${p} 实际 ${r.status}`);
    }

    // 5) 只读语义：写方法打 /api/summary 一律 405
    for (const m of WRITE_METHODS) {
      const r = await rawReq(port, '/api/summary', m);
      assert.equal(r.status, 405, `${m} /api/summary 应 405，实际 ${r.status}`);
      let body = null;
      try { body = JSON.parse(r.body); } catch { /* 保持 null */ }
      assert.ok(body && body.ok === false, `${m} 405 响应体应为 ok:false JSON`);
    }

    // 6) 未知 /api/nope → 404 且 JSON 形状 ok:false
    const nope = await rawReq(port, '/api/nope');
    assert.equal(nope.status, 404, '未知 API 端点应 404');
    const nopeBody = JSON.parse(nope.body);
    assert.equal(nopeBody.ok, false, '404 API 响应应为 { ok:false, ... }');

    // 7) 不开放 CORS：任何响应头都不含 Access-Control-Allow-Origin
    const probes = ['/', '/app.js', '/api/summary', '/api/nope', '/../package.json'];
    for (const p of probes) {
      const r = await rawReq(port, p);
      assert.equal(r.headers['access-control-allow-origin'], undefined, `${p} 响应不得带 Access-Control-Allow-Origin`);
    }

    // 附带：fetch 正常路径也核一遍（URL 规范化路径）
    const res = await fetch(new URL('api/summary', base));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'fetch 路径同样不得带 CORS 头');
    const summary = await res.json();
    assert.equal(summary.ok, true);
  } finally {
    if (web) await web.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});
