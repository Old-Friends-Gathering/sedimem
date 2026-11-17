// I46 向后兼容：v1.0 数据（新事件 op / 新目录 / 坏派生行）不得让读端崩溃
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';

test('I46 未知事件 op + 坏派生行：读端只降级不崩', async () => {
  const memoHome = await fs.mkdtemp(path.join(os.tmpdir(), 'i46-'));
  const svc = await createMemoryService({ memoHome, scope: 'repo:i46' });
  await svc.write({ text: 'v1.0 写入的记录，老 reader 也要能读', kind: 'fact', source: { agent: 'test' } });
  await svc.close();

  // 模拟未来版本追加的未知事件 op 与半行 JSON
  await fs.appendFile(path.join(memoHome, 'events.jsonl'), '{"ts":"2026-01-01T00:00:00.000Z","op":"derive","scope":"repo:i46","detail":{"future":true}}\n');
  await fs.appendFile(path.join(memoHome, 'events.jsonl'), '{"ts":"2026-01-01T00:00:01.000Z","op":"fut\n');
  // 派生 sidecar 里塞坏行
  await fs.mkdir(path.join(memoHome, 'derived'), { recursive: true });
  await fs.appendFile(path.join(memoHome, 'derived', 'repo-i46.jsonl'), '{"id":"x","validFrom":\n');

  const svc2 = await createMemoryService({ memoHome, scope: 'repo:i46' });
  const stats = await svc2.stats();
  assert.equal(stats.total, 1, '坏事件行不应影响真相层读取');
  const brief = await svc2.brief({});
  // brief 只渲染标题与计数，正文不进 brief（读侧三级披露）；这里断言它没崩且计数正确
  assert.ok(brief.includes('active: 1'), 'brief 应能正常渲染');
  const search = await svc2.search('记录', { limit: 5 });
  assert.ok(search.items.length >= 1);
  await svc2.close();
});
