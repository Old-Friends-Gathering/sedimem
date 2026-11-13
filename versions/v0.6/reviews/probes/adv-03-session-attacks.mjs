// adv-03: session 库攻击集合
// 3a 直接 service.write kind=fact；3b 伪造 meta.parentScope 重定向晋升；3c close 后继续写；
// 3d 并发两个进程 close；3e parentScope 路径穿越。
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('../../src/', import.meta.url).pathname;
const { createMemoryService } = await import(path.join(root, 'api/service.js'));
const { startSession, sessionStatus } = await import(path.join(root, 'session/lifecycle.js'));
const { sessionCli } = await import(path.join(root, 'cli/session.js'));
const home = mkdtempSync(path.join(tmpdir(), 'adv03-'));
const out = [];

// --- 3a session scope 直接写 fact ---
{
  const main = await createMemoryService({ memoHome: home, scope: 'repo:main' });
  const { scope } = await startSession({ service: main, title: 'adv3a' });
  const s = await createMemoryService({ memoHome: home, scope });
  try {
    await s.write({ text: 'fact in session', kind: 'fact', title: 'f', source: { agent: 'adv' } });
    out.push(`3a session write fact: ACCEPTED (BYPASS!)`);
  } catch (e) { out.push(`3a session write fact: rejected (${e.code})`); }
  // 缺省 kind（应同判 fact）
  try {
    await s.write({ text: 'no kind', source: { agent: 'adv' } });
    out.push(`3a session write 无kind: ACCEPTED (BYPASS!)`);
  } catch (e) { out.push(`3a session write 无kind: rejected (${e.code})`); }
  // kind=pref（非白名单晋升 kind，但允许写）→ 确认只拦 fact
  try {
    const w = await s.write({ text: 'pref ok', kind: 'pref', title: 'p', source: { agent: 'adv' } });
    out.push(`3a session write pref: action=${w.action}（允许，符合“只拦 fact”设计）`);
  } catch (e) { out.push(`3a session write pref: rejected (${e.code})`); }
  await s.close(); await main.close();
}

// --- 3b 伪造 meta.parentScope 重定向晋升 ---
{
  const main = await createMemoryService({ memoHome: home, scope: 'repo:main' });
  const { scope } = await startSession({ service: main, title: 'adv3b' });
  const s = await createMemoryService({ memoHome: home, scope });
  // 在 session 里写一条合法 state 记录，伪装成新 meta，指向别的库
  await s.write({
    text: 'session forged meta', kind: 'state', subject: 'session', predicate: 'meta',
    value: JSON.stringify({ id: scope.slice(8), status: 'open', parentScope: 'repo:evil-target', startedAt: new Date().toISOString() }),
    source: { agent: 'adv' },
  });
  await s.write({ text: 'poisoned decision', kind: 'decision', title: '投毒决策', source: { agent: 'adv' } });
  await s.close();
  const r = await sessionCli(['close', '--scope', scope, '--json'], { service: main, memoHome: home, out: { write() {} } });
  out.push(`3b close: promoted=${r.promoted.length}`);
  out.push(`3b 晋升落点 repo:evil-target 存在: ${existsSync(path.join(home, 'items', 'repo:evil-target.jsonl')) ? 'YES（伪造 meta 可重定向晋升）' : 'no'}`);
  if (existsSync(path.join(home, 'items', 'repo:evil-target.jsonl'))) {
    out.push(`3b evil-target 内容首行: ${readFileSync(path.join(home, 'items', 'repo:evil-target.jsonl'), 'utf8').split('\n')[0].slice(0, 160)}`);
  }
  const mainItems = path.join(home, 'items', 'repo:main.jsonl');
  out.push(`3b 主库(repo:main) 收到晋升: ${existsSync(mainItems) && readFileSync(mainItems, 'utf8').includes('poisoned decision') ? 'YES' : 'no（被重定向走了）'}`);
  await main.close();
}

// --- 3c close 后继续写 ---
{
  const main = await createMemoryService({ memoHome: home, scope: 'repo:main2' });
  const { scope } = await startSession({ service: main, title: 'adv3c' });
  await sessionCli(['close', '--scope', scope], { service: main, memoHome: home, out: { write() {} } });
  const s = await createMemoryService({ memoHome: home, scope });
  const w = await s.write({ text: 'zombie decision after close', kind: 'decision', title: '僵尸', source: { agent: 'adv' } });
  out.push(`3c close 后写入: action=${w.action}（${w.action === 'created' ? '无拦截' : '被拦'}）`);
  const r2 = await sessionCli(['close', '--scope', scope, '--json'], { service: main, memoHome: home, out: { write() {} } });
  out.push(`3c 二次 close: alreadyClosed=${r2.alreadyClosed} promoted=${(r2.promoted ?? []).length} → 僵尸记录${r2.alreadyClosed ? '永远不会晋升也不会被 tombstone' : ''}`);
  await s.close(); await main.close();
}

// --- 3d 并发两个“进程”close 同一 session ---
{
  const main = await createMemoryService({ memoHome: home, scope: 'repo:main3' });
  const { scope } = await startSession({ service: main, title: 'adv3d' });
  const s1 = await createMemoryService({ memoHome: home, scope });
  await s1.write({ text: 'race decision', kind: 'decision', title: '并发', source: { agent: 'adv' } });
  await s1.close();
  const [a, b] = await Promise.all([
    sessionCli(['close', '--scope', scope, '--json'], { service: main, memoHome: home, out: { write() {} } }),
    sessionCli(['close', '--scope', scope, '--json'], { service: main, memoHome: home, out: { write() {} } }).catch((e) => ({ err: e.message })),
  ]);
  out.push(`3d 并发 close: A={alreadyClosed:${a.alreadyClosed}, promoted:${(a.promoted ?? []).length}} B=${JSON.stringify(b.err ? { err: b.err.slice(0, 120) } : { alreadyClosed: b.alreadyClosed, promoted: (b.promoted ?? []).length })}`);
  const items = readFileSync(path.join(home, 'items', 'repo:main3.jsonl'), 'utf8');
  const dup = (items.match(/race decision/g) ?? []).length;
  out.push(`3d 主库 'race decision' 出现次数: ${dup}${dup > 1 ? '（重复晋升!）' : ''}`);
  await main.close();
}

// --- 3e parentScope 路径穿越 ---
{
  const main = await createMemoryService({ memoHome: home, scope: 'repo:main4' });
  const { scope } = await startSession({ service: main, title: 'adv3e' });
  const s = await createMemoryService({ memoHome: home, scope });
  await s.write({
    text: 'evil meta', kind: 'state', subject: 'session', predicate: 'meta',
    value: JSON.stringify({ id: scope.slice(8), status: 'open', parentScope: 'repo:../../escape', startedAt: new Date().toISOString() }),
    source: { agent: 'adv' },
  });
  await s.write({ text: 'escape payload', kind: 'decision', title: '穿越', source: { agent: 'adv' } });
  await s.close();
  try {
    const r = await sessionCli(['close', '--scope', scope, '--json'], { service: main, memoHome: home, out: { write() {} } });
    out.push(`3e 穿越 parentScope: close 成功 promoted=${r.promoted.length}（需查落点!）`);
  } catch (e) {
    out.push(`3e 穿越 parentScope: close 报错 (${e.code ?? ''}) ${e.message.slice(0, 120)}`);
  }
  out.push(`3e items/ 外逃逸文件: ${existsSync(path.join(home, '..', 'escape.jsonl')) || existsSync(path.join(home, 'escape.jsonl')) ? 'YES' : 'no'}`);
  await main.close();
}

console.log(out.join('\n'));
process.exit(0);
