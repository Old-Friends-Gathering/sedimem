// tests/injection/i20-search-metrics.test.js —— 注入用例 I20（issue #36，裁决 52）
// 真跑 service.search 若干次（含命中/空结果/stale 命中）+ nightly 的 metrics 生成路径，
// 断言 metrics 文件里 searchCount/noHitRate/staleHitRate/avgTopScore 与事件口径一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createMemoryService } from '../../src/api/service.js';
import { metricsFileName } from '../../src/config/paths.js';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const NIGHTLY = join(here, '../../src/cli/nightly.js');
const NODE = process.execPath;

const CASE = JSON.parse(
  readFileSync(join(here, '../../eval/cases/i20-search-metrics.json'), 'utf8'),
);

test('I20 检索健康指标：search 事件 → nightly metrics 四字段与口径一致', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i20-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: CASE.scope });
    for (const r of CASE.records) {
      await svc.write({ ...r, source: { agent: 'eval-i20' } });
    }

    // 5 次检索：2 次命中 / 2 次空结果 / 1 次 stale（includeDisputed 命中 disputed 条目）
    await svc.search(CASE.queries.hit);
    await svc.search(CASE.queries.hit);
    await svc.search(CASE.queries.miss);
    await svc.search(CASE.queries.miss);
    await svc.search(CASE.queries.stale, { includeDisputed: true });

    // 口径真值：从事件流复算（与 nightly computeSearchMetrics 同一数据源）
    const { events } = await svc.events({ ops: ['search'], limit: 100000 });
    assert.equal(events.length, 5, '5 次检索应有 5 条 search 事件');
    const searchCount = events.length;
    const noHit = events.filter((e) => e.detail?.hits === 0).length;
    const stale = events.filter((e) => (e.detail?.staleHits ?? 0) > 0).length;
    const scores = events
      .map((e) => e.detail?.topScore)
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    const staleEvent = events.find((e) => (e.detail?.staleHits ?? 0) > 0);
    assert.ok(staleEvent, 'includeDisputed 检索应产生 staleHits>0 的事件');

    // 不落 query 原文（裁决 52）：events.jsonl 全文不含任何 query 与 qHash 之外的线索
    const rawEvents = readFileSync(join(memoHome, 'events.jsonl'), 'utf8');
    for (const q of Object.values(CASE.queries)) {
      assert.ok(!rawEvents.includes(q), `events.jsonl 不得包含 query 原文: ${q}`);
    }
    // qHash 可从 query 确定性重放（sha256 前 12 位）
    assert.equal(staleEvent.detail.qHash,
      createHash('sha256').update(CASE.queries.stale, 'utf8').digest('hex').slice(0, 12));

    await svc.close();

    // 真跑 nightly 的 metrics 生成路径
    await run(NODE, [NIGHTLY, '--scope', CASE.scope], {
      env: { ...process.env, MEMO_HOME: memoHome },
    });
    const metrics = JSON.parse(
      readFileSync(join(memoHome, 'metrics', metricsFileName(
        new Date().toISOString().slice(0, 10), CASE.scope,
      )), 'utf8'),
    );

    assert.equal(metrics.searchCount, searchCount);
    assert.ok(Math.abs(metrics.noHitRate - noHit / searchCount) < 1e-9,
      `noHitRate 口径一致，期望 ${noHit / searchCount}，实际 ${metrics.noHitRate}`);
    assert.ok(Math.abs(metrics.staleHitRate - stale / searchCount) < 1e-9,
      `staleHitRate 口径一致，期望 ${stale / searchCount}，实际 ${metrics.staleHitRate}`);
    assert.ok(Math.abs(metrics.avgTopScore
      - scores.reduce((a, b) => a + b, 0) / scores.length) < 1e-9,
      'avgTopScore 与事件均值一致');
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('I20 补充：当天无检索（另一个 scope）→ 四字段全 null，而非 0', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-i20b-'));
  try {
    let svc = await createMemoryService({ memoHome, scope: `${CASE.scope}-quiet` });
    await svc.write({
      kind: 'fact', text: '没有检索发生的分库', subject: 'quiet',
      predicate: 'state', value: 'idle', source: { agent: 'eval-i20' },
    });
    await svc.close();
    await run(NODE, [NIGHTLY, '--scope', `${CASE.scope}-quiet`], {
      env: { ...process.env, MEMO_HOME: memoHome },
    });
    const metrics = JSON.parse(readFileSync(join(
      memoHome, 'metrics',
      metricsFileName(new Date().toISOString().slice(0, 10), `${CASE.scope}-quiet`),
    ), 'utf8'));
    assert.equal(metrics.searchCount, null);
    assert.equal(metrics.noHitRate, null);
    assert.equal(metrics.staleHitRate, null);
    assert.equal(metrics.avgTopScore, null);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});
