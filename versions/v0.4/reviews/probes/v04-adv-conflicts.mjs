// v0.4 对抗审核探针：disputed 一等公民 / resolve / curateApply
//   1) 无结构化 slot（subject=predicate=text）把所有未结构化记忆并成一个冲突槽：
//      resolve 一条会把同槽其它无关记忆全部 superseded（数据丢失）
//   2) curateApply keep_both 复活墓碑（tombstoned → active）
//   3) curateApply a_wins 把墓碑 winner 复活、把墓碑 loser 降为 superseded（删除语义丢失）
//   4) keep_both 幂等：第二次 applied:false
//   5) 并发 resolve 同一槽：两边都可能 applied:true（重复事件），最终状态是否一致
// 运行：node reviews/probes/v04-adv-conflicts.mjs
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createMemoryService } from '../../src/api/service.js';
import { createRecord } from '../../src/core/record.js';
import { listConflicts, resolveConflicts } from '../../src/views/conflicts.js';

const out = {};
const tmp = () => mkdtemp(path.join(tmpdir(), 'sedimem-adv-conf-'));
const iso = (s) => new Date(s).toISOString();

async function seed(scope, records) {
  const memoHome = await tmp();
  const rows = records.map((r) => createRecord({
    scope,
    subject: 'text',
    predicate: 'text',
    source: { agent: 'probe' },
    createdAt: '2026-01-01T00:00:00.000Z',
    validFrom: '2026-01-01T00:00:00.000Z',
    ...r,
  }));
  await mkdir(path.join(memoHome, 'items'), { recursive: true });
  await writeFile(path.join(memoHome, 'items', `${scope}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const svc = await createMemoryService({ memoHome, scope });
  return { svc, ids: rows.map((r) => r.id) };
}

// —— 1) 未结构化槽的爆炸半径 ——
{
  const scope = 'repo:conf';
  const { svc, ids } = await seed(scope, [
    { text: 'postgres 端口是 5432' },
    { text: 'mysql 端口是 3306' },
    { text: 'redis 端口是 6379' },
  ]);
  const listBefore = await listConflicts({ service: svc });
  const slot = listBefore.slots[0];
  const res = await resolveConflicts({ service: svc, slot: slot.key, winnerId: ids[0], note: 'probe' });
  const after = ids.map((id) => ({ id, status: svc._records.get(id).status, text: svc._records.get(id).text }));
  const searchAfter = await svc.search('mysql 端口');
  const replay = await resolveConflicts({ service: svc, slot: slot.key, winnerId: ids[0], note: 'replay' });
  out.unstructuredBlastRadius = {
    replay,
    slotKey: JSON.stringify(slot.key),
    slotRecordCount: slot.records.length,
    pairs: slot.pairs.map((p) => ({ a: p.aId, b: p.bId, sim: p.similarity })),
    resolveResult: res,
    statusesAfter: after,
    mysqlStillSearchable: searchAfter.items.some((i) => i.record.id === ids[1]),
  };
  await svc.close();
}

// —— 2) keep_both 复活墓碑 ——
{
  const scope = 'repo:revive';
  const { svc, ids } = await seed(scope, [
    { text: '已删除的旧密码位置', status: 'tombstoned', validTo: '2026-02-01T00:00:00.000Z', tags: ['purge'] },
    { text: '仍然有效的配置', status: 'active' },
  ]);
  const before = ids.map((id) => svc._records.get(id).status);
  const res = await svc.curateApply({ decisions: [{ ids, decision: 'keep_both', note: 'probe' }] });
  const after = ids.map((id) => ({ status: svc._records.get(id).status, validTo: svc._records.get(id).validTo, tags: svc._records.get(id).tags }));
  const res2 = await svc.curateApply({ decisions: [{ ids, decision: 'keep_both', note: 'probe' }] });
  out.keepBothResurrects = { before, first: res, after, secondApplied: res2.applied?.[0]?.applied, secondTags: svc._records.get(ids[0]).tags };
  await svc.close();
}

// —— 3) a_wins 对墓碑 winner / loser ——
{
  const scope = 'repo:tombwin';
  const { svc, ids } = await seed(scope, [
    { text: '墓碑记录 A', status: 'tombstoned', validTo: '2026-02-01T00:00:00.000Z' },
    { text: '活跃记录 B', status: 'active' },
  ]);
  const res = await svc.curateApply({ decisions: [{ ids, decision: 'a_wins', note: 'probe' }] });
  out.aWinsTombstoneWinner = {
    result: res,
    after: ids.map((id) => ({ id, status: svc._records.get(id).status, validTo: svc._records.get(id).validTo })),
  };
  await svc.close();

  const scope2 = 'repo:tomblose';
  const s2 = await seed(scope2, [
    { text: '活跃记录 C', status: 'active' },
    { text: '墓碑记录 D', status: 'tombstoned', validTo: '2026-02-01T00:00:00.000Z' },
  ]);
  const res2 = await s2.svc.curateApply({ decisions: [{ ids: s2.ids, decision: 'a_wins', note: 'probe' }] });
  out.aWinsTombstoneLoser = {
    result: res2,
    after: s2.ids.map((id) => ({ id, status: s2.svc._records.get(id).status, validTo: s2.svc._records.get(id).validTo })),
  };
  await s2.svc.close();
}

// —— 4) 并发 resolve 同一槽 ——
{
  const scope = 'repo:concurrent';
  const { svc, ids } = await seed(scope, [
    { text: '并发 resolve 记录 A' },
    { text: '并发 resolve 记录 B' },
  ]);
  const list = await listConflicts({ service: svc });
  const slot = list.slots[0].key;
  const [r1, r2] = await Promise.all([
    resolveConflicts({ service: svc, slot, winnerId: ids[0], note: 'p1' }),
    resolveConflicts({ service: svc, slot, winnerId: ids[0], note: 'p2' }),
  ]);
  const events = await svc.store.readEvents();
  out.concurrentResolve = {
    r1, r2,
    curateApplyEvents: events.filter((e) => e.op === 'curate_apply').length,
    after: ids.map((id) => ({ id, status: svc._records.get(id).status })),
  };
  await svc.close();
}

// —— 5) 墓碑 winner 被 resolve 拒绝 ——
{
  const scope = 'repo:rejecttomb';
  const { svc, ids } = await seed(scope, [
    { text: '墓碑 winner', status: 'tombstoned', validTo: '2026-02-01T00:00:00.000Z' },
    { text: '活跃 loser', status: 'active' },
  ]);
  let err = null;
  try { await resolveConflicts({ service: svc, slot: '\u0000unstructured', winnerId: ids[0] }); } catch (e) { err = `${e.code}: ${e.message}`; }
  out.tombstoneWinnerRejected = { err, statuses: ids.map((id) => svc._records.get(id).status) };
  await svc.close();
}

console.log(JSON.stringify(out, null, 2));
