// B2：trust / taint 最小集（P0b）
// 契约：docs/02-data-model-and-contract.md §3.24；docs/plans/v1.4-p0b.md §B2
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { createRecord } from '../../src/core/record.js';
import { itemsFileName } from '../../src/config/paths.js';
import {
  deriveTrust, effectiveTrust, effectiveTaint, unionTaint, weakestTrust,
} from '../../src/core/trust.js';

const SCOPE = 'repo:trust-test';

async function fresh() {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-trust-'));
  const svc = await createMemoryService({ memoHome, scope: SCOPE });
  return { svc, memoHome };
}

const W = (over = {}) => ({
  text: '端口是 6379',
  kind: 'fact',
  subject: 'monitor.server',
  predicate: 'port',
  value: '6379',
  source: { agent: 'test' },
  ...over,
});

function lastLine(memoHome) {
  const raw = readFileSync(join(memoHome, 'items', itemsFileName(SCOPE)), 'utf8').trim().split('\n');
  return JSON.parse(raw[raw.length - 1]);
}

describe('B2 trust/taint：写路径不得自报 T0', () => {
  test('普通 write 即使显式传 trust:T0 也只落 T2', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const res = await svc.write(W({ source: { agent: 'cli' }, trust: 'T0' }));
      assert.equal(res.record.trust, 'T2');
      // 真相层同样只有 T2（不是只在返回值里挡）
      assert.equal(lastLine(memoHome).trust, 'T2');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('非法 trust / taint 在写入时 fail-loud', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await assert.rejects(() => svc.write(W({ trust: 'T9' })), (e) => e.code === 'E_INVALID_RECORD');
      await assert.rejects(() => svc.write(W({ taint: 'remote' })), (e) => e.code === 'E_INVALID_RECORD');
      await assert.rejects(() => svc.write(W({ taint: [''] })), (e) => e.code === 'E_INVALID_RECORD');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('读取派生：存量 cli/dsh 记录缺 trust → T0；capture 与未知 agent → T2；真相层不改', async () => {
    const { svc, memoHome } = await fresh();
    try {
      // 模拟 B2 之前的存量行：用 createRecord 造一条没有 trust 键的记录直接落真相层。
      const legacy = (over) => createRecord(W({ ...over, scope: SCOPE, trust: undefined }), { clock: svc.clock });
      const cli = { record: legacy({ text: 'cli 写的历史事实', subject: 's.cli', source: { agent: 'cli' } }) };
      const cap = { record: legacy({ text: 'capture 抓来的内容', subject: 's.cap', source: { agent: 'dsh' }, tags: ['capture'] }) };
      await svc._commit(cli.record, 'write', { action: 'legacy' });
      await svc._commit(cap.record, 'write', { action: 'legacy' });

      assert.equal(effectiveTrust(svc._records.get(cli.record.id)), 'T0');
      assert.equal(effectiveTrust(svc._records.get(cap.record.id)), 'T2');
      // get 是读取视图：派生值出现在返回值里
      assert.equal((await svc.get(cli.record.id)).trust, 'T0');
      // 但真相层没有新增 trust 键（读时派生 ≠ backfill 写回）
      const lines = readFileSync(join(memoHome, 'items', itemsFileName(SCOPE)), 'utf8').trim().split('\n');
      for (const line of lines) {
        const rec = JSON.parse(line);
        if (rec.id === cli.record.id) assert.equal(rec.trust, undefined);
      }
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('deriveTrust 的边界：write 恒 T2；read 只认 cli/dsh/claude/codex/test 且非 capture', () => {
    assert.equal(deriveTrust({ source: { agent: 'cli' } }, { mode: 'write' }), 'T2');
    assert.equal(deriveTrust({ source: { agent: 'cli' } }), 'T0');
    assert.equal(deriveTrust({ source: { agent: 'cli' }, tags: ['capture'] }), 'T2');
    assert.equal(deriveTrust({ source: { agent: 'dsh' } }), 'T0');
    assert.equal(deriveTrust({ source: { agent: 'claude' } }), 'T0');
    assert.equal(deriveTrust({ source: { agent: 'codex' } }), 'T0');
    assert.equal(deriveTrust({ source: { agent: 'test' } }), 'T0');
    assert.equal(deriveTrust({ source: { agent: 'web-import' } }), 'T2');
    assert.equal(weakestTrust('T0', 'T2'), 'T2');
    assert.deepEqual(unionTaint(['a'], ['b', 'a']), ['a', 'b']);
  });
});

describe('B2 trust/taint：supersede / merge 污点单调不减', () => {
  test('人工 supersede 不得把 T0 洗成 T0，且继承旧 taint', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const old = await svc.write(W({ text: '旧值 1', value: '1', subject: 's.port', taint: ['remote:http://x'] }));
      await svc.promoteTrust({ id: old.record.id, to: 'T0', reason: '维护者确认' });
      const out = await svc.supersede({
        oldId: old.record.id, value: '2', text: '新值 2', source: { agent: 'cli' },
      });
      // 写路径只能 T2：T0 记录被普通 supersede 覆盖后变 T2，绝不允许保持 T0。
      assert.equal(out.record.trust, 'T2');
      assert.ok(out.record.taint.includes('remote:http://x'), '旧 taint 必须被继承');
      assert.equal(out.record.v, (await svc.get(old.record.id)).v, '新版本必须沿着被取代记录的版本链 +1');
      // 旧记录被关闭为 superseded，同样 v+1
      const closed = lastLine(memoHome);
      assert.equal(closed.status, 'superseded');
      assert.equal(closed.v, out.record.v);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('同 slot 覆盖写（write-gate supersede）也把旧 taint 并入新记录', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write(W({ text: '端口 6379', value: '6379', taint: ['remote:a'] }));
      const res = await svc.write(W({ text: '端口 6380', value: '6380', taint: ['remote:b'] }));
      assert.equal(res.action, 'supersede');
      assert.deepEqual(res.record.taint, ['remote:a', 'remote:b']);
      assert.equal(res.record.trust, 'T2');
      assert.equal(res.record.v, 2);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('noop 重复写不丢候选 taint：追加 v+1 快照而不是只写事件', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const first = await svc.write(W({ text: '完全一样的句子', taint: ['remote:a'] }));
      const dup = await svc.write(W({ text: '完全一样的句子', taint: ['remote:b'] }));
      assert.equal(dup.action, 'noop_duplicate');
      assert.deepEqual(dup.record.taint, ['remote:a', 'remote:b']);
      assert.equal(dup.record.v, 2);
      // 重复写入没有新增 active 记录
      assert.equal((await svc.exportRecords()).total, 1);
      assert.equal((await svc.get(first.record.id)).taint.includes('remote:b'), true);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('curate merge：taint 取并集、trust 取更弱者（T0+T2 → T2）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const a = await svc.write(W({ text: '记忆层用 append-only JSONL', subject: 's.a', taint: ['remote:a'] }));
      const b = await svc.write(W({ text: '索引和摘要都是可重建的派生物', subject: 's.b', taint: ['remote:b'] }));
      await svc.promoteTrust({ id: a.record.id, to: 'T0', reason: '维护者确认' });
      await svc.curateApply({ decisions: [{ ids: [a.record.id, b.record.id], decision: 'merge' }] });
      const winner = svc._records.get(a.record.id);
      assert.equal(winner.status, 'active');
      assert.deepEqual(effectiveTaint(winner), ['remote:a', 'remote:b']);
      assert.equal(effectiveTrust(winner), 'T2');
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});

describe('B2 `memo trust promote`：唯一提升动作 + 审计', () => {
  test('必须给理由；只能变强；写 trust_promote 审计事件', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const w = await svc.write(W({ taint: ['remote:x', 'remote:y'] }));
      await assert.rejects(() => svc.promoteTrust({ id: w.record.id, to: 'T0' }), (e) => e.code === 'E_INVALID_ARG');
      await assert.rejects(() => svc.promoteTrust({ id: w.record.id, to: 'T3', reason: 'x' }), (e) => e.code === 'E_INVALID_ARG');

      const out = await svc.promoteTrust({
        id: w.record.id, to: 'T1', reason: '人工复核通过', dropTaint: ['remote:x'],
      });
      assert.equal(out.from, 'T2');
      assert.equal(out.to, 'T1');
      assert.equal(out.taintRemoved, 1);
      assert.deepEqual(effectiveTaint(svc._records.get(w.record.id)), ['remote:y']);

      const ev = await svc.events({ ops: ['trust_promote'] });
      assert.equal(ev.events.length, 1);
      assert.equal(ev.events[0].id, w.record.id);
      assert.equal(ev.events[0].detail.reason, '人工复核通过');
      assert.equal(ev.events[0].detail.from, 'T2');
      assert.equal(ev.events[0].detail.to, 'T1');
      // 审计脱敏：taint 原文不进事件流，只留短指纹
      const raw = readFileSync(join(memoHome, 'events.jsonl'), 'utf8');
      assert.equal(raw.includes('remote:x'), false);
      assert.match(raw, /sha256:/);
    } finally {
      await svc.close();
      rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
