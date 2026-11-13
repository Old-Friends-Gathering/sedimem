import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// 用相对本文件的路径，别把个人 home 写进仓库（安全门禁 S4）
const root = new URL('../../src/', import.meta.url).pathname;
const { createMemoryService } = await import(root + 'api/service.js');
const { startSession } = await import(root + 'session/lifecycle.js');
const { sessionCli } = await import(root + 'cli/session.js');
const home = mkdtempSync(path.join(tmpdir(), 'adv03d2-'));
const main = await createMemoryService({ memoHome: home, scope: 'repo:main' });
const { scope } = await startSession({ service: main, title: 'd' });
const s = await createMemoryService({ memoHome: home, scope });
await s.write({ text: 'race decision unique-body-X7Q', kind: 'decision', title: '并发', value: 'VALDIFF', source: { agent: 'adv' } });
await s.close();
await Promise.all([
  sessionCli(['close', '--scope', scope, '--json'], { service: main, memoHome: home, out: { write() {} } }),
  sessionCli(['close', '--scope', scope, '--json'], { service: main, memoHome: home, out: { write() {} } }).catch(e => ({ err: e.message })),
]);
const lines = readFileSync(path.join(home, 'items', 'repo:main.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const d = lines.filter(r => r.text === 'race decision unique-body-X7Q');
console.log('主库 decision 记录数:', d.length, '状态:', d.map(r => r.status).join(','));
await main.close();
