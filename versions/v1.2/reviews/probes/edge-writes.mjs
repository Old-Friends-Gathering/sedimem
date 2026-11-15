// probes/edge-writes.mjs — 撕裂写入 / 伪造身份 / 时间攻击（对抗审核）
import { createMemoryService } from '../../src/api/service.js';
import fsp from 'node:fs/promises';

const home = process.argv[2] ?? '/tmp/memo-edge';
const s = await createMemoryService({ memoHome: home, scope: 'repo:edge' });

// --- 2) 撕裂写入 ---
const nasty = [
  ['newline', 'line1\nline2\nline3'],
  ['nul', 'before\u0000after'],
  ['emoji', '🦀🎉 中文 emoji 𝕊𝕡𝕒𝕔𝕖'],
  ['10k', 'x'.repeat(10000)],
  ['crlf', 'a\r\nb'],
  ['sep', 'a\u2028b\u2029c'],
];
for (const [name, text] of nasty) {
  try {
    const r = await s.write({ text, subject: 'edge', predicate: name, source: { agent: 'test' } });
    console.log(`torn[${name}] -> ${r.action} text.len=${r.record.text.length}`);
  } catch (e) { console.log(`torn[${name}] -> THROW ${e.code}: ${e.message.slice(0,80)}`); }
}
// 超长 subject
try {
  const r = await s.write({ text: 'long subject test', subject: 's'.repeat(100000), predicate: 'p', source: { agent: 'test' } });
  console.log('torn[subject100k] ->', r.action);
} catch (e) { console.log('torn[subject100k] -> THROW', e.code); }

// 文件完整性
const raw = await fsp.readFile(home + '/items/repo:edge.jsonl', 'utf8');
const lines = raw.split('\n').filter(l => l.trim());
let bad = 0;
for (const l of lines) { try { JSON.parse(l); } catch { bad++; } }
console.log(`jsonl: lines=${lines.length} badLines=${bad}`);

// 检索含 NUL 的记录
const res = await s.search('before after');
console.log('search nul record:', res.items.map(i => i.record.predicate));

// --- 3) 伪造身份 ---
for (const agent of [undefined, 'root', 'system', '', 42, 'DSH']) {
  try {
    const input = { text: 'identity probe ' + String(agent), subject: 'id', predicate: String(agent ?? 'undef'), source: {} };
    if (agent !== undefined) input.source = { agent };
    const r = await s.write(input);
    console.log(`identity[${String(agent)}] -> ACCEPTED agent=${r.record.source.agent}`);
  } catch (e) { console.log(`identity[${String(agent)}] -> REJECTED ${e.code}`); }
}

// --- 4) 时间攻击 ---
const { createRecord, validateRecord } = await import('../../src/core/record.js');
// 直接构造 validTo < validFrom
try {
  const badRec = createRecord({ text: 'time attack', subject: 't', predicate: 't', source: { agent: 'test' }, validFrom: '2026-11-02T00:00:00.000Z', validTo: '2026-11-01T00:00:00.000Z', status: 'superseded' });
  console.log('validTo<validFrom createRecord -> NO THROW, validate ok:', JSON.stringify(validateRecord(badRec).ok));
} catch (e) { console.log('validTo<validFrom createRecord -> THROW', e.code); }
// asOf 攻击
for (const asOf of ['2999-01-01T00:00:00Z', '1970-01-01T00:00:00Z', 'not-a-date', '2026-11-02T13:00:00+08:00', '2026/11/02', '']) {
  try {
    const r = await s.search('edge', { asOf });
    console.log(`asOf[${asOf}] -> ok total=${r.total}`);
  } catch (e) { console.log(`asOf[${asOf}] -> THROW ${e.code}`); }
}
await s.close();
