// arch 探针 2：session-in-session 链。MCP memory_session_start 在当前 scope 已是 session 时
// 会 reuse，meta.parentScope = session:xxx；MCP close 的 mainScopeFor 不校验 parentScope 是否 session。
// 模拟 CLI 侧 startSession reuse 分支（与 server.js 同一入口 startSession）：
const { createMemoryService } = await import('../../src/api/service.js');
const { startSession, writeCheckpoint } = await import('../../src/session/lifecycle.js').then(m => m);
import { writeCheckpoint as wc } from '../../src/session/checkpoint.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'sedimem-arch2-'));
try {
  // 步骤 1：正常 start 一个 session（service 绑主库）
  const main = await createMemoryService({ memoHome: home, scope: 'dir:arch2' });
  const s1 = await startSession({ service: main, title: 'outer' });
  console.log('[1] outer session scope =', s1.scope, 'parentScope =', s1.parentScope);

  // 步骤 2：再拿一个绑定 session scope 的 service 调 startSession —— 模拟 MCP 里
  // state.scope 已是 session（用户先 memory_scope use session:xxx 或连续两次 start）时的行为
  const svcOnSession = await createMemoryService({ memoHome: home, scope: s1.scope });
  const s2 = await startSession({ service: svcOnSession, title: 'inner' });
  console.log('[2] inner session scope =', s2.scope, 'parentScope =', s2.parentScope);
  console.log('    parentScope 是 session scope?', String(s2.parentScope).startsWith('session:'));

  // 步骤 3：往 inner 写 decision，然后按 MCP close 逻辑（mainScopeFor 不校验）晋升 ——
  // main = getService(parentScope) 即 inner 自己
  const rec = await svcOnSession.write({
    text: '关键决策：选方案 B', kind: 'decision', title: '选方案B', source: { agent: 'test' },
  });
  console.log('[3] inner 写 decision ok id=', rec.record.id);

  // MCP close 晋升目标 = meta.parentScope（inner 自己），main===svc：
  // 写回自己 → 随后 tombstone 循环把非 meta 的 active 全 forget（含刚晋升的）
  const status = (await import('../../src/session/lifecycle.js')).sessionStatus({ service: svcOnSession });
  const mainScope = status.meta.parentScope; // MCP mainScopeFor 直接返回它，无 isSessionScope 校验
  console.log('[4] MCP close 将晋升到 mainScope =', mainScope, '（=== 自身 scope?', mainScope === svcOnSession.scope, '）');
  // 复刻 closeSessionTool ④ 的 tombstone 循环（若 main===svc）
  if (mainScope === svcOnSession.scope) {
    await svcOnSession.write({
      text: `session inner 关闭`, kind: 'state', subject: 'session', predicate: 'meta',
      value: JSON.stringify({ ...status.meta, status: 'closed' }), source: { agent: 'cli' },
    });
    let forgotten = [];
    for (const r of svcOnSession._records.values()) {
      if (r.status !== 'active') continue;
      if (r.subject === 'session' && r.predicate === 'meta') continue;
      await svcOnSession.forget({ id: r.id, reason: 'session-closed' });
      forgotten.push(`${r.kind}:${r.title ?? r.text.slice(0, 12)}`);
    }
    console.log('[5] tombstone 后被丢弃的记录（含刚「晋升」的 decision）:', JSON.stringify(forgotten));
    const left = [...svcOnSession._records.values()].filter((r) => r.status === 'active');
    console.log('[6] inner 库剩余 active:', left.length, '→ decision 是否存活:', left.some((r) => r.kind === 'decision'));
  }
  await svcOnSession.close(); await main.close();
} finally { rmSync(home, { recursive: true, force: true }); }
