import { test, describe } from 'node:test';
import { itemsFileName } from '../../src/config/paths.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { QuotaPolicy } from '../../src/hygiene/quota.js';

const SCOPE = 'repo:unit-api';

async function fresh(over = {}) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  const svc = await createMemoryService({ memoHome, scope: SCOPE, ...over });
  return { svc, memoHome };
}

const W = {
  text: '端口是 6379',
  kind: 'fact',
  subject: 'monitor.server',
  predicate: 'port',
  value: '6379',
  source: { agent: 'test' },
};

describe('api/service MemoryService', () => {
  test('write → created，返回 action + record；默认参数齐全', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const res = await svc.write(W);
      assert.equal(res.action, 'created');
      assert.equal(res.record.scope, SCOPE);
      assert.equal(res.record.kind, 'fact');
      assert.match(res.record.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(res.record.status, 'active');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('非法输入抛 E_INVALID_RECORD（缺 source.agent）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await assert.rejects(
        svc.write({ ...W, source: {} }),
        (err) => err instanceof Error && err.code === 'E_INVALID_RECORD',
      );
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('get：存在返回 record，不存在返回 null；forget 不存在 → E_NOT_FOUND', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const w = await svc.write(W);
      const got = await svc.get(w.record.id);
      assert.equal(got.id, w.record.id);
      assert.equal(await svc.get('01ARZ3NDEKTSV4RRFFQ69G5FAVZZZZZ'.slice(0, 26)), null);
      await assert.rejects(
        svc.forget({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAVZZZZZ'.slice(0, 26) }),
        (err) => err instanceof Error && err.code === 'E_NOT_FOUND',
      );
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('forget → tombstone，search 不再返回', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const w = await svc.write(W);
      await svc.forget({ id: w.record.id });
      const s = await svc.search('端口');
      assert.equal(s.items.filter((it) => it.record.id === w.record.id).length, 0);
      const stats = await svc.stats();
      assert.ok(stats.tombstoned >= 1);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('search：limit/kind/status 过滤 + total/asOf 字段', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write(W);
      await svc.write({ text: '偏好默认中文', kind: 'pref', subject: 'user', predicate: 'lang', value: 'zh', source: { agent: 'test' } });
      const s = await svc.search('端口', { limit: 1 });
      assert.ok(Array.isArray(s.items) && s.items.length <= 1);
      assert.equal(typeof s.total, 'number');
      assert.ok(s.asOf, 'search 返回应带 asOf');
      const onlyPref = await svc.search('偏好', { kind: 'pref' });
      assert.ok(onlyPref.items.every((it) => it.record.kind === 'pref'));
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('stats 返回全部计数与指标字段', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write(W);
      const st = await svc.stats();
      for (const k of ['scope', 'total', 'active', 'superseded', 'disputed', 'tombstoned', 'dupRatio', 'conflictRate', 'avgHits']) {
        assert.ok(k in st, `stats 缺字段 ${k}`);
      }
      assert.equal(st.scope, SCOPE);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('reindex 只读真相层：items.jsonl 字节不变，返回 {rebuilt}', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write(W);
      const p = join(memoHome, 'items', itemsFileName(SCOPE));
      const before = statSync(p).size;
      const out = await svc.reindex();
      assert.equal(statSync(p).size, before, 'reindex 不得写 items');
      assert.ok(out && typeof out.rebuilt === 'number');
      // 重建后仍可检索（不复活墓碑由 I4 覆盖）
      const s = await svc.search('端口');
      assert.equal(s.items.length, 1);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('supersede：旧记录 validTo 落地，返回新 record', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const w = await svc.write(W);
      const out = await svc.supersede({ oldId: w.record.id, value: '6380', text: '端口改成 6380', source: { agent: 'test' }, reason: '端口迁移' });
      assert.ok(out.record && out.record.id !== w.record.id);
      assert.equal(out.record.value, '6380');
      // 真相层旧 id 最后一行 validTo 非空
      const lines = readFileSync(join(memoHome, 'items', itemsFileName(SCOPE)), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const old = lines.filter((r) => r.id === w.record.id).pop();
      assert.equal(old.validTo !== null, true, '旧记录必须写 validTo');
      const cur = await svc.search('端口');
      assert.equal(cur.items.filter((it) => it.record.value === '6380').length, 1);
      assert.equal(cur.items.filter((it) => it.record.value === '6379').length, 0);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('doctor：健康库 ok 且无 error；brief 返回字符串；curate 空时返回 null', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const doc = await svc.doctor();
      assert.ok(doc && typeof doc.ok === 'boolean');
      const errors = (doc.issues || []).filter((i) => i.severity === 'error');
      assert.equal(errors.length, 0);
      assert.equal(typeof (await svc.brief()), 'string');
      const batch = await svc.curateExport({ limit: 20 });
      assert.equal(batch, null, '无候选时 curateExport 应返回 null');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('curateExport/curateApply：disputed 对进入批次并可通过 a_wins 裁决', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write({ text: '推荐用 Node 18', subject: 'tc', predicate: 'ver', value: 'v18', source: { agent: 'test' } });
      await svc.write({ text: '推荐用 Node 16', subject: 'tc', predicate: 'ver', value: 'v16', source: { agent: 'test' } });
      const st = await svc.stats();
      assert.ok(st.disputed >= 1, '应有 disputed 待裁决');
      const batch = await svc.curateExport({ limit: 20 });
      assert.ok(batch && batch.batchId, '应导出批次');
      const out = await svc.curateApply({ batchId: batch.batchId, decisions: [{ pairIndex: 0, decision: 'a_wins' }] });
      assert.ok(Array.isArray(out.applied) && out.applied.length >= 1);
      assert.equal(out.applied[0].applied, true);
      const st2 = await svc.stats();
      assert.ok(st2.disputed < st.disputed, '裁决后 disputed 应减少');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('curateApply 不存在的 batchId → E_BATCH_NOT_FOUND', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await assert.rejects(
        // decisions 传真实裁决：src 现先校验 decisions 非空再查 batchId，空数组到不了 E_BATCH_NOT_FOUND 路径
        svc.curateApply({ batchId: 'nope', decisions: [{ pairIndex: 0, decision: 'a_wins' }] }),
        (err) => err instanceof Error && err.code === 'E_BATCH_NOT_FOUND',
      );
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});

// 裁决 20/17/6/21 相关补充
describe('api/service 裁决补充（quota tag / asOf 非法 / hits 落盘）', () => {
  test('enforceQuota 公开方法：超额淘汰的墓碑带 tags:[quota]（nightly 必须走它）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      // 先用宽配额写入 5 条不同事实
      for (let i = 0; i < 5; i++) {
        await svc.write({
          text: `quota 补充事实 ${i} 号：值 v${i}`,
          subject: `quota.sup${i}`, predicate: 'v', value: `v${i}`,
          source: { agent: 'test' },
        });
      }
      assert.equal(typeof svc.enforceQuota, 'function', 'enforceQuota 必须是公开方法（裁决 20：nightly 走它）');
      // 收紧配额后由公开方法触发淘汰（模拟 nightly 场景）
      svc.quota = new QuotaPolicy({ maxActive: 2 });
      await svc.enforceQuota();

      const st = await svc.stats();
      assert.ok(st.active <= 2, `淘汰后 active 应 <=2，实际 ${st.active}`);
      assert.ok(st.tombstoned >= 3, `应产生 >=3 个墓碑，实际 ${st.tombstoned}`);

      // 真相层：被淘汰记录的最后一行必须带 'quota' tag（doctor 的 quota 检测依赖它）
      const lines = readFileSync(join(memoHome, 'items', itemsFileName(SCOPE)), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
      const folded = new Map();
      for (const r of lines) folded.set(r.id, r);
      const tombs = [...folded.values()].filter((r) => r.status === 'tombstoned');
      assert.ok(tombs.length >= 3, '折叠后墓碑数应 >=3');
      for (const t of tombs) {
        assert.ok(
          Array.isArray(t.tags) && t.tags.includes('quota'),
          `被淘汰记录 ${t.id} 必须带 'quota' tag，实际 ${JSON.stringify(t.tags)}`,
        );
      }
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('asOf 非法输入 → E_INVALID_ARG（裁决 17）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write(W);
      await assert.rejects(
        svc.search('端口', { asOf: 'not-a-date' }),
        (err) => err instanceof Error && err.code === 'E_INVALID_ARG',
      );
      await assert.rejects(
        svc.search('端口', { asOf: '' }),
        (err) => err instanceof Error && err.code === 'E_INVALID_ARG',
      );
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('close 后 hits 已落盘：重开服务能读到累计 hits（裁决 6/21）', async () => {
    const { svc, memoHome } = await fresh();
    let id;
    try {
      const w = await svc.write(W);
      id = w.record.id;
      const before = (await svc.get(id)).hits ?? 0;
      await svc.search('端口');   // 命中 1 次 → 内存累加
      await svc.search('端口');   // 再命中 1 次
      const during = (await svc.get(id)).hits ?? 0;
      assert.ok(during >= before + 1, `close 前 get 应反映内存累加 hits（${before} → ${during}）`);
    } finally {
      await svc.close();
    }
    // close() 自动 flushHits()：新进程重开同一 memoHome，hits 必须已作为快照落盘
    let svc2;
    try {
      svc2 = await createMemoryService({ memoHome, scope: SCOPE });
      const got = await svc2.get(id);
      assert.ok(got, '重开后记录应存在');
      assert.ok((got.hits ?? 0) >= 2, `close 后 hits 应已落盘（>=2），实际 ${got.hits}`);
      // 且真相层确有 hits 落盘的快照版本（不是只在内存）
      const lines = readFileSync(join(memoHome, 'items', itemsFileName(SCOPE)), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
      const hitVersions = lines.filter((r) => r.id === id && (r.hits ?? 0) >= 2);
      assert.ok(hitVersions.length >= 1, '真相层应含 hits 已累加的记录快照');
    } finally {
      if (svc2) await svc2.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
