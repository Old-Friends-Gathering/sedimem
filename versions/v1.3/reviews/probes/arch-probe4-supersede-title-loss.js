// arch 探针 4：supersede 是否丢失旧记录的 title？以及 titleEnforce=true 时 supersede 无 title 也不报错。
import { createMemoryService } from '../../src/api/service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'sedimem-arch4-'));
try {
  const policy = JSON.parse(JSON.stringify((await import('../../src/config/policy.js')).defaultPolicy));
  policy.write = { ...(policy.write ?? {}), titleEnforce: true };
  const svc = await createMemoryService({ memoHome: home, scope: 'dir:arch4', policy });
  const a = await svc.write({ text: '用 pnpm 不用 npm', kind: 'gotcha', title: '包管理器选择', source: { agent: 'test' } });
  console.log('[1] 原记录 title =', JSON.stringify(a.record.title));
  const r = await svc.supersede({ oldId: a.record.id, value: '统一用 pnpm@9，禁用 npm install', source: { agent: 'test' } });
  console.log('[2] supersede 后新记录 title =', JSON.stringify(r.record.title), '(titleEnforce=true 也未报错)');
  await svc.close();
} finally { rmSync(home, { recursive: true, force: true }); }
