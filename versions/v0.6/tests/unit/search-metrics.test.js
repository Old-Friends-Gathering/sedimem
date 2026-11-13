// tests/unit/search-metrics.test.js —— 检索健康指标（issue #36，契约 §3.13 裁决 52）
// 覆盖：0 检索 → 四字段全 null；3 检索 1 空 → noHitRate≈1/3；
// events 不落 query 原文、qHash=sha256 前 12 位；staleHits 只数 status!=='active'/过期命中。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

const today = () => new Date().toISOString().slice(0, 10);
const qHash = (q) => createHash('sha256').update(q, 'utf8').digest('hex').slice(0, 12);

async function runNightly(memoHome, scope) {
  await run(NODE, [NIGHTLY, '--scope', scope], {
    env: { ...process.env, MEMO_HOME: memoHome },
  });
  return JSON.parse(
    readFileSync(join(memoHome, 'metrics', metricsFileName(today(), scope)), 'utf8'),
  );
}

/** 写一对矛盾事实：第一笔 active，第二笔 disputed（同 i3 语义），返回两笔 id。 */
async function writeDisputedPair(svc, tag) {
  const a = await svc.write({
    kind: 'fact', text: `staleprobe 旧结论 ${tag}`,
    subject: `staleprobe.${tag}`, predicate: 'value', value: `old-${tag}`,
    source: { agent: 'test' },
  });
  const b = await svc.write({
    kind: 'fact', text: `staleprobe 新结论 ${tag} 与旧矛盾`,
    subject: `staleprobe.${tag}`, predicate: 'value', value: `new-${tag}`,
    source: { agent: 'test' },
  });
  return [a, b];
}

describe('search 事件形状（裁决 52：不落 query 原文）', () => {
  test('detail 只含 hits/topScore/staleHits/qHash；qHash=sha256 前 12 位', async () => {
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-sm-'));
    let svc;
    try {
      svc = await createMemoryService({ memoHome, scope: 'repo:sm-shape' });
      const QUERY = 'Node 推荐';
      await svc.write({
        kind: 'fact', text: '推荐用 Node 22', subject: 'toolchain.node',
        predicate: 'version', value: 'v22', source: { agent: 'test' },
      });
      const res = await svc.search(QUERY);
      assert.ok(res.items.length >= 1, '应命中 1 条');

      const { events } = await svc.events({ ops: ['search'], limit: 100 });
      assert.equal(events.length, 1);
      const d = events[0].detail;
      assert.equal(events[0].op, 'search');
      assert.equal(d.hits, res.items.length);
      assert.equal(typeof d.topScore, 'number');
      assert.equal(d.staleHits, 0, '全部 active 命中，staleHits=0');
      assert.equal(d.qHash, qHash(QUERY));
      assert.equal(d.qHash.length, 12);
      // 事件 detail 只允许这四个键——多一个键（比如 query）就是违规
      assert.deepEqual(Object.keys(d).sort(), ['hits', 'qHash', 'staleHits', 'topScore']);
      // 整个 events.jsonl 不出现 query 原文（真相层不是查询日志）
      const raw = readFileSync(join(memoHome, 'events.jsonl'), 'utf8');
      assert.ok(!raw.includes(QUERY), 'events.jsonl 不得包含 query 原文');
      // 空结果：topScore 为 null（不是 0）
      const miss = await svc.search('不存在的查询词组xyzq');
      const { events: ev2 } = await svc.events({ ops: ['search'], limit: 100 });
      const last = ev2[0];
      assert.equal(last.detail.hits, 0);
      assert.equal(last.detail.topScore, null, '无命中 topScore=null（null≠0）');
      assert.equal(miss.items.length, 0);
    } finally {
      if (svc) await svc.close().catch(() => {});
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('staleHits 统计正确：includeDisputed 命中里 4 条 disputed → staleHits>=4', async () => {
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-sm-'));
    let svc;
    try {
      svc = await createMemoryService({ memoHome, scope: 'repo:sm-stale' });
      // 4 对矛盾事实 → 4 条 disputed + 4 条 active，文本都含 staleprobe 词根
      for (const tag of ['a', 'b', 'c', 'd']) await writeDisputedPair(svc, tag);
      const res = await svc.search('staleprobe 旧结论', { includeDisputed: true, limit: 20 });
      assert.ok(res.items.length >= 4, `应召回含 disputed 的 >=4 条，实际 ${res.items.length}`);
      // 直接从返回集复算口径，和事件里的 staleHits 对账
      const expectStale = res.items.filter(
        ({ record }) => record.status !== 'active',
      ).length;
      assert.ok(expectStale >= 4, `返回集里应有 >=4 条非 active，实际 ${expectStale}`);
      const { events } = await svc.events({ ops: ['search'], limit: 100 });
      assert.equal(events[0].detail.staleHits, expectStale, '事件 staleHits 与返回集口径一致');
      assert.ok(events[0].detail.staleHits >= 4);
    } finally {
      if (svc) await svc.close().catch(() => {});
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});

describe('nightly metrics 口径（裁决 52：分母 0 → null ≠ 0）', () => {
  test('0 次检索 → 四个字段全 null', async () => {
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-sm-'));
    try {
      let svc = await createMemoryService({ memoHome, scope: 'repo:sm-zero' });
      await svc.write({
        kind: 'fact', text: '与检索无关的记录', subject: 'x', predicate: 'y',
        value: 'z', source: { agent: 'test' },
      });
      await svc.close();
      const m = await runNightly(memoHome, 'repo:sm-zero');
      assert.equal(m.searchCount, null);
      assert.equal(m.noHitRate, null);
      assert.equal(m.staleHitRate, null);
      assert.equal(m.avgTopScore, null);
    } finally {
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('3 次检索其中 1 次空结果 → noHitRate≈0.333，其余口径一致', async () => {
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-sm-'));
    let svc;
    try {
      svc = await createMemoryService({ memoHome, scope: 'repo:sm-three' });
      await svc.write({
        kind: 'fact', text: '推荐用 Node 22', subject: 'toolchain.node',
        predicate: 'version', value: 'v22', source: { agent: 'test' },
      });
      await svc.search('Node 推荐');
      await svc.search('Node 推荐');
      await svc.search('不存在的查询词组xyzq');
      const { events } = await svc.events({ ops: ['search'], limit: 100 });
      assert.equal(events.length, 3);

      const scores = events.map((e) => e.detail.topScore).filter((v) => typeof v === 'number');
      const expectAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
      await svc.close();

      const m = await runNightly(memoHome, 'repo:sm-three');
      assert.equal(m.searchCount, 3);
      assert.ok(Math.abs(m.noHitRate - 1 / 3) < 1e-9, `noHitRate≈0.333，实际 ${m.noHitRate}`);
      assert.equal(m.staleHitRate, 0);
      assert.ok(Math.abs(m.avgTopScore - expectAvg) < 1e-9, 'avgTopScore 与事件均值一致');
      // 落盘文件同样不出现 query 原文
      const raw = readFileSync(join(memoHome, 'metrics', metricsFileName(today(), 'repo:sm-three')), 'utf8');
      assert.ok(!raw.includes('不存在的查询词组xyzq'));
    } finally {
      if (svc) await svc.close().catch(() => {});
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
