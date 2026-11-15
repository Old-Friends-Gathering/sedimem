// I27 — disputed 一等公民（v0.4 D4 / issue #105）
// 钉住：同 slot 不同 value 会进 disputed；/api/conflicts 按 slot 暴露候选对；
// resolve 后败者 superseded、胜者 active、真相层行数只增不减（非破坏）、重放幂等。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { createWebServer } from '../../src/web/server.js';
import { listConflicts, resolveConflicts } from '../../src/views/conflicts.js';

const SRC = { agent: 'test' };

test('I27 分歧可见 → 裁决 → 收敛（真相层只增）', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i27-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i27', cwd: memoHome });
  const web = await createWebServer({ memoHome, scope: 'repo:i27', service, port: 0, includeUi: false });
  try {
    // 不可比的值才会进 disputed：可比值（如端口数字更大）会走 supersede 状态推进，不是分歧。
    const a = await service.write({ text: '观察台主题色是 slate（深色偏蓝）', kind: 'pref', subject: 'observer', predicate: 'theme', value: 'slate', source: SRC });
    const b = await service.write({ text: '观察台主题色是 paper（浅灰）', kind: 'pref', subject: 'observer', predicate: 'theme', value: 'paper', source: SRC });
    assert.equal(b.action, 'disputed', `不可比的值应判 disputed，实际 ${b.action}`);

    // 注意：exportRecords 是按 id 去重后的投影；「真相层只增」要看原始 jsonl 行数。
    const itemsFile = path.join(memoHome, 'items', 'repo:i27.jsonl');
    const rowsBefore = (await fsp.readFile(itemsFile, 'utf8')).split('\n').filter(Boolean).length;
    const view = await listConflicts({ service });
    assert.equal(view.disputedCount, 1, `disputed: ${view.disputedCount}`);
    assert.equal(view.slots.length, 1);
    assert.ok(view.slots[0].records.length >= 2, '分歧 slot 至少两条');

    const api = await (await fetch(`${web.url}api/conflicts`)).json();
    assert.equal(api.ok, true);
    assert.equal(api.slots.length, 1, '/api/conflicts 必须暴露同一 slot');

    const r = await resolveConflicts({ service, slot: view.slots[0].key, winnerId: a.record.id });
    assert.ok(r.resolved.length >= 1, `落败条数: ${JSON.stringify(r)}`);

    const after = await listConflicts({ service });
    assert.equal(after.disputedCount, 0, '裁决后不应再有 disputed');
    const rowsAfter = (await fsp.readFile(itemsFile, 'utf8')).split('\n').filter(Boolean).length;
    assert.ok(rowsAfter > rowsBefore, `真相层只增不减：${rowsBefore} → ${rowsAfter}`);

    // 幂等：重放同一裁决不产生新版本
    const again = await resolveConflicts({ service, slot: view.slots[0].key, winnerId: a.record.id });
    assert.equal(again.resolved.length, 0, '重放应跳过');

    const winner = await service.get(a.record.id);
    assert.equal(winner.status, 'active');
    const loser = await service.get(b.record.id);
    assert.equal(loser.status, 'superseded');
  } finally {
    await web.close();
    await service.close();
  }
});
