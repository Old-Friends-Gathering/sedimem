// adv-06: 一致性 — A 进程持有 session service，B（别的进程）close 后，A 的 status 是否陈旧显示 open。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('../../src/', import.meta.url).pathname;
const { createMemoryService } = await import(path.join(root, 'api/service.js'));
const { startSession, sessionStatus } = await import(path.join(root, 'session/lifecycle.js'));
const home = mkdtempSync(path.join(tmpdir(), 'adv06-'));
const out = [];

const main = await createMemoryService({ memoHome: home, scope: 'repo:main' });
const { scope } = await startSession({ service: main, title: 'adv06' });

// A：打开并保持
const a = await createMemoryService({ memoHome: home, scope });
await a.write({ text: 'A 看到的 decision', kind: 'decision', title: 'd', source: { agent: 'adv' } });

// B：另一个 service（模拟另一进程）close
const b = await createMemoryService({ memoHome: home, scope });
const { sessionStatus: ssB } = await import(path.join(root, 'session/lifecycle.js'));
out.push(`B close 前 status: ${ssB({ service: b }).status}`);
// 手工执行与 CLI close 相同的关闭动作（借 CLI 更真实）
const { sessionCli } = await import(path.join(root, 'cli/session.js'));
await sessionCli(['close', '--scope', scope], { service: main, memoHome: home, out: { write() {} } });
await b.close();

// A：不刷新直接看 status
const stA = sessionStatus({ service: a });
out.push(`B close 后 A 的 status（不刷新）: ${stA.status} facts=${stA.facts}${stA.status === 'open' ? ' ← 陈旧（A 仍认为 open）' : ''}`);
// A 直接基于陈旧状态再写一条
const w = await a.write({ text: 'A 在已 close 的 session 又写了一条', kind: 'decision', title: '僵尸', source: { agent: 'adv' } });
out.push(`A close 后写入: action=${w.action}`);
await a.close(); await main.close();
console.log(out.join('\n'));
