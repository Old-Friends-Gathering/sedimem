// I44 派生输出不得携带真相字段；kindHint 只作审计（v1.0 W3 裁决 85）
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
  const memoHome = await fs.mkdtemp(path.join(os.tmpdir(), 'i44-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:i44', llmPort: port });
  return { svc, memoHome };
}

test('I44 LLM 输出含真相字段：判 failed 且不写任何真相字段', async () => {
  const { svc } = await makeService(portFor({ title: '标题', summary: '摘要', tags: [], kind: 'pref', text: '被篡改的正文', value: 'x' }));
  const w = await svc.write({ text: '原始正文不可被派生层改写', kind: 'fact', source: { agent: 'test' } });
  await svc.drainDerive({ limit: 5 });
  const d = await svc.derivedFor(w.record.id, w.record.validFrom);
  assert.equal(d.deriveStatus, 'failed');
  assert.equal(Object.hasOwn(d, 'kind'), false, 'derived 不得包含 kind');
  assert.equal(Object.hasOwn(d, 'text'), false, 'derived 不得包含 text');
  assert.equal(Object.hasOwn(d, 'value'), false, 'derived 不得包含 value');
  // 真相层仍是原值
  const rec = await svc.get(w.record.id);
  assert.equal(rec.kind, 'fact');
  assert.equal(rec.text, '原始正文不可被派生层改写');
  await svc.close();
});

test('I43b kindHint 与记录 kind 不一致：只记 kindMismatch，不改记录', async () => {
  const { svc } = await makeService(portFor({ title: '标题', summary: '摘要', tags: [], kindHint: 'pref' }));
  const w = await svc.write({ text: '这是一条事实而不是偏好', kind: 'fact', source: { agent: 'test' } });
  await svc.drainDerive({ limit: 5 });
  const d = await svc.derivedFor(w.record.id, w.record.validFrom);
  assert.equal(d.deriveStatus, 'ok');
  assert.equal(d.kindMismatch, true);
  const rec = await svc.get(w.record.id);
  assert.equal(rec.kind, 'fact', 'kindHint 只作审计');
  await svc.close();
});
