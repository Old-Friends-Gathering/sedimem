// tests/unit/graph-nodes.test.js — 图谱节点聚合（裁决 60 / issue #61）
// 起因：实测 118 条记录的图里 51% 节点与别人重名（同 subject 写 7 条 = 7 个一样的标签）。
// 现在同 subject 合并成一个点，用 count + predicates 表达「一个主题的多条记录」。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';

async function setup() {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-graph-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:g', cwd: memoHome });
  const web = await createWebServer({ memoHome, scope: 'repo:g', service, port: 0, includeUi: false });
  return {
    memoHome,
    service,
    base: web.url,
    async close() {
      await web.close();
      await service.close?.();
      await fsp.rm(memoHome, { recursive: true, force: true });
    },
  };
}

test('同 subject 聚合：count / predicates / label 用 title', async () => {
  const ctx = await setup();
  try {
    // 同一主题 3 条（不同 predicate），其中一条给 title
    await ctx.service.write({ text: '端口 8080', kind: 'fact', subject: 'svc', predicate: 'port', value: '8080', source: { agent: 'test' } });
    await ctx.service.write({ text: '超时 30s', kind: 'fact', subject: 'svc', predicate: 'timeout', value: '30s', source: { agent: 'test' } });
    await ctx.service.write({ text: '重试 3 次', kind: 'fact', subject: 'svc', predicate: 'retry', value: '3', source: { agent: 'test' } });
    // 另一个主题，带 title
    await ctx.service.write({ text: '真相层只追加', kind: 'fact', subject: 'truth', predicate: 'storage', value: 'jsonl', title: '真相层是追加写的 JSONL', source: { agent: 'test' } });

    const g = await (await fetch(`${ctx.base}api/graph?limit=300&days=90`)).json();
    assert.equal(g.ok, true);

    const svc = g.nodes.filter((n) => n.subject === 'svc');
    assert.equal(svc.length, 1, '同 subject 应只出现一个节点');
    assert.equal(svc[0].count, 3);
    assert.deepEqual([...svc[0].predicates].sort(), ['port', 'retry', 'timeout']);
    assert.equal(svc[0].label, 'svc', '没有 title 时退回 subject');

    const truth = g.nodes.find((n) => n.subject === 'truth');
    assert.equal(truth.label, '真相层是追加写的 JSONL', '有 title 时 label 用 title');

    // 聚合后不应出现自环边
    for (const e of g.edges ?? []) assert.notEqual(e.from, e.to);
    // 采样信息带上「记录数」，与「节点数」区分开
    assert.equal(g.sampled.records, 4);
    assert.ok(g.sampled.shown <= 2);
  } finally {
    await ctx.close();
  }
});

test('不同 subject 不合并；非结构化每条独立成点', async () => {
  const ctx = await setup();
  try {
    await ctx.service.write({ text: 'A 事实', kind: 'fact', subject: 'alpha', predicate: 'p', value: '1', source: { agent: 'test' } });
    await ctx.service.write({ text: 'B 事实', kind: 'fact', subject: 'beta', predicate: 'p', value: '2', source: { agent: 'test' } });
    await ctx.service.write({ text: '自由文本一，讲的是部署', kind: 'fact', source: { agent: 'test' } });
    await ctx.service.write({ text: '自由文本二，讲的是门禁', kind: 'fact', source: { agent: 'test' } });

    const g = await (await fetch(`${ctx.base}api/graph?limit=300&days=90`)).json();
    const structured = g.nodes.filter((n) => n.subject !== 'text');
    assert.equal(structured.length, 2);
    const unstruct = g.nodes.filter((n) => n.subject === 'text');
    assert.equal(unstruct.length, 2, '非结构化没有 subject 可聚合，必须各自成点');
    assert.equal(unstruct[0].count, 1);
    assert.ok(unstruct.every((n) => n.label && !n.label.includes('text')));
  } finally {
    await ctx.close();
  }
});
