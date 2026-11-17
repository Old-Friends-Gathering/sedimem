// probe 4: 常驻服务（MCP 形态）跨进程写不可见 → 写入门控失效
// A 先启动（空库缓存），B 写入两条后关闭；A 继续 write 同内容 → 应 noop_duplicate，实际 created。
import { createMemoryService } from '../../src/api/service.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'memo-arch7-'));
const A = await createMemoryService({ memoHome: home, scope: 'repo:probe' });
const B = await createMemoryService({ memoHome: home, scope: 'repo:probe' });
await B.write({ text: 'deploy port is 443', subject: 'server', predicate: 'port', value: '443', source: { agent: 'test' } });
await B.write({ text: 'deploy port is 8443', subject: 'server', predicate: 'port', value: '8443', source: { agent: 'test' } });
await B.close();

const r1 = await A.write({ text: 'deploy port is 443', subject: 'server', predicate: 'port', value: '443', source: { agent: 'test' } });
console.log('A writes exact duplicate of B fact -> action:', r1.action, '(expected noop_duplicate)');
const r2 = await A.search('deploy port', {});
console.log('A search total (stale view):', r2.total);
const active = readFileSync(join(home, 'items', 'repo:probe.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.status === 'active');
console.log('active values in truth layer:', active.map((r) => r.value));
await A.close();
