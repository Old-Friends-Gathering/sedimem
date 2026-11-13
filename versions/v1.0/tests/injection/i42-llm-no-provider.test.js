// I42 无 provider 时 no-provider 且写入路径完全不受影响（fail-open）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';

test('I42 未配置 provider：写入成功、派生降级 no-provider、不抛', async () => {
  const memoHome = await fs.mkdtemp(path.join(os.tmpdir(), 'i42-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:i42' });
  const outcome = await svc.write({ text: '默认配置下写记忆不应依赖任何 LLM', kind: 'fact', source: { agent: 'test' } });
  assert.equal(outcome.action, 'created');

  const drained = await svc.drainDerive({ limit: 5 });
  assert.equal(drained.claimed, 1);
  assert.equal(drained.ok, 0, 'no-provider 不算成功');

  const derived = await svc.derivedFor(outcome.record.id, outcome.record.validFrom);
  assert.equal(derived.deriveStatus, 'no-provider');
  assert.ok(typeof derived.title === 'string' && derived.title.length > 0, '兜底 title 必须存在');
  assert.equal(outcome.record.kind, 'fact', '派生不得改真相字段');
  await svc.close();
});
