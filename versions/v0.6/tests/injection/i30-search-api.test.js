// I30 — /api/search 契约（v0.4 D1/D8 / issue #109）
// 钉住：返回 score+basis 可解释字段；语义道关闭时 degraded=true 且 reason 可读
// （UI 据此提示「已降级为词法」）；空 q 走 400；结果只含当前分库。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';

const SRC = { agent: 'test' };

test('I30 /api/search：basis/degraded 字段齐备，空 q 400，跨分库不串', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i30-'));
  const service = await createMemoryService({ memoHome: home, scope: 'repo:i30', cwd: home });
  const web = await createWebServer({ memoHome: home, scope: 'repo:i30', service, port: 0, includeUi: false });
  try {
    await service.write({ text: '观察台默认端口是 7788', kind: 'fact', subject: 'observer', predicate: 'port', value: '7788', source: SRC });
    await service.write({ text: 'nightly 在 03:30 由 launchd 触发', kind: 'fact', source: SRC });

    const r = await fetch(`${web.url}api/search?q=${encodeURIComponent('端口')}&limit=10`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(body.items.length >= 1, JSON.stringify(body));
    const first = body.items[0];
    assert.equal(typeof first.score, 'number');
    assert.ok(['bm25', 'vector', 'bm25+vector'].includes(first.basis), `basis=${first.basis}`);
    assert.equal(typeof first.validFrom, 'string');
    // 默认 policy 的 embedder.kind = none → 必须显式降级，而不是假装向量检索
    assert.equal(body.degraded, true, '语义道关闭时必须标 degraded');
    assert.equal(body.degradedReason, 'semantic-disabled');

    const bad = await fetch(`${web.url}api/search?q=`);
    assert.equal(bad.status, 400, '空 q 必须 400，不能返回全库');
    const badBody = await bad.json();
    assert.equal(badBody.code, 'E_INVALID_ARG');

    // 另一个分库的记录不得出现在本分库结果里
    const other = await createMemoryService({ memoHome: home, scope: 'repo:other', cwd: home });
    try {
      await other.write({ text: '别的项目：端口是 9999', kind: 'fact', source: SRC });
    } finally {
      await other.close();
    }
    const r2 = await (await fetch(`${web.url}api/search?q=${encodeURIComponent('端口')}&limit=50`)).json();
    assert.ok(r2.items.every((it) => !it.text.includes('9999')), '跨分库串味');
  } finally {
    await web.close();
    await service.close();
  }
});
