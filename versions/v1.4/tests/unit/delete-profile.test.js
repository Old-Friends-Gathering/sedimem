// B3：按来源删除 / verify-delete / profile 路径收敛（P0b）
// 契约：docs/02-data-model-and-contract.md §3.24、I-10、I-12
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { createMemoryService } from '../../src/api/service.js';
import {
  itemsFileName, briefFileName, scopeKeyOf, resolveMemoHome,
} from '../../src/config/paths.js';

const A = 'repo:del-a';
const B = 'repo:del-b';

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    return typeof require('node:sqlite').DatabaseSync === 'function';
  } catch {
    return false;
  }
})();

async function fresh(scopes = [A]) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-del-'));
  const services = {};
  for (const scope of scopes) {
    services[scope] = await createMemoryService({ memoHome, scope });
  }
  const close = async () => {
    for (const svc of Object.values(services)) await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  };
  return { memoHome, services, close };
}

const W = (over = {}) => ({
  text: '导入的远程内容 6379',
  kind: 'fact',
  subject: 'import.port',
  predicate: 'port',
  value: '6379',
  source: { agent: 'importer' },
  ...over,
});

function latestRows(memoHome, scope) {
  const file = join(memoHome, 'items', itemsFileName(scope));
  if (!existsSync(file)) return [];
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const latest = new Map();
  for (const r of rows) latest.set(r.id, r);
  return [...latest.values()];
}

describe('B3 deleteBySource：按来源写墓碑，不物理删真相层', () => {
  test('按 source.agent 删除只命中该来源，历史行保留，派生索引同步', async () => {
    const { memoHome, services, close } = await fresh();
    const svc = services[A];
    try {
      const imported = await svc.write(W({ text: '导入内容一', subject: 's.one' }));
      const mine = await svc.write(W({ text: '本地记录', subject: 's.two', source: { agent: 'cli' } }));
      const before = readFileSync(join(memoHome, 'items', itemsFileName(A)), 'utf8').trim().split('\n').length;

      const out = await svc.deleteBySource({ agent: 'importer', reason: '撤回授权' });
      assert.deepEqual(out.tombstoned, [imported.record.id]);
      assert.equal(out.scopes.length, 1);

      const rows = latestRows(memoHome, A);
      const imp = rows.find((r) => r.id === imported.record.id);
      assert.equal(imp.status, 'tombstoned');
      assert.ok(imp.tags.includes('source-deleted'));
      assert.equal(rows.find((r) => r.id === mine.record.id).status, 'active');
      // append-only：多了一行墓碑，但没有物理删掉任何历史行
      const after = readFileSync(join(memoHome, 'items', itemsFileName(A)), 'utf8').trim().split('\n').length;
      assert.equal(after, before + 1);
      // 搜索视图不再返回被删记录
      const found = await svc.search('导入内容一', { limit: 10 });
      assert.equal(found.items.some((i) => i.record.id === imported.record.id), false);
    } finally {
      await close();
    }
  });

  test('按 source.session 删除，跨分库一起墓碑', async () => {
    const { memoHome, services, close } = await fresh([A, B]);
    try {
      await services[A].write(W({ text: '任务 T1 的 A 库记忆', subject: 's.a1', source: { agent: 'dsh', session: 'T1' } }));
      await services[B].write(W({ text: '任务 T1 的 B 库记忆', subject: 's.b1', source: { agent: 'dsh', session: 'T1' } }));
      const keep = await services[B].write(W({ text: '任务 T2 的记忆', subject: 's.b2', source: { agent: 'dsh', session: 'T2' } }));

      const out = await services[A].deleteBySource({ session: 'T1' });
      assert.equal(out.tombstoned.length, 2);
      assert.deepEqual(out.scopes.sort(), [A, B].sort());
      for (const scope of [A, B]) {
        for (const r of latestRows(memoHome, scope)) {
          if (r.source?.session === 'T1') assert.equal(r.status, 'tombstoned');
        }
      }
      assert.equal(latestRows(memoHome, B).find((r) => r.id === keep.record.id).status, 'active');
    } finally {
      await close();
    }
  });

  test('删除任务账本 sessions/<taskId>/segments.jsonl，不误删其它任务', async () => {
    const { memoHome, services, close } = await fresh();
    try {
      const rec = await services[A].write(W({ text: '带账本的来源', subject: 's.ledger', source: { agent: 'dsh', session: 'T1' } }));
      const seg = (taskId) => JSON.stringify({
        id: `seg-${taskId}`, taskId, fromSeq: 0, toSeq: 1, createdAt: new Date().toISOString(),
        source: { kind: 'dsh', sessionId: taskId, agent: 'dsh' }, summary: 'capture segment',
        trust: 'T1', taint: [],
      });
      for (const taskId of ['T1', 'T2']) {
        mkdirSync(join(memoHome, 'sessions', taskId), { recursive: true });
        writeFileSync(join(memoHome, 'sessions', taskId, 'segments.jsonl'), `${seg(taskId)}\n`);
      }

      const out = await services[A].deleteBySource({ session: 'T1' });
      assert.ok(out.taskIds.includes('T1'));
      assert.equal(existsSync(join(memoHome, 'sessions', 'T1')), false);
      assert.equal(existsSync(join(memoHome, 'sessions', 'T2', 'segments.jsonl')), true);
      const verify = await services[A].verifyDelete({ session: 'T1' });
      assert.equal(verify.ok, true);
      // 被删记录已无 live 行
      assert.equal(latestRows(memoHome, A).find((r) => r.id === rec.record.id).status, 'tombstoned');
    } finally {
      await close();
    }
  });

  test('内容哈希选择器 + dry-run 不落盘', async () => {
    const { memoHome, services, close } = await fresh();
    try {
      const r = await services[A].write(W({ text: '按哈希删除的内容', subject: 's.hash', source: { agent: 'importer', session: 'T3' } }));
      mkdirSync(join(memoHome, 'sessions', 'T3'), { recursive: true });
      writeFileSync(join(memoHome, 'sessions', 'T3', 'segments.jsonl'), JSON.stringify({
        id: 'seg-T3', taskId: 'T3', fromSeq: 0, toSeq: 1, createdAt: new Date().toISOString(),
        source: { kind: 'dsh', sessionId: 'T3', agent: 'dsh' }, summary: 'cell', trust: 'T1', taint: [],
      }) + '\n');
      const dry = await services[A].deleteBySource({ contentHash: r.record.contentHash, dryRun: true });
      assert.equal(dry.dryRun, true);
      assert.deepEqual(dry.tombstoned, [r.record.id]);
      assert.ok(dry.taskIds.includes('T3'), 'dry-run 也要预览将删除的任务账本');
      assert.equal(existsSync(join(memoHome, 'sessions', 'T3', 'segments.jsonl')), true);
      assert.equal(latestRows(memoHome, A).find((x) => x.id === r.record.id).status, 'active');

      const out = await services[A].deleteBySource({ contentHash: r.record.contentHash });
      assert.deepEqual(out.tombstoned, [r.record.id]);
      // 记录自带的 source.session 也是 taskId：即使只按哈希删，账本也不能留
      assert.ok(out.taskIds.includes('T3'));
      assert.equal(existsSync(join(memoHome, 'sessions', 'T3')), false);
      assert.equal((await services[A].verifyDelete({ contentHash: r.record.contentHash })).ok, true);
    } finally {
      await close();
    }
  });
});

describe('B3 verify-delete：残留必须非零退出可判定', () => {
  test('删除后通过；items 里重新出现 live 记录时列出残留', async () => {
    const { memoHome, services, close } = await fresh();
    try {
      const r = await services[A].write(W({ text: '待验证删除的内容', subject: 's.verify' }));
      await services[A].deleteBySource({ agent: 'importer' });
      assert.equal((await services[A].verifyDelete({ agent: 'importer' })).ok, true);

      // 模拟「没删干净」：往真相层追加一条同来源的 live 记录
      const live = { ...r.record, id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', v: 1, status: 'active', validTo: null };
      writeFileSync(join(memoHome, 'items', itemsFileName(A)), `${JSON.stringify(live)}\n`, { flag: 'a' });
      const bad = await services[A].verifyDelete({ agent: 'importer' });
      assert.equal(bad.ok, false);
      assert.ok(bad.residue.some((x) => x.where.startsWith('items/') && x.id === live.id));
    } finally {
      await close();
    }
  });

  test('brief / index 残留也会被列出', async () => {
    const { memoHome, services, close } = await fresh();
    try {
      const r = await services[A].write(W({ text: '会泄漏到派生物的文本', subject: 's.derived' }));
      await services[A].deleteBySource({ agent: 'importer' });

      mkdirSync(join(memoHome, 'brief'), { recursive: true });
      writeFileSync(join(memoHome, 'brief', briefFileName(A)), `- 会泄漏到派生物的文本\n`);
      mkdirSync(join(memoHome, 'index'), { recursive: true });
      writeFileSync(join(memoHome, 'index', `${scopeKeyOf(A)}.sqlite`), Buffer.from(r.record.id));

      const bad = await services[A].verifyDelete({ agent: 'importer' });
      assert.equal(bad.ok, false);
      assert.ok(bad.residue.some((x) => x.where.startsWith('brief/')));
      assert.ok(bad.residue.some((x) => x.where.startsWith('index/')));
    } finally {
      await close();
    }
  });
});

describe('B3 verify-delete：sqlite 后端按查询判定，不按 WAL 字节误报', () => {
  test('sqlite index 删除后用 SQL 查不到，verify-delete 通过', { skip: !HAS_SQLITE }, async () => {
    process.env.MEMO_QUIET = '1';
    const memoHome = mkdtempSync(join(tmpdir(), 'memo-del-sql-'));
    const svc = await createMemoryService({
      memoHome, scope: 'repo:del-sql', policy: { index: { backend: 'sqlite' } },
    });
    try {
      for (let i = 0; i < 12; i++) {
        await svc.write(W({
          text: `sqlite 导入内容 ${i} unique`, subject: `s.sql.${i}`, source: { agent: 'importer' },
        }));
      }
      const out = await svc.deleteBySource({ agent: 'importer' });
      assert.equal(out.tombstoned.length, 12);
      const ver = await svc.verifyDelete({ agent: 'importer' });
      assert.deepEqual(ver.residue, []);
      assert.equal(ver.ok, true);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});

describe('B3 profile：默认路径不变，命名 profile 互不可见', () => {
  test('默认 profile 仍是 ~/.memo（MEMO_HOME 时仍是 MEMO_HOME）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'memo-home-'));
    try {
      assert.equal(resolveMemoHome({ MEMO_HOME: tmp }, tmp), tmp);
      assert.equal(resolveMemoHome({}, process.cwd()), join(homedir(), '.memo'));
      assert.equal(resolveMemoHome({ MEMO_PROFILE: '' }, process.cwd()), join(homedir(), '.memo'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('命名 profile 解析到 <base>/profiles/<name>，两个 profile 的记录互不可见', async () => {
    const base = mkdtempSync(join(tmpdir(), 'memo-profile-'));
    try {
      mkdirSync(join(base, 'profiles', 'work'), { recursive: true });
      mkdirSync(join(base, 'profiles', 'personal'), { recursive: true });
      writeFileSync(join(base, 'profiles.json'), JSON.stringify({
        version: 1,
        profiles: { work: { path: 'profiles/work' }, personal: { path: 'profiles/personal' } },
      }));
      const envWork = { MEMO_HOME: base, MEMO_PROFILE: 'work' };
      const envPersonal = { MEMO_HOME: base, MEMO_PROFILE: 'personal' };
      assert.equal(resolveMemoHome(envWork), join(base, 'profiles', 'work'));
      assert.equal(resolveMemoHome(envPersonal), join(base, 'profiles', 'personal'));

      const work = await createMemoryService({ memoHome: resolveMemoHome(envWork), scope: 'repo:p' });
      const personal = await createMemoryService({ memoHome: resolveMemoHome(envPersonal), scope: 'repo:p' });
      try {
        await work.write(W({ text: 'work profile 的记忆', subject: 's.p', source: { agent: 'cli' } }));
        assert.equal((await personal.search('work profile', { limit: 10 })).items.length, 0);
        assert.equal((await personal.exportRecords()).total, 0);
      } finally {
        await work.close();
        await personal.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('指针缺失 / 未注册 / 越界时 fail-closed', () => {
    const base = mkdtempSync(join(tmpdir(), 'memo-profile-'));
    try {
      const env = { MEMO_HOME: base, MEMO_PROFILE: 'work' };
      assert.throws(() => resolveMemoHome(env), (e) => e.code === 'E_PROFILE_UNAVAILABLE');
      writeFileSync(join(base, 'profiles.json'), JSON.stringify({ version: 1, profiles: {} }));
      assert.throws(() => resolveMemoHome(env), (e) => e.code === 'E_PROFILE_UNAVAILABLE');
      assert.throws(() => resolveMemoHome({ ...env, MEMO_PROFILE: '../etc' }), (e) => e.code === 'E_PROFILE_UNAVAILABLE');
      writeFileSync(join(base, 'profiles.json'), JSON.stringify({
        version: 1, profiles: { work: { path: '../escape' } },
      }));
      assert.throws(() => resolveMemoHome(env), (e) => e.code === 'E_PROFILE_UNAVAILABLE');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
