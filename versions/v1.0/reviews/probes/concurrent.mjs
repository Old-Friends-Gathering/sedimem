// probes/concurrent.mjs — 并发写攻击（审查 probes，只读 src）
// 用法: node probes/concurrent.mjs <memoHome> same|diff [n]
import { createMemoryService } from '../../src/api/service.js';
const home = process.argv[2];
const scope = 'repo:conc';
const mode = process.argv[3] ?? 'same';
const s = await createMemoryService({ memoHome: home, scope });
if (mode === 'same') {
  const r = await s.write({ text: '并发写入的同一条事实', subject: 'conc', predicate: 'same', source: { agent: 'test' } });
  console.log('action=' + r.action + ' id=' + r.record.id);
} else {
  const n = process.argv[4];
  const r = await s.write({ text: `并发写入的不同事实 #${n}`, subject: 'conc', predicate: `d${n}`, source: { agent: 'test' } });
  console.log('action=' + r.action + ' id=' + r.record.id);
}
await s.close();
