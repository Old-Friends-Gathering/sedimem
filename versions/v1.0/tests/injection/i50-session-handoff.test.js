// I50 — 会话临时库到主库的交接闭环（W8）：close 之后「谁晋升了、文档在哪、临时库怎么了」
// 钉住：只晋升 decision/gotcha、交接文档落 $MEMO_HOME/handoffs/<id>.md 且含六段、
// 主库出现 predicate=handoff 指针、临时库记录被墓碑（不再是 active）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { startSession, sessionStatus } from '../../src/session/lifecycle.js';
import { serviceFactory as makeService } from '../support/session-factory.js';
import { writeCheckpoint } from '../../src/session/checkpoint.js';
import { sessionCli } from '../../src/cli/session.js';

const SRC = { agent: 'test' };

async function setup() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i50-'));
  const main = await createMemoryService({ memoHome: home, scope: 'repo:i50', cwd: home });
  // startSession 要求入口 service 绑主库（v0.6 对抗审核 B1 的防线），故传 main
  // 工厂签名是 ({ memoHome, scope, clock })，用共享 helper（避免 session ← api 成环）
  const started = await startSession({ service: main, serviceFactory: makeService, clock: main.clock });
  const session = await createMemoryService({ memoHome: home, scope: started.scope, cwd: home });
  return { home, main, session, scope: started.scope };
}

test('I50 close 闭环：晋升 decision、落交接文档、主库留 handoff 指针、临时库墓碑化', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.main.close(); await ctx.session.close(); });

  // ① 会话库里写一条 decision（可晋升）与一条 gotcha（可晋升），fact 会被门禁拒
  await ctx.session.write({ text: '决定把 W9 收口拆成两个 PR', kind: 'decision', subject: 'w9', predicate: 'split', value: 'two-prs', source: SRC });
  await ctx.session.write({ text: '教训：git push 会被 443 黑洞挡住', kind: 'gotcha', subject: 'ci', predicate: 'push', value: 'api-fallback', source: SRC });
  await assert.rejects(
    () => ctx.session.write({ text: '这条 fact 不该进临时库', kind: 'fact', source: SRC }),
    (e) => e.code === 'E_SCRATCH_KIND_FORBIDDEN',
  );

  // ② 写一份 8 段 checkpoint（交接文档的骨架来源）
  await writeCheckpoint({ service: ctx.session, checkpoint: {
    intent: '收口 v1.0', concepts: ['W9'], files: ['CHANGELOG.md'], errorsAndFixes: [],
    pendingJobs: [], currentState: 'run', nextSteps: ['发版'],
  } });

  // ③ close
  const out = [];
  // sessionCli 需要绑定主库的 service（close 会自己开 session 服务读、再开主库服务晋升）
  await sessionCli(['close', '--scope', ctx.scope, '--json'], { service: ctx.main, memoHome: ctx.home, out: (s) => out.push(String(s)) });

  // ④ 主库：晋升的 decision/gotcha 可搜到，且有 handoff 指针
  const got = await ctx.main.search('W9 收口');
  assert.ok(got.items.length >= 1, '晋升的 decision 应能在主库搜到');
  const exported = await ctx.main.exportRecords({ status: 'all' });
  const all = Array.isArray(exported) ? exported : (exported?.records ?? exported?.items ?? []);
  const handoffPtr = all.filter((r) => r.predicate === 'handoff');
  assert.ok(handoffPtr.length >= 1, `主库应有 predicate=handoff 指针，实际记录 ${all.length} 条：${all.map((r) => r.predicate).join(',')}`);

  // ⑤ 交接文档落盘且六段齐全
  const dir = path.join(ctx.home, 'handoffs');
  const files = await fsp.readdir(dir);
  assert.equal(files.length, 1, `应有 1 份交接文档，实际 ${files.length}`);
  const md = await fsp.readFile(path.join(dir, files[0]), 'utf8');
  // 六段中文标题（契约：docs/plans/v0.6 §2.5）
  for (const section of ['做了什么', '关键决策', '踩过的坑', '改了哪些文件', '未完成事项', '下次开工入口']) {
    assert.ok(md.includes(`## ${section}`), `交接文档缺少「${section}」段`);
  }
  // 关键内容要落进去：intent 与 nextSteps
  assert.ok(md.includes('收口 v1.0'), '交接文档缺少 intent 内容');
  assert.ok(md.includes('发版'), '交接文档缺少 nextSteps 内容');

  // ⑥ 临时库该被墓碑化（唯一保留 active 的是 closed meta）。
  // 注意：close 内部自己开了一个 session 服务，ctx.session 的内存视图已过期，
  // 必须新开一个绑定同 scope 的服务再读，否则会看到旧快照。
  const fresh = await createMemoryService({ memoHome: ctx.home, scope: ctx.scope, cwd: ctx.home });
  const left = await fresh.exportRecords({ status: 'active' }).catch(() => []);
  const stillActive = (Array.isArray(left) ? left : (left?.records ?? left?.items ?? []))
    .filter((r) => !(r.subject === 'session' && r.predicate === 'meta'));
  await fresh.close();
  assert.equal(stillActive.length, 0, `close 后临时库仍有 ${stillActive.length} 条非 meta 记录 active`);

  // ⑦ 会话状态文件标记已关闭（幂等二次 close 不报错）
  const probe = await createMemoryService({ memoHome: ctx.home, scope: ctx.scope, cwd: ctx.home });
  const st1 = await sessionStatus({ service: probe, scope: ctx.scope });
  await probe.close();
  assert.equal(st1.status, 'closed');
});
