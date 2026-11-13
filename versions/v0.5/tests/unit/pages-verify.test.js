/**
 * pages-verify 单测 —— 只测纯逻辑（HTML 版本判定、重试、资产检查），不打真实网络。
 *
 * 这个脚本属于「发布面」门禁：它在 CI 里唯一的价值是**不误报也不漏报**，
 * 所以三条边界都要钉住：构建未完成（版本没出现）要重试、重试耗尽要失败、
 * 版本对了但资产 404 也要失败（半坏的站点比旧站点更糟）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASSETS,
  currentVersion,
  htmlMentionsVersion,
  verifyOnce,
  verifyWithRetry,
} from '../../../../tools/pages-verify.mjs';

const html = (v) => `<html><body><div class="ver">v${v}</div><img src="assets/graph.png"></body></html>`;

/** 造一个假的 fetch：pages[url] 决定首页内容，assets 决定资产返回码 */
function fakeFetch({ page, status = 200, assetStatus = 200 }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (String(url).endsWith('.png')) {
      const code = typeof assetStatus === 'function' ? assetStatus(url) : assetStatus;
      return { ok: code === 200, status: code, text: async () => '' };
    }
    return { ok: status === 200, status, text: async () => page };
  };
  fn.calls = calls;
  return fn;
}

test('htmlMentionsVersion：只在出现 vX.Y.Z 时通过', () => {
  assert.equal(htmlMentionsVersion(html('0.5.0'), '0.5.0'), true);
  assert.equal(htmlMentionsVersion(html('0.4.4'), '0.5.0'), false);
  // 不能把 0.5.0 误判成 0.5.00 或 0.50.0
  assert.equal(htmlMentionsVersion(html('0.50.0'), '0.5.0'), false);
  assert.equal(htmlMentionsVersion('', '0.5.0'), false);
  assert.equal(htmlMentionsVersion(null, '0.5.0'), false);
});

test('currentVersion：读到 0.5.0 且目录存在', async () => {
  const { version, dir } = await currentVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(dir.endsWith(`versions/v0.${version.split('.')[1]}`), `版本目录与版本号对不上：${dir} vs ${version}`);
});

test('verifyOnce：版本对上 + 资产 200 → ok', async () => {
  const fetchImpl = fakeFetch({ page: html('0.5.0') });
  const r = await verifyOnce({ url: 'https://example.test/site/', version: '0.5.0', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  // 首页 + 三张资产都被请求过
  assert.equal(fetchImpl.calls.length, 1 + DEFAULT_ASSETS.length);
});

test('verifyOnce：版本没出现 → version-mismatch（构建未完成就是这个表现）', async () => {
  const r = await verifyOnce({
    url: 'https://example.test/site',
    version: '0.5.0',
    fetchImpl: fakeFetch({ page: html('0.4.4') }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'version-mismatch');
  assert.equal(r.detail.expect, 'v0.5.0');
});

test('verifyOnce：资产 404 → asset-missing（半坏站点也要失败）', async () => {
  const r = await verifyOnce({
    url: 'https://example.test/site/',
    version: '0.5.0',
    fetchImpl: fakeFetch({ page: html('0.5.0'), assetStatus: (u) => (String(u).endsWith('hygiene.png') ? 404 : 200) }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'asset-missing');
  assert.equal(r.detail.missing[0].asset, 'assets/hygiene.png');
});

test('verifyOnce：首页 5xx / fetch 抛错都返回结构化失败，不抛异常', async () => {
  const r500 = await verifyOnce({ url: 'https://x.test/', version: '0.5.0', fetchImpl: fakeFetch({ page: '', status: 503 }) });
  assert.equal(r500.ok, false);
  assert.equal(r500.reason, 'http-error');
  assert.equal(r500.detail.status, 503);

  const boom = await verifyOnce({
    url: 'https://x.test/',
    version: '0.5.0',
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(boom.ok, false);
  assert.equal(boom.reason, 'fetch-failed');
  assert.match(boom.detail.error, /ECONNRESET/);
});

test('verifyWithRetry：前两次旧版本、第三次跟上（Pages 异步构建的真实形状）', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('.png')) return { ok: true, status: 200, text: async () => '' };
    n += 1;
    return { ok: true, status: 200, text: async () => html(n >= 3 ? '0.5.0' : '0.4.4') };
  };
  const logs = [];
  const r = await verifyWithRetry({
    url: 'https://example.test/site/',
    version: '0.5.0',
    attempts: 5,
    intervalMs: 1,
    fetchImpl,
    sleep: async () => {},
    log: (s) => logs.push(s),
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.equal(logs.filter((l) => l.includes('version-mismatch')).length, 2);
});

test('verifyWithRetry：一直旧版本 → 耗尽次数后失败，attempts 等于上限', async () => {
  let sleeps = 0;
  const r = await verifyWithRetry({
    url: 'https://example.test/site/',
    version: '0.5.0',
    attempts: 3,
    intervalMs: 1,
    fetchImpl: fakeFetch({ page: html('0.4.4') }),
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'version-mismatch');
  assert.equal(r.attempts, 3);
  // 最后一次失败后不再 sleep
  assert.equal(sleeps, 2);
});
