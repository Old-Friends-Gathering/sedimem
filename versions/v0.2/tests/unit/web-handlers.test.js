// tests/unit/web-handlers.test.js — 本轮 Web 层缺陷修复的回归测试
// 覆盖：makeLabel 截断规则、timeline label 非空、curate_apply 聚合去重、
// 人工 supersede 不重复出现、hygiene 的 loserLabel/winnerLabel、series.activeRatio
// 与新旧 metrics 命名优先级、readMetrics 回退（契约：docs/02 §3.9/§3.10、docs/08 §4.2）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';
import { makeLabel, readMetrics } from '../../src/web/handlers.js';
import { scopeKeyOf } from '../../src/config/paths.js';

const SCOPE = 'dir:test-web-handlers';

/** 「东为正」的时区下的今天。服务端窗口是 [date 00:00 本地, +24h)，所以要把 now **加上**偏移再取日期；
 * 早先写成减偏移，只有在 UTC 16:00–24:00（CST 00:00–08:00）才会暴露——今天上午就撞上了。 */
function todayInTz(tzOffsetMinutes) {
  return new Date(Date.now() + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
}

async function writeRec(service, { subject, predicate, value, text, kind = 'fact' }) {
  const res = await service.write({
    text, kind, subject, predicate, value,
    source: { agent: 'test' },
  });
  // write 返回形状可能是 {record} 或记录本身，两种都兼容
  const rec = res?.record ?? res;
  assert.ok(rec?.id, 'write 应返回带 id 的记录');
  return rec.id;
}

test('makeLabel：结构化 / withValue 截断 / unstructured 前 60 字', () => {
  const r = { subject: 'svc', predicate: 'port', value: '8080', text: '服务端口 8080' };
  assert.equal(makeLabel(r), 'svc/port');
  assert.equal(makeLabel(r, { withValue: true }), 'svc/port：8080');

  // 值 ≤ 40 字原样；> 40 字截断加省略号
  const short = { subject: 'a', predicate: 'b', value: 'x'.repeat(40) };
  assert.equal(makeLabel(short, { withValue: true }), `a/b：${'x'.repeat(40)}`);
  const long = { subject: 'a', predicate: 'b', value: 'y'.repeat(41) };
  assert.equal(makeLabel(long, { withValue: true }), `a/b：${'y'.repeat(40)}…`);

  // unstructured（subject/predicate 都是 text）→ text 前 60 字
  const u = { subject: 'text', predicate: 'text', text: '部署脚本位于 tools/deploy.sh' };
  assert.equal(makeLabel(u), '部署脚本位于 tools/deploy.sh');
  const uLong = { subject: 'text', predicate: 'text', text: 'z'.repeat(61) };
  assert.equal(makeLabel(uLong), `${'z'.repeat(60)}…`);
});

test('api/today：时间线 label 非空且不是裸 op 名', async (t) => {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wh-label-'));
  t.after(() => fs.rmSync(memoHome, { recursive: true, force: true }));
  const service = await createMemoryService({ memoHome, scope: SCOPE });
  t.after(() => service.close());

  await writeRec(service, {
    subject: 'deploy', predicate: 'notes', value: 'tools/deploy.sh', text: '部署脚本位于 tools/deploy.sh',
  });
  await writeRec(service, {
    subject: 'text', predicate: 'text', text: '今天讨论了 strata 的 metrics 命名回退方案',
  });

  const web = await createWebServer({ memoHome, scope: SCOPE, port: 0, includeUi: false, service });
  t.after(() => new Promise((resolve) => web.server.close(resolve))); // service 由本用例关闭

  const date = todayInTz(480);
  const r = await (await fetch(`${web.url}api/today?date=${date}&tzOffset=480`)).json();
  assert.equal(r.ok, true);
  assert.ok(r.timeline.length >= 2, '两条写入应出现在时间线');
  const TARGET_OPS = new Set(['write', 'supersede', 'forget', 'curate_apply']);
  for (const row of r.timeline) {
    if (!TARGET_OPS.has(row.op)) continue;
    assert.ok(typeof row.label === 'string' && row.label !== '', `label 不能为空：${JSON.stringify(row)}`);
    assert.notEqual(row.label, row.op, `label 不能是裸 op 名：${JSON.stringify(row)}`);
  }
});

test('api/today：一次 curate_apply 只产生一行，counts.merged == 1', async (t) => {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wh-merge-'));
  t.after(() => fs.rmSync(memoHome, { recursive: true, force: true }));
  const service = await createMemoryService({ memoHome, scope: SCOPE });
  t.after(() => service.close());

  // 用不同 slot 的近似记录（unstructured 全落 text/text 同一 slot，会被 slot 取代）
  const aId = await writeRec(service, {
    subject: 'note1', predicate: 'value', value: '端口是 8080', text: '端口是 8080，位于 tools/deploy.sh',
  });
  const bId = await writeRec(service, {
    subject: 'note2', predicate: 'value', value: '端口是 8080', text: '端口是 8080，位于 tools/deploy.sh 的注释里',
  });
  const { applied } = await service.curateApply({ decisions: [{ ids: [aId, bId], decision: 'merge' }] });
  assert.equal(applied[0].applied, true);

  const web = await createWebServer({ memoHome, scope: SCOPE, port: 0, includeUi: false, service });
  t.after(() => new Promise((resolve) => web.server.close(resolve)));

  const date = todayInTz(480);
  const r = await (await fetch(`${web.url}api/today?date=${date}&tzOffset=480`)).json();
  assert.equal(r.ok, true);
  assert.equal(r.counts.merged, 1);
  const rows = r.timeline.filter((x) => x.op === 'curate_apply');
  assert.equal(rows.length, 1, `curate_apply 应只保留一行，实际 ${rows.length}`);
});

test('api/today：人工 supersede 不重复出现两行', async (t) => {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wh-sup-'));
  t.after(() => fs.rmSync(memoHome, { recursive: true, force: true }));
  const service = await createMemoryService({ memoHome, scope: SCOPE });
  t.after(() => service.close());

  const oldId = await writeRec(service, {
    subject: 'svc', predicate: 'port', value: '8080', text: '服务端口 8080',
  });
  await service.supersede({
    oldId, value: '9090', text: '服务端口 9090', source: { agent: 'test' }, reason: '端口变更',
  });

  const web = await createWebServer({ memoHome, scope: SCOPE, port: 0, includeUi: false, service });
  t.after(() => new Promise((resolve) => web.server.close(resolve)));

  const date = todayInTz(480);
  const r = await (await fetch(`${web.url}api/today?date=${date}&tzOffset=480`)).json();
  assert.equal(r.ok, true);
  const supRows = r.timeline.filter((x) => x.op === 'supersede');
  assert.equal(supRows.length, 1, `op=supersede 应只有一行，实际 ${supRows.length}`);
  const dup = r.timeline.filter((x) => x.op === 'write' && x.action === 'supersede');
  assert.equal(dup.length, 0, '不应存在 op=write 且 action=supersede 的重复行');
});

test('api/hygiene：merged/superseded 行都带可读的 loserLabel 与 winnerLabel', async (t) => {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wh-hyg-'));
  t.after(() => fs.rmSync(memoHome, { recursive: true, force: true }));
  const service = await createMemoryService({ memoHome, scope: SCOPE });
  t.after(() => service.close());

  // merge：两条不同 slot 的近似记录 → curateApply(ids, merge)
  const aId = await writeRec(service, {
    subject: 'cache1', predicate: 'threshold', value: '0.45', text: '缓存阈值是 0.45',
  });
  const bId = await writeRec(service, {
    subject: 'cache2', predicate: 'threshold', value: '0.45', text: '缓存阈值是 0.45 左右',
  });
  await service.curateApply({ decisions: [{ ids: [aId, bId], decision: 'merge' }] });

  // 人工 supersede
  const cId = await writeRec(service, {
    subject: 'svc2', predicate: 'port', value: '8080', text: 'svc2 端口 8080',
  });
  await service.supersede({
    oldId: cId, value: '9090', text: 'svc2 端口 9090', source: { agent: 'test' }, reason: '端口变更',
  });

  const web = await createWebServer({ memoHome, scope: SCOPE, port: 0, includeUi: false, service });
  t.after(() => new Promise((resolve) => web.server.close(resolve)));

  const r = await (await fetch(`${web.url}api/hygiene`)).json();
  assert.equal(r.ok, true);
  assert.ok(r.merged.length >= 1, '应至少有一条 merged 行');
  for (const row of r.merged) {
    assert.ok(row.loserLabel, `merged.loserLabel 不应为空：${JSON.stringify(row)}`);
    assert.ok(row.winnerLabel, `merged.winnerLabel 不应为空：${JSON.stringify(row)}`);
  }
  assert.ok(r.superseded.length >= 1, '应至少有一条 superseded 行');
  for (const row of r.superseded) {
    assert.ok(row.loserLabel, `superseded.loserLabel 不应为空：${JSON.stringify(row)}`);
    assert.ok(row.winnerLabel, `superseded.winnerLabel 不应为空：${JSON.stringify(row)}`);
  }
});

test('api/hygiene：series 含 activeRatio ≈ active/maxActive；新命名 metrics 优先于旧命名', async (t) => {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wh-series-'));
  t.after(() => fs.rmSync(memoHome, { recursive: true, force: true }));
  const service = await createMemoryService({ memoHome, scope: SCOPE });
  t.after(() => service.close());
  await writeRec(service, {
    subject: 'svc', predicate: 'port', value: '8080', text: '服务端口 8080',
  });

  // 同一天写新旧两份 metrics：active 不同（新=100，旧=50），maxActive=200
  const metricsDir = path.join(memoHome, 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  // scopeKey 由共享模块给出（裁决 39：命名单一来源，用例不再自己写正则）
  const scopeKey = scopeKeyOf(SCOPE);
  fs.writeFileSync(path.join(metricsDir, `${date}.json`), JSON.stringify({
    date, active: 50, maxActive: 200, total: 60, dupRatio: 0.1, conflictRate: 0.05,
  }));
  fs.writeFileSync(path.join(metricsDir, `${date}.${scopeKey}.json`), JSON.stringify({
    date, active: 100, maxActive: 200, total: 120, dupRatio: 0.2, conflictRate: 0.1,
  }));

  const web = await createWebServer({ memoHome, scope: SCOPE, port: 0, includeUi: false, service });
  t.after(() => new Promise((resolve) => web.server.close(resolve)));

  const r = await (await fetch(`${web.url}api/hygiene`)).json();
  assert.equal(r.ok, true);
  const entry = r.series.find((s) => s.date === date);
  assert.ok(entry, '今天的 metrics 应出现在 series');
  assert.equal(entry.active, 100, '应取新命名（date.scopeKey.json）的 active');
  assert.ok(Math.abs(entry.activeRatio - entry.active / entry.maxActive) < 1e-9);
  assert.equal(entry.maxActive, 200);
  // 其余天（如有）也应满足 activeRatio 公式
  for (const s of r.series) {
    assert.ok('activeRatio' in s, 'series 每项都应含 activeRatio');
    if (s.activeRatio !== null) {
      assert.ok(Math.abs(s.activeRatio - s.active / s.maxActive) < 1e-9, `activeRatio 公式失守：${JSON.stringify(s)}`);
    }
  }
});

test('readMetrics：只有旧名时能读到；新旧都没有返回 null', async (t) => {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wh-rm-'));
  t.after(() => fs.rmSync(memoHome, { recursive: true, force: true }));
  const metricsDir = path.join(memoHome, 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  const date = '2026-11-02';

  // 只写旧名 → 读到旧名内容
  fs.writeFileSync(path.join(metricsDir, `${date}.json`), JSON.stringify({ date, active: 7, total: 9 }));
  const m = await readMetrics(memoHome, SCOPE, date);
  assert.deepEqual(m, { date, active: 7, total: 9 });

  // 都没有 → null（换一个不存在的日期即可，目录里没有对应文件）
  assert.equal(await readMetrics(memoHome, SCOPE, '2026-01-01'), null);
});

test('hygiene 候选簇：payload 只有 items 时仍能给出条数与成员（issue #30）', async (t) => {
  const memoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wh-cand-'));
  t.after(() => fs.rmSync(memoHome, { recursive: true, force: true }));
  const service = await createMemoryService({ memoHome, scope: SCOPE });
  t.after(() => service.close());

  // 两条中文改写：containment 抓不到但汉字二元组能召回 → 必然成簇
  await writeRec(service, { subject: 'text', predicate: 'text', text: '去重阈值只用来找候选，最终判决交给正在跑的 Agent' });
  await writeRec(service, { subject: 'text', predicate: 'text', text: '去重的阈值只负责召回候选，不该由它做判决，判决交给 Agent' });

  const web = await createWebServer({ memoHome, scope: SCOPE, port: 0, includeUi: false, service });
  t.after(() => new Promise((resolve) => web.server.close(resolve)));

  const r = await (await fetch(`${web.url}api/hygiene`)).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 1, '应有候选簇');
  const cl = r.candidates[0];
  assert.ok(Array.isArray(cl.items) && cl.items.length === 2, '簇里应带 items（UI 渲染依赖它）');
  assert.equal(cl.size, 2, 'size 必须等于簇内条数');
  assert.ok(cl.items.every((it) => typeof it.text === 'string' && it.text.length > 0), 'items 应带 text 供 UI 显示');
});
