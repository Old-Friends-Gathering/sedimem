// arch 探针 1：写侧粒度契约是否只在 writeRecord 生效？
// 假设：supersedeRecord 调 createRecord 未传 policy → textHardMaxChars 回落 4000 默认；
//       自定义 policy（如 500）下 supersede 3000 字 text 仍能落盘，且无 warnings/long-form、无 titleEnforce。
import { createMemoryService } from '../../src/api/service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'sedimem-arch1-'));
try {
  // 自定义 policy：textHardMaxChars=500
  const policy = JSON.parse(JSON.stringify((await import('../../src/config/policy.js')).defaultPolicy));
  policy.write = { ...(policy.write ?? {}), textHardMaxChars: 500, titleEnforce: true };
  const svc = await createMemoryService({ memoHome: home, scope: 'dir:arch1', policy });
  const long3000 = 'x'.repeat(3000);
  const a = await svc.write({ text: 'v1 决策内容', kind: 'decision', title: '原始决策', source: { agent: 'test' } });
  console.log('[1] write 超自定义硬限(500)应报错:');
  try { await svc.write({ text: long3000, kind: 'decision', title: 't', source: { agent: 'test' } }); console.log('  FAIL: 未报错'); }
  catch (e) { console.log('  OK 报错:', e.message.slice(0, 80)); }

  console.log('[2] write 缺 title（titleEnforce=true）应报错:');
  try { await svc.write({ text: 'no title decision', kind: 'decision', source: { agent: 'test' } }); console.log('  FAIL: 未报错'); }
  catch (e) { console.log('  OK 报错:', e.message.slice(0, 60)); }

  console.log('[3] supersede 换成 3000 字 value/text（policy 限 500）:');
  try {
    const r = await svc.supersede({ oldId: a.record.id, value: long3000, source: { agent: 'test' } });
    console.log('  !!! supersede 成功落盘, text.len =', r.record.text.length, 'tags =', JSON.stringify(r.record.tags));
  } catch (e) {
    console.log('  OK supersede 也被拦:', e.message.slice(0, 80));
  }
  await svc.close();
} finally { rmSync(home, { recursive: true, force: true }); }
