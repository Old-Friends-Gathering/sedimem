// arch 探针 3：checkpoint 绕过写门禁直接 _commit —— 多次 checkpoint 是否堆积多条
// 同 slot active 记录，并把 session 库的 brief 刷成一堆重复的 checkpoint 行？
const { createMemoryService } = await import('../../src/api/service.js');
const { startSession } = await import('../../src/session/lifecycle.js');
const { writeCheckpoint } = await import('../../src/session/checkpoint.js');
const { renderBrief } = await import('../../src/render/brief.js');
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'sedimem-arch3-'));
try {
  const main = await createMemoryService({ memoHome: home, scope: 'dir:arch3' });
  const { scope } = await startSession({ service: main, title: 'cp-flood' });
  const svc = await createMemoryService({ memoHome: home, scope });
  const cp = { intent: '做 X', currentState: '进行中' };
  for (let i = 1; i <= 6; i++) {
    await writeCheckpoint({ service: svc, checkpoint: { ...cp, criticalContext: `round ${i}` } });
  }
  const active = [...svc._records.values()].filter((r) => r.status === 'active');
  const cps = active.filter((r) => r.predicate === 'checkpoint');
  console.log('[1] 6 次 checkpoint 后 active 记录数 =', active.length, '其中 checkpoint active =', cps.length,
    '（同 slot 多条 active =', cps.length > 1, '）');
  const brief = renderBrief([...svc._records.values()], { scope });
  const cpLines = brief.split('\n').filter((l) => l.includes('checkpoint'));
  console.log('[2] session 库 brief 总行数 =', brief.split('\n').length, '，checkpoint 行数 =', cpLines.length);
  console.log('--- brief ---\n' + brief);
  await svc.close(); await main.close();
} finally { rmSync(home, { recursive: true, force: true }); }
