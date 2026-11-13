// I48 — 记忆中心静态面与只读契约（W6/W8）：页面能开门、资源全自托管、只读时不给写入口
// 钉住：首页导航九个入口齐全、静态资源禁外链（Q13 的运行时对应物）、
// vendor 三件套可从服务里取到、/api/summary 明确下发 writeEnabled。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';

async function setup({ write } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i48-'));
  const service = await createMemoryService({ memoHome: home, scope: 'repo:i48', cwd: home });
  const web = await createWebServer({ memoHome: home, scope: 'repo:i48', service, port: 0, includeUi: true, write });
  return { home, service, web };
}

test('I48 首页与静态资源：九个导航入口在、vendor 自托管可取、无外链 CDN', async (t) => {
  const { service, web } = await setup();
  t.after(async () => { await web.close(); await service.close(); });

  const html = await (await fetch(web.url)).text();
  // 九个入口（今日/图谱/搜索/卫生/编辑/导入/会话/交接/设置）：用 tab-<route> 按钮 id 判定
  for (const route of ['today', 'graph', 'search', 'hygiene', 'edit', 'import', 'session', 'handoff', 'settings']) {
    assert.ok(html.includes(`id="tab-${route}"`), `首页缺 ${route} 入口`);
  }
  // 自托管：样式与脚本都必须来自 ./vendor 或本目录，不能是协议相对/CDN
  assert.ok(html.includes('./vendor/tabler.min.css'), '样式未指向 vendor');
  assert.ok(!/src="https?:\/\//.test(html), '页面不应引用外部脚本');
  assert.ok(!/(unpkg|jsdelivr|cdnjs|cdn\.)/.test(html), '页面不应引用 CDN');

  // vendor 三件套真能从服务里取到（403/404 就说明打包路径错了）
  for (const asset of ['vendor/tabler.min.css', 'vendor/uPlot.iife.min.js', 'vendor/force-graph.min.js']) {
    const r = await fetch(`${web.url}${asset}`);
    assert.equal(r.status, 200, `${asset} 取不到`);
    assert.ok((await r.text()).length > 1000, `${asset} 体积异常`);
  }
});

test('I48 /api/summary 明确下发 writeEnabled（只读 false / 写模式 true）', async (t) => {
  const a = await setup();
  t.after(async () => { await a.web.close(); await a.service.close(); });
  const ro = await (await fetch(`${a.web.url}api/summary`)).json();
  assert.equal(ro.writeEnabled, false, '只读模式必须下发 false（UI 据此禁用提交）');

  const b = await setup({ write: true });
  t.after(async () => { await b.web.close(); await b.service.close(); });
  const rw = await (await fetch(`${b.web.url}api/summary`)).json();
  assert.equal(rw.writeEnabled, true);
});
