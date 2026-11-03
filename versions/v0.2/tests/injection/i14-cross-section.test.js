// tests/injection/i14-cross-section.test.js — I14：截面一致性
// 契约：docs/02-data-model-and-contract.md §3.9/§3.10。
// 同一时间窗内，exportRecords / events / /api/graph / /api/today 三种视角必须自洽。
// 用例数据：eval/cases/i14-cross-section.json。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';

const CASE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i14-cross-section.json'),
  'utf8',
));
const EDGE_TYPES = new Set(['same-entity', 'supersedes', 'duplicate-of', 'disputed-with']);

test('I14 截面一致性：快照数 / suspicious 遮蔽 / 事件可回查 / 图谱合法 / today 对账', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i14-'));
  const scope = 'repo:eval-i14';
  let svc;
  let web;
  try {
    svc = await createMemoryService({ memoHome, scope });

    // ---- 造数：6 条（1 条 suspicious：指令注入 + base64）----
    const createdIds = [];
    const w0 = await svc.write({ text: CASE.suspiciousText, source: { agent: 'test' } });
    assert.equal(w0.action, 'created', 'suspicious 记录应写入成功（打标不拒写，I5 契约）');
    assert.ok(w0.record.tags.includes('suspicious'), '指令注入文本必须被打 suspicious 标');
    createdIds.push(w0.record.id);

    for (const [text, subject, predicate] of CASE.texts) {
      const w = await svc.write({
        text, subject: subject ?? undefined, predicate: predicate ?? undefined, source: { agent: 'test' },
      });
      assert.equal(w.action, 'created', `基础记录应 created：${text}`);
      createdIds.push(w.record.id);
    }
    assert.equal(createdIds.length, 6, '共 6 条初始记录');

    // ---- 1 次 supersede（缓存规则换措辞）----
    const oldCacheId = createdIds[3];
    const sup = await svc.supersede({
      oldId: oldCacheId,
      text: '缓存命中率不足 60% 时触发告警',
      source: { agent: 'test' },
      reason: 'I14 cross-section supersede',
    });
    const supersedesNewId = sup.record.id;

    // ---- 1 次 forget（日志保留）----
    const logId = createdIds[4];
    await svc.forget({ id: logId, reason: 'I14 cross-section forget' });

    // ---- 1 次 curate merge（部署脚本改写对 → dedupeScan → Agent 裁决）----
    const scan = await svc.dedupeScan({});
    const deploys = new Set([CASE.texts[0][0], CASE.texts[1][0]]);
    const cluster = scan.clusters.find((c) => c.items.filter((it) => deploys.has(it.text)).length >= 2);
    assert.ok(cluster, `改写对必须成簇，实际簇=${JSON.stringify(scan.clusters.map((c) => c.items.map((i) => i.text)))}`);
    const merged = await svc.curateApply({
      decisions: [{ ids: [cluster.items[0].id, cluster.items[1].id], decision: 'merge', note: 'I14: same fact' }],
    });
    assert.ok(merged.applied.every((r) => r.applied), `merge 必须落盘：${JSON.stringify(merged)}`);

    // ================= 1) exportRecords({status:'all'}) 条数对账 =================
    // 已提交快照去重后的 id 集：6 条 created + supersede 产生的新 id（补丁行折叠到同 id 的最新版本）
    const expectedIds = new Set([...createdIds, supersedesNewId]);
    const all = await svc.exportRecords({ status: 'all', limit: 100000 });
    assert.equal(all.total, expectedIds.size, `status:all 条数应等于已提交快照的 id 数（含 supersede 补丁），期望 ${expectedIds.size} 实际 ${all.total}`);
    for (const r of all.records) assert.ok(expectedIds.has(r.id), `未知 id 混入：${r.id}`);
    const allIds = new Set(all.records.map((r) => r.id));

    // ================= 2) suspicious 默认遮蔽（includeSuspicious:false）=================
    const activeOut = await svc.exportRecords({ status: 'active', limit: 100000 });
    const susRow = activeOut.records.find((r) => r.tags && r.tags.includes('suspicious'));
    assert.ok(susRow, 'suspicious 记录应在 active 导出中出现（遮蔽不等于隐藏行）');
    assert.equal(susRow.text, CASE.withheld, `active 导出 suspicious text 必须遮蔽，实际 ${JSON.stringify(susRow.text)}`);
    assert.equal(susRow.value, CASE.withheld, `active 导出 suspicious value 必须遮蔽，实际 ${JSON.stringify(susRow.value)}`);
    const rawOut = await svc.exportRecords({ status: 'active', limit: 100000, includeSuspicious: true });
    const rawRow = rawOut.records.find((r) => r.tags && r.tags.includes('suspicious'));
    assert.equal(rawRow.text, CASE.suspiciousText, 'includeSuspicious:true 必须返回原文');

    // ================= 3) 事件流 ↔ 快照可回查 =================
    const evs = await svc.events({ limit: 100000 });
    const createdEvents = evs.events.filter((e) => e.op === 'write' && e.detail?.action === 'created');
    assert.ok(createdEvents.length >= 6, '至少 6 条 created 事件（含 supersede 的新记录）');
    for (const ev of createdEvents) {
      assert.ok(ev.id && allIds.has(ev.id), `created 事件 id=${ev.id} 必须能在 status:"all" 快照里找到`);
    }

    // ---- 起服务，走 HTTP 视角 ----
    web = await createWebServer({ memoHome, scope, port: 0, includeUi: true });

    // ================= 4) /api/graph 节点/边合法性 =================
    const graphRes = await fetch(new URL('/api/graph?limit=5', web.url));
    assert.equal(graphRes.status, 200);
    const graph = await graphRes.json();
    assert.equal(graph.ok, true);
    assert.ok(graph.nodes.length <= 5, `nodes 数必须 <= limit，实际 ${graph.nodes.length}`);
    for (const n of graph.nodes) {
      assert.ok(allIds.has(n.id), `图谱节点 ${n.id} 必须存在于 status:"all" 快照`);
    }
    for (const e of graph.edges) {
      assert.ok(EDGE_TYPES.has(e.type), `边类型非法：${e.type}`);
      assert.ok(allIds.has(e.from) || graph.nodes.some((n) => n.id === e.from), `边端点 ${e.from} 必须可回查`);
    }

    // ================= 5) same-entity 时间链（裁决 35）=================
    // 同一 subject 的 n 个节点最多 n-1 条 same-entity 边
    const sameEntity = graph.edges.filter((e) => e.type === 'same-entity');
    const nodesBySubject = new Map();
    for (const n of graph.nodes) {
      if (!nodesBySubject.has(n.subject)) nodesBySubject.set(n.subject, []);
      nodesBySubject.get(n.subject).push(n.id);
    }
    const edgeKey = (e) => [e.from, e.to].sort().join('\u0001');
    const seenEdges = new Set();
    const perSubject = new Map();
    for (const e of sameEntity) {
      const key = edgeKey(e);
      assert.ok(!seenEdges.has(key), `same-entity 边不得重复：${key}`);
      seenEdges.add(key);
      // 归属到两端共同 subject
      let counted = false;
      for (const ids of nodesBySubject.values()) {
        if (ids.includes(e.from) && ids.includes(e.to)) {
          perSubject.set(ids, (perSubject.get(ids) ?? 0) + 1);
          counted = true;
          break;
        }
      }
      assert.ok(counted, `same-entity 边两端必须同 subject：${JSON.stringify(e)}`);
    }
    for (const [ids, cnt] of perSubject) {
      assert.ok(cnt <= ids.length - 1, `同 subject ${ids.length} 节点的 same-entity 边应 <= ${ids.length - 1}（时间链，裁决 35），实际 ${cnt}`);
    }

    // ================= 6) /api/today counts ↔ timeline 行数一致 =================
    const today = new Date().toISOString().slice(0, 10); // UTC 今日，tzOffset=0
    const todayRes = await fetch(new URL(`/api/today?date=${today}&tzOffset=0`, web.url));
    assert.equal(todayRes.status, 200);
    const todayOut = await todayRes.json();
    assert.equal(todayOut.ok, true);
    const { counts, timeline } = todayOut;
    const rowsOf = (pred) => timeline.filter(pred).length;
    assert.equal(
      counts.created,
      rowsOf((r) => r.op === 'write' && r.action === 'created'),
      `counts.created(${counts.created}) 应与 timeline 中 created 行数一致`,
    );
    assert.equal(
      counts.superseded,
      rowsOf((r) => r.op === 'supersede'),
      `counts.superseded(${counts.superseded}) 应与 timeline 中 supersede 行数一致`,
    );
    assert.equal(
      counts.forgotten,
      rowsOf((r) => r.op === 'forget'),
      `counts.forgotten(${counts.forgotten}) 应与 timeline 中 forget 行数一致`,
    );
    assert.equal(
      counts.merged,
      rowsOf((r) => r.op === 'curate_apply'),
      `counts.merged(${counts.merged}) 应与 timeline 中裁决行数一致（一次裁决一行）`,
    );
    // 本用例固定动作量：6 个 created（supersede 的新记录走 action='supersede' 行，不计入 created）+ 1 supersede + 1 forget + 1 merge
    assert.equal(counts.created, 6);
    assert.equal(counts.superseded, 1);
    assert.equal(counts.forgotten, 1);
    assert.equal(counts.merged, 1);
  } finally {
    if (web) await web.close().catch(() => {});
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
