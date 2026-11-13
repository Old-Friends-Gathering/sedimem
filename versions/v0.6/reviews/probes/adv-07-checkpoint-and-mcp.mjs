// adv-07: (a) checkpoint 8 段 value 无长度上限（绕过硬上限的另一面）；(b) MCP close 的 mainScopeFor 不拒 session 型 parentScope（代码级差异 + 模拟）。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = new URL('../../src/', import.meta.url).pathname;
const { createMemoryService } = await import(path.join(root, 'api/service.js'));
const { startSession } = await import(path.join(root, 'session/lifecycle.js'));
const { writeCheckpoint } = await import(path.join(root, 'session/checkpoint.js'));
const home = mkdtempSync(path.join(tmpdir(), 'adv07-'));
const out = [];
const main = await createMemoryService({ memoHome: home, scope: 'repo:main' });
const { scope } = await startSession({ service: main, title: 'adv07' });
const s = await createMemoryService({ memoHome: home, scope });
const big = 'X'.repeat(60000);
const r = await writeCheckpoint({ service: s, scope, checkpoint: { intent: big, currentState: big } });
out.push(`checkpoint valueLen=${r.record.value.length} textLen=${r.record.text.length}（text 硬上限 4000，value 面 60000 字直接落盘）`);
await s.close();

// (b) 模拟 MCP mainScopeFor：meta.parentScope='session:other-1' 时 MCP 不校验（cli/session.js:195 有校验，server.js:546 没有）
const main2 = await createMemoryService({ memoHome: home, scope: 'repo:main' });
const { scope: s2scope } = await startSession({ service: main2, title: 'adv07b' });
const s2 = await createMemoryService({ memoHome: home, scope: s2scope });
await s2.write({ text: 'evil meta', kind: 'state', subject: 'session', predicate: 'meta',
  value: JSON.stringify({ id: s2scope.slice(8), status: 'open', parentScope: 'session:other-1', startedAt: new Date().toISOString() }), source: { agent: 'adv' } });
await s2.write({ text: 'decision into another session', kind: 'decision', title: 'd', source: { agent: 'adv' } });
await s2.close();
// CLI close（有校验）：
try {
  await import(path.join(root, 'cli/session.js')).then(m => m.sessionCli(['close', '--scope', s2scope], { service: main2, memoHome: home, out: { write() {} } }));
  out.push('b CLI close session 型 parentScope: 通过（不该）');
} catch (e) { out.push(`b CLI close session 型 parentScope: 拒绝 (${e.code}) — 与 MCP 行为差异见报告`); }
await main2.close();
console.log(out.join('\n'));
