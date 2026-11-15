// I43 预算超限 → budget-exceeded；I44 输出含真相字段 → failed 且不落真相字段
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';

const portFor = (reply) => ({
  name: 'fake', model: 'fake-1', ready: true,
  complete: async () => (reply.error
    ? { ok: false, error: reply.error }
    : { ok: true, text: JSON.stringify(reply), usage: { inTokens: 10, outTokens: 5 }, cached: false }),
});

async function makeService(port) {
  const memoHome = await fs.mkdtemp(path.join(os.tmpdir(), 'i43-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:i43', llmPort: port });
  return { svc, memoHome };
}

test('I43 预算超限：deriveStatus=budget-exceeded，写入不受影响', async () => {
  const { svc } = await makeService(portFor({ error: { code: 'E_LLM_BUDGET_EXCEEDED', message: 'over budget' } }));
  const w = await svc.write({ text: '预算超限时写入仍必须成功', kind: 'fact', source: { agent: 'test' } });
  assert.equal(w.action, 'created');
  await svc.drainDerive({ limit: 5 });
  const d = await svc.derivedFor(w.record.id, w.record.validFrom);
  assert.equal(d.deriveStatus, 'budget-exceeded');
  await svc.close();
});
