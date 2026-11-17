// I36 — 裁决不能复活墓碑（v0.4 对抗审核 B-6 的回归）
// 钉住：已 tombstoned 的记录不参与 curateApply（keep_both 不得翻回 active、a_wins 不得复活 winner）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';

async function setup() {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i36-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i36', cwd: memoHome });
  return { service, memoHome };
}

test('I36 tombstoned 记录被拒绝参与裁决（keep_both 与 a_wins 都不能复活它）', async () => {
  const { service } = await setup();
  const a = await service.write({ text: '发布流程的约定是门禁全绿才合并', subject: 'release', predicate: 'rule', value: '门禁全绿', source: { agent: 'cli' } });
  const b = await service.write({ text: '发布流程的约定是先跑完整门禁再合并', subject: 'release', predicate: 'gating', value: '完整门禁', source: { agent: 'cli' } });
  await service.forget({ id: b.record.id, mode: 'purge', reason: '误写' });
  const stats0 = await service.stats();
  assert.equal(stats0.tombstoned, 1, JSON.stringify(stats0));

  for (const decision of ['keep_both', 'a_wins', 'b_wins']) {
    await assert.rejects(
      () => service.curateApply({ decisions: [{ ids: [a.record.id, b.record.id], decision }] }),
      (e) => e.code === 'E_INVALID_ARG' && /tombstoned/.test(e.message),
      `decision=${decision} 应被拒`,
    );
  }
  const stats = await service.stats();
  assert.equal(stats.tombstoned, 1, '墓碑必须还是墓碑');
  assert.equal(stats.active, 1);
  await service.close();
});
