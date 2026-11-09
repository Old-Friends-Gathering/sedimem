// I24 — 标题与标签的可读性（裁决 59/60 / issue #61）
// 钉住三件事：title 进 label、brief 行首用 title、图谱同 subject 聚合（count 之和 = 记录数）。
// 为什么放在注入层：这三件事各自都有单测，但「同一份数据在三个面上都一致」只有端到端能验。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';
import { makeLabel } from '../../src/web/handlers.js';

const SRC = { agent: 'test' };

test('I24 标题优先 + 同主题聚合（label / brief / graph 三面一致）', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i24-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i24', cwd: memoHome });
  const web = await createWebServer({ memoHome, scope: 'repo:i24', service, port: 0, includeUi: false });
  try {
    // 同一主题 3 条，只有第一条带 title
    await service.write({ text: '观察台默认跑在 127.0.0.1:7788', title: '观察台端口 7788', kind: 'fact', subject: 'observer', predicate: 'port', value: '7788', source: SRC });
    await service.write({ text: '观察台只读，没有写端点', kind: 'fact', subject: 'observer', predicate: 'readonly', value: 'true', source: SRC });
    await service.write({ text: '观察台支持 ?scope= 切分库', kind: 'fact', subject: 'observer', predicate: 'scope', value: 'query', source: SRC });
    // 两条自由文本（无法聚合）
    await service.write({ text: '部署脚本在 scripts/strata-run.sh', kind: 'fact', source: SRC });
    await service.write({ text: '夜间整合 03:30 由 launchd 触发', kind: 'fact', source: SRC });

    const all = await service.exportRecords({ status: 'all', limit: 1000 });
    const titled = all.records.find((r) => r.title === '观察台端口 7788');
    assert.ok(titled, 'title 必须被写进真相层并能导出');
    assert.equal(makeLabel(titled), '观察台端口 7788', 'label 必须直接用 title');

    // brief：有 title 的行以 title 开头，不再糊整段正文
    const brief = await service.brief({});
    assert.ok(brief.includes('观察台端口 7788'), 'brief 应出现 title');
    assert.ok(!brief.includes('观察台默认跑在 127.0.0.1:7788'), 'brief 行首用了 title 就不该再糊整段正文');

    // graph：同 subject 一个点，count 之和等于记录数
    const g = await (await fetch(`${web.url}api/graph?limit=300&days=90`)).json();
    assert.equal(g.ok, true);
    const obs = g.nodes.filter((n) => n.subject === 'observer');
    assert.equal(obs.length, 1, '同 subject 必须合并为一个节点');
    assert.equal(obs[0].count, 3);
    assert.equal(obs[0].label, '观察台端口 7788');
    assert.deepEqual([...obs[0].predicates].sort(), ['port', 'readonly', 'scope']);
    const totalCount = g.nodes.reduce((s, n) => s + n.count, 0);
    assert.equal(totalCount, all.records.length, '×N 之和必须等于记录数（聚合不能凭空吞记录）');
    assert.ok(g.nodes.length <= all.records.length);
    for (const e of g.edges ?? []) assert.notEqual(e.from, e.to, '聚合后不允许自环边');
  } finally {
    await web.close();
    await service.close?.();
    await fsp.rm(memoHome, { recursive: true, force: true });
  }
});
