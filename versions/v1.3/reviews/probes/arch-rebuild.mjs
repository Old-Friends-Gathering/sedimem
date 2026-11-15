// probe 2: 可重建性 —— 建库 → 写 5 条（含 supersede / forget / disputed）→ 删除全部派生层 → 重建比对
import { createMemoryService } from '../../src/api/service.js';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'memo-arch2-'));
const mk = (extra = {}) => createMemoryService({ memoHome: home, scope: 'repo:probe', ...extra });

const svc = await mk();
const ids = [];
for (let i = 1; i <= 3; i++) {
  const r = await svc.write({ text: `fact number ${i}`, kind: 'fact', subject: `s${i}`, predicate: 'text', value: String(i), source: { agent: 'test' } });
  ids.push(r.record.id);
}
// 同 slot 异值（数字可比 → supersede）
await svc.write({ text: 'port is 8081', subject: 'server', predicate: 'port', value: '8081', source: { agent: 'test' } });
await svc.write({ text: 'port is 8080', subject: 'server', predicate: 'port', value: '8080', source: { agent: 'test' } });
// 不可比 → disputed
await svc.write({ text: 'db is mysql', subject: 'server', predicate: 'db', value: 'mysql', source: { agent: 'test' } });
await svc.write({ text: 'db is postgres', subject: 'server', predicate: 'db', value: 'postgres', source: { agent: 'test' } });
// 墓碑
await svc.forget({ id: ids[0], reason: 'probe' });
// 检索制造 hits，close() 触发 flushHits
await svc.search('fact number', {});
await svc.close();

const before = {
  stats: await (async () => { const s = await mk(); const st = await s.stats(); await s.close(); return st; })(),
};
console.log('BEFORE stats:', JSON.stringify(before.stats));
const itemsDirBefore = readFileSync(join(home, 'items', 'repo:probe.jsonl'), 'utf8').split('\n').filter(Boolean).length;
console.log('truth lines before:', itemsDirBefore);

// 磁盘上到底有哪些派生物？
console.log('top-level after writes:', readdirSync(home));
console.log('brief/ exists:', existsSync(join(home, 'brief')));
console.log('index/ exists:', existsSync(join(home, 'index')));

// 删除所有派生层：queue / metrics / events（保留 items）
rmSync(join(home, 'queue'), { recursive: true, force: true });
rmSync(join(home, 'metrics'), { recursive: true, force: true });
rmSync(join(home, 'events.jsonl'), { force: true });
console.log('deleted derived: queue/ metrics/ events.jsonl (only items/ kept)');

const svc2 = await mk();
const after = await svc2.stats();
console.log('AFTER stats:', JSON.stringify(after));
const same = JSON.stringify(before.stats) === JSON.stringify(after);
console.log('REBUILD_STATS_EQUAL:', same);
await svc2.search('port', {});
await svc2.close();

// 检查：崩前未 close 的 hits 是否会丢（模拟：写→不 close→直接读文件）
const svc3 = await mk();
await svc3.write({ text: 'hits loss check', subject: 'hits', predicate: 'text', value: 'x', source: { agent: 'test' } });
await svc3.search('hits loss check', {});
// 不调用 close()，直接终止（模拟进程崩溃）
process.exit(0);
