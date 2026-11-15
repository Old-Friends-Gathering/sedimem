// I41 派生落 sidecar 且真相层字节不变（裁决 83/84）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMemoryService } from '../../src/api/service.js';
import { itemsFileName } from '../../src/config/paths.js';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function fakePort(reply) {
  return {
    name: 'fake', model: 'fake-1', ready: true,
    async complete() {
      return { ok: true, text: JSON.stringify(reply), usage: { inTokens: 100, outTokens: 30 }, cached: false };
    },
  };
}

test('I41 派生写 sidecar，真相层逐字节不变', async () => {
  const memoHome = await fs.mkdtemp(path.join(os.tmpdir(), 'i41-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:i41', policy: { llm: { provider: 'none', egress: 'local-only', dailyLimitCny: 5, price: { inPerM: 0, outPerM: 0 }, purposes: {} }, derive: { promptVersion: 'd1-v1', maxAttempts: 3 } }, llmPort: fakePort({ title: '派生标题', summary: '一句话摘要', tags: ['deploy'] }) });
  await svc.write({ text: '门禁脚本在 CI 里跑 quality 与 security 两个检查', kind: 'fact', source: { agent: 'test' } });
  const itemsPath = path.join(memoHome, 'items', itemsFileName('repo:i41'));
  const before = sha(await fs.readFile(itemsPath));

  const drained = await svc.drainDerive({ limit: 5 });
  assert.equal(drained.ok, 1, '应成功派生一条');
  const after = sha(await fs.readFile(itemsPath));
  assert.equal(after, before, '派生前后真相层必须逐字节相同');

  const derivedFile = path.join(memoHome, 'derived', 'repo-i41.jsonl');
  const lines = (await fs.readFile(derivedFile, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.deriveStatus, 'ok');
  assert.equal(rec.title, '派生标题');
  await svc.close();
});

test('I41b brief 使用派生 title，缺失时回落规则字段', async () => {
  const memoHome = await fs.mkdtemp(path.join(os.tmpdir(), 'i41b-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:i41b', policy: { llm: { provider: 'none', egress: 'local-only', dailyLimitCny: 5, price: { inPerM: 0, outPerM: 0 }, purposes: {} }, derive: { promptVersion: 'd1-v1', maxAttempts: 3 } }, llmPort: fakePort({ title: 'CI 门禁', summary: '两个检查', tags: [] }) });
  await svc.write({ text: '质量门禁与安全门禁都在 CI 里跑', kind: 'fact', source: { agent: 'test' } });
  const before = await svc.brief({});
  assert.ok(!before.includes('CI 门禁'), '未派生时不应出现派生标题');
  await svc.drainDerive({ limit: 5 });
  const after = await svc.brief({});
  assert.ok(after.includes('CI 门禁'), '派生成功后 brief 应使用派生标题');
  await svc.close();
});
