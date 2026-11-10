/**
 * dsh-sedimem 宿主插件测试。
 *
 * 策略（零依赖约束下）：
 *  - 假 ctx：记录 webServer.register 的 route，把 route 挂进一个真 http.Server；
 *  - 内嵌副本走真子进程（spawn observer-entry.mjs），外部模式用一个「假外部观察台」
 *    （直接用本项目 web server 起一个临时端口充当）；
 *  - 断言：代理 HTML/JSON 真的过、health 只读、栅栏拒绝非回环 Host、
 *    内嵌 src 与 versions/v0.3 哈希一致（防漂移）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as rawRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, name, inject, routes } from '../lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');

/** 造一个假宿主 ctx：收集 route + effect，提供可丢弃的 logger。 */
function fakeCtx() {
  const registered = [];
  const effects = [];
  return {
    registered,
    effects,
    logger: { info() {}, warn() {} },
    webServer: {
      register(route) {
        registered.push(route);
        return () => { const i = registered.indexOf(route); if (i >= 0) registered.splice(i, 1); };
      },
    },
    // Cordis 语义：effect(fn) 立即执行 fn，返回值作为清理函数
    effect(fn, label) { const dispose = fn(); effects.push({ dispose, label }); },
  };
}

/** 把注册到的 route 挂进真 http.Server（模拟 DSH webServer 的分发）。 */
function mountRoutes(ctx, prefixStrip = '') {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    for (const route of ctx.registered) {
      if (route.kind === 'exact' && url.pathname === route.path) return void route.handler(req, res);
      if (route.kind === 'prefix' && url.pathname.startsWith(route.path)) return void route.handler(req, res);
    }
    res.writeHead(404); res.end('no route');
  });
  return server;
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** 造一个最小 MEMO_HOME（两条记录，够 /api/summary 与 HTML 渲染）。 */
function seedMemoHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-sedimem-test-'));
  mkdirSync(path.join(home, 'items'), { recursive: true });
  const now = new Date().toISOString();
  const rec = (id, subject, predicate, value) => JSON.stringify({
    id, scope: 'repo:plugtest', kind: 'fact', subject, predicate, value,
    text: `${subject} ${predicate} ${value}`, title: `${subject}`,
    status: 'active', tags: [], createdAt: now, updatedAt: now, validFrom: now, validTo: null,
    source: { agent: 'cli' }, hits: 0,
  });
  writeFileSync(
    path.join(home, 'items', 'repo:plugtest.jsonl'),
    `${rec('01AAAAAAAAAAAAAAAAAAAAAAAAAA1', 'plug/a', 'p', 'v1')}\n${rec('01BBBBBBBBBBBBBBBBBBBBBBBBBB2', 'plug/b', 'p', 'v2')}\n`,
  );
  return home;
}

test('元数据：name/inject/routes 形状正确', { timeout: 10000 }, () => {
  assert.equal(name, 'dsh-sedimem');
  assert.deepEqual(inject, ['webServer']);
  assert.equal(routes.UI_PREFIX, '/api/dsh-sedimem/ui');
  assert.equal(routes.HEALTH_PATH, '/api/dsh-sedimem/health');
});

test('内嵌副本与 versions/v0.3 哈希一致（防漂移）', { timeout: 15000 }, () => {
  const roots = [
    [path.join(pkgRoot, 'lib', 'src'), path.join(repoRoot, 'versions', 'v0.3', 'src')],
    [path.join(pkgRoot, 'lib', 'ui'), path.join(repoRoot, 'versions', 'v0.3', 'ui')],
    [path.join(pkgRoot, 'lib', 'config'), path.join(repoRoot, 'versions', 'v0.3', 'config')],
  ];
  for (const [embedded, source] of roots) {
    const files = readdirSync(source, { recursive: true }).filter((f) => statSync(path.join(source, f)).isFile());
    assert.ok(files.length > 0, `${source} 应有文件`);
    for (const f of files) {
      const a = createHash('sha256').update(readFileSync(path.join(embedded, f))).digest('hex');
      const b = createHash('sha256').update(readFileSync(path.join(source, f))).digest('hex');
      assert.equal(a, b, `内嵌副本漂移：${f}（跑 scripts/sync-from-v03.sh 同步）`);
    }
  }
});

test('外部模式：observerUrl 活着时直接代理、不启子进程', { timeout: 30000 }, async () => {
  // 假外部观察台：直接用内嵌 observer-entry 起一个（同一份代码，仅充当“已运行的系统”）
  const memoHome = seedMemoHome();
  const external = spawn(process.execPath, [path.join(pkgRoot, 'lib', 'observer-entry.mjs')], {
    env: { ...process.env, MEMO_HOME: memoHome, MEMO_PORT: '0', MEMO_SCOPE: 'repo:plugtest' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let externalPort = 0;
  await new Promise((resolve) => {
    external.stdout.on('data', (c) => {
      const m = /"port":(\d+)/.exec(String(c));
      if (m) { externalPort = Number(m[1]); resolve(); }
    });
  });

  const ctx = fakeCtx();
  apply(ctx, { memoHome, observerUrl: `http://127.0.0.1:${externalPort}` });
  assert.equal(ctx.registered.length, 2, '应注册 ui + health 两条路由');
  const server = mountRoutes(ctx);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    // ui 前缀：HTML 真的过代理（首个请求触发 ensureObserver → 选外部）
    const page = await fetch(`${base}/api/dsh-sedimem/ui/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<!DOCTYPE html>/i);

    // health：外部模式 running=true（被动探测，不自己拉起）
    const h = await (await fetch(`${base}/api/dsh-sedimem/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.mode, 'external');
    assert.equal(h.running, true);
    assert.equal(h.port, externalPort);

    // 子路径 API：iframe 的 fetch('api/summary') 经代理到观察台 /api/summary
    const api = await (await fetch(`${base}/api/dsh-sedimem/ui/api/summary`)).json();
    assert.equal(api.ok, true);
    assert.equal(api.scope, 'repo:plugtest');
  } finally {
    server.closeIdleConnections?.();
    server.close();
    external.kill('SIGTERM');
    for (const { dispose } of ctx.effects) dispose();
  }
});

test('内嵌模式：外部不可达时 spawn 兜底副本；栅栏拒绝非回环 Host', { timeout: 30000 }, async () => {
  const memoHome = seedMemoHome();
  const ctx = fakeCtx();
  // observerUrl 指向一个必然没人的端口 → 落到内嵌
  apply(ctx, { memoHome, observerUrl: 'http://127.0.0.1:1' });
  const server = mountRoutes(ctx);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  try {
    const page = await fetch(`${base}/api/dsh-sedimem/ui/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<!DOCTYPE html>/i);

    const h = await (await fetch(`${base}/api/dsh-sedimem/health`)).json();
    assert.equal(h.mode, 'embedded');
    assert.equal(h.running, true);
    assert.ok(h.port > 0);
  } finally {
    server.closeIdleConnections?.();
    server.close();
    for (const { dispose } of ctx.effects) dispose();
  }

  // 栅栏：Host 非回环 → 403（新开一个 ctx 只测拒绝路径）
  const ctx2 = fakeCtx();
  apply(ctx2, { memoHome: seedMemoHome() });
  const server2 = mountRoutes(ctx2);
  const port2 = await listen(server2);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = rawRequest(
        { host: '127.0.0.1', port: port2, path: '/api/dsh-sedimem/health', headers: { host: 'evil.example.com' } },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403, 'Host 非回环必须被栅栏拒绝');
  } finally {
    server2.closeIdleConnections?.();
    server2.close();
    for (const { dispose } of ctx2.effects) dispose();
  }
});

test('observerUrl 非回环目标被忽略（回落内嵌，不代理到局域网）', { timeout: 30000 }, async () => {
  const ctx = fakeCtx();
  apply(ctx, { memoHome: seedMemoHome(), observerUrl: 'http://192.168.1.9:7788' });
  const server = mountRoutes(ctx);
  const port = await listen(server);
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/api/dsh-sedimem/health`)).json();
    // 非回环 URL 不可用 → 内嵌兜底（或 idle，但不能是 external）
    assert.notEqual(h.mode, 'external');
  } finally {
    server.closeIdleConnections?.();
    server.close();
    for (const { dispose } of ctx.effects) dispose();
  }
});

test('外部观察台死掉后自动回落内嵌（await probeOk 回归）', { timeout: 30000 }, async () => {
  const memoHome = seedMemoHome();
  const external = spawn(process.execPath, [path.join(pkgRoot, 'lib', 'observer-entry.mjs')], {
    env: { ...process.env, MEMO_HOME: memoHome, MEMO_PORT: '0', MEMO_SCOPE: 'repo:plugtest' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let externalPort = 0;
  await new Promise((resolve) => {
    external.stdout.on('data', (c) => {
      const m = /"port":(\d+)/.exec(String(c));
      if (m) { externalPort = Number(m[1]); resolve(); }
    });
  });

  const ctx = fakeCtx();
  apply(ctx, { memoHome, observerUrl: `http://127.0.0.1:${externalPort}` });
  const server = mountRoutes(ctx);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    // 第一轮：外部活着 → external
    let h = await (await fetch(`${base}/api/dsh-sedimem/health`)).json();
    await fetch(`${base}/api/dsh-sedimem/ui/`); // 触发 ensureObserver
    h = await (await fetch(`${base}/api/dsh-sedimem/health`)).json();
    assert.equal(h.mode, 'external');

    // 杀掉外部观察台 → 下一轮请求必须回落 embedded（而不是继续用死端口）
    external.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    const page = await fetch(`${base}/api/dsh-sedimem/ui/`);
    assert.equal(page.status, 200);
    h = await (await fetch(`${base}/api/dsh-sedimem/health`)).json();
    assert.equal(h.mode, 'embedded');
  } finally {
    server.closeIdleConnections?.();
    server.close();
    for (const { dispose } of ctx.effects) dispose();
  }
});
