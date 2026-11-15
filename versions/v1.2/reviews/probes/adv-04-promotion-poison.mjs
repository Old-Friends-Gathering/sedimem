// adv-04: 晋升投毒 — session 里写含 secret 的 quote/text，close 后主库是否拿到明文。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('../../src/', import.meta.url).pathname;
const { createMemoryService } = await import(path.join(root, 'api/service.js'));
const { startSession } = await import(path.join(root, 'session/lifecycle.js'));
const { sessionCli } = await import(path.join(root, 'cli/session.js'));
const home = mkdtempSync(path.join(tmpdir(), 'adv04-'));
const out = [];

const main = await createMemoryService({ memoHome: home, scope: 'repo:main' });
const { scope } = await startSession({ service: main, title: 'adv04' });
const s = await createMemoryService({ memoHome: home, scope });

// text 面 + quote 面 + value 面各塞一个 secret
const w1 = await s.write({ text: 'db password=Hunter2TopSecret 请记住', kind: 'gotcha', title: '坑1', source: { agent: 'adv' } });
out.push(`session 写入 text面: action=${w1.action} tags=${JSON.stringify(w1.record.tags)}`);
const w2 = await s.write({ text: 'quote 面', kind: 'decision', title: '决策', value: 'v', source: { agent: 'adv', quote: 'api_key=sk-ant-supersecret123 盯紧' } });
out.push(`session 写入 quote面: tags=${JSON.stringify(w2.record.tags)} quote=${JSON.stringify(w2.record.source.quote)}`);
const w3 = await s.write({ text: 'value 面', kind: 'decision', title: '决策2', value: 'token=ghp_ValueFaceSecret000', source: { agent: 'adv' } });
out.push(`session 写入 value面: tags=${JSON.stringify(w3.record.tags)}`);
await s.close();

const r = await sessionCli(['close', '--scope', scope, '--json'], { service: main, memoHome: home, out: { write() {} } });
out.push(`close: promoted=${r.promoted.length}`);

const items = readFileSync(path.join(home, 'items', 'repo:main.jsonl'), 'utf8');
for (const sec of ['Hunter2TopSecret', 'sk-ant-supersecret123', 'ghp_ValueFaceSecret000']) {
  out.push(`主库含明文 ${sec}: ${items.includes(sec) ? 'YES（泄露!）' : 'no'}`);
}
out.push(`主库 redacted 标记: ${(items.match(/redacted:[a-z]+/g) ?? []).join(',') || '无'}`);
// 脱敏是否发生在“session 写入时”（第一道）——检查 session items
const sessItems = readFileSync(path.join(home, 'items', scope + '.jsonl'), 'utf8');
out.push(`session 库明文 Hunter2TopSecret: ${sessItems.includes('Hunter2TopSecret') ? 'YES（第一道未脱敏）' : 'no（第一道已脱敏）'}`);
await main.close();
console.log(out.join('\n'));
