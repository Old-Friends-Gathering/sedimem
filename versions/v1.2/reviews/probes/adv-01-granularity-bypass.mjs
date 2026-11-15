// adv-01: 粒度契约绕过 — 各入口写 5000 字。text 面已被 createRecord 硬拦，重点测 value 面。
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('../../src/', import.meta.url).pathname;
const { createMemoryService } = await import(path.join(root, 'api/service.js'));
const home = mkdtempSync(path.join(tmpdir(), 'adv01-'));

const svc = await createMemoryService({ memoHome: home, scope: 'repo:adv01' });
const big = 'A'.repeat(5000);
const out = [];

// 1) memory_write 等价：text 超限
try { await svc.write({ text: big, source: { agent: 'adv' } }); out.push('write text5000: ACCEPTED (BYPASS!)'); }
catch (e) { out.push(`write text5000: rejected (${e.code})`); }

// 2) memory_write 等价：text 短、value 5000 字（W1 只对 text 硬拦）
const r2 = await svc.write({ text: 'short text', value: big, kind: 'fact', title: 'value面', source: { agent: 'adv' } });
const rec2 = r2.record;
out.push(`write value5000: action=${r2.action} warnings=${JSON.stringify((r2.warnings??[]).map(w=>w.code))} valueLen=${rec2.value.length}`);

// 3) supersede（MCP memory_supersede / CLI memo supersede 同路径）：value 5000
const r3 = await svc.supersede({ oldId: rec2.id, value: 'B'.repeat(5000), text: 'sup body', source: { agent: 'adv' } });
out.push(`supersede value5000: ok newValueLen=${r3.record.value.length} warnings=${r3.warnings === undefined ? '(无 warnings 返回)' : JSON.stringify(r3.warnings)}`);

// 4) text=4001 边界
try { await svc.write({ text: 'C'.repeat(4001), source: { agent: 'adv' } }); out.push('write text4001: ACCEPTED (BYPASS!)'); }
catch (e) { out.push(`write text4001: rejected (${e.code})`); }

// 5) 落盘验证：真相层里最长 value
const line = readFileSync(path.join(home, 'items', 'repo:adv01.jsonl'), 'utf8').trim().split('\n');
const maxVal = Math.max(...line.map((l) => { const r = JSON.parse(l); return Math.max(r.value?.length ?? 0, r.text?.length ?? 0); }));
out.push(`disk max(value|text) len = ${maxVal}  (hard cap 4000)`);

console.log(out.join('\n'));
await svc.close();
