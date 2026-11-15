// tests/injection/i15-live-refresh.test.js — I15：常驻服务跨进程可见性
// 契约：docs/02 §3.11 裁决 39（常驻只读进程必须显式刷新视图）。
// 场景：memo serve 已启动 → 另一个进程（CLI 写入口）写入新事实 → 浏览器侧下一次请求必须立刻看到，
// 而且时间线的 label 不能退化成操作名（label 退化是「events 新了但记录索引旧」的指纹）。
// 这是审核 A1 的回归用例：此前 I14 把同一个 service 实例喂给 server，内存天然新鲜，永远测不到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createWebServer } from '../../src/web/server.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../src/cli/memo.js');

test('I15 常驻服务：外部进程写入后，下一次 API 请求立即可见且 label 不退化', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i15-'));
  const scope = 'repo:eval-i15';
  let web;
  try {
    // port: 0 → 由内核选空闲端口。测试绝不能绑固定端口：本机常驻的 memo serve 会把它占掉，
    // 造成「测试因为开着观察台而红」这种假失败（实测过一次）。
    web = await createWebServer({ memoHome, scope, includeUi: false, port: 0 });
    const url = (suffix) => new URL(suffix, web.url).toString();

    // 1) 空库：0 条
    const before = await (await fetch(url('api/summary'))).json();
    assert.equal(before.stats.total, 0, '初始库应为空');

    // 2) 外部进程写入（走出真正的 CLI 入口 + 独立进程，才是真实的「另一个客户端」）
    const env = { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: scope };
    const { stdout } = await execFileAsync(process.execPath, [
      CLI, 'write',
      '--text', '常驻服务必须能看到外部进程写入的新记忆，否则截面会自相矛盾。',
      '--subject', 'sedimem/web', '--predicate', 'live-refresh',
      '--agent', 'cli-writer',
    ], { env });
    assert.match(stdout, /created/, `CLI 写入应成功，实际输出：${stdout}`);

    // 3) 下一次请求必须看见（不重启服务）—— 这是裁决 39 的核心
    const after = await (await fetch(url('api/summary'))).json();
    assert.equal(after.stats.total, 1, '外部进程写入后，常驻服务的统计必须刷新');
    assert.equal(after.stats.active, 1);

    const records = await (await fetch(url('api/records?status=active'))).json();
    assert.equal(records.records.length, 1, '记录列表必须包含外部写入');
    assert.equal(records.records[0].subject, 'sedimem/web');

    // 4) 时间线：新事件必须有服务端生成的 label，不能退化成 op 名
    const today = await (await fetch(url(`api/today?date=${new Date().toISOString().slice(0, 10)}&tzOffset=0`))).json();
    assert.equal(today.counts.created, 1, '今日新增应为 1');
    const createdRow = today.timeline.find((r) => r.op === 'write' && r.label && r.label.includes('sedimem/web'));
    assert.ok(createdRow, `时间线应有带 label 的创建行，实际：${JSON.stringify(today.timeline)}`);
    assert.ok(!/^(write|created)$/.test(createdRow.label), 'label 不得退化为操作名');

    // 5) 图谱节点也应跟随（此前 /api/graph 会冻结在启动时刻）
    const graph = await (await fetch(url('api/graph?limit=50&days=3650'))).json();
    assert.equal(graph.nodes.length, 1, '图谱节点必须包含外部写入的记录');
    assert.equal(graph.sampled.total, 1);
  } finally {
    if (web) await web.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});
