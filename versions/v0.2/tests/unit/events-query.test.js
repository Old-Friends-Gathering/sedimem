import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';

const SCOPE = 'repo:unit-events';

async function fresh(over = {}) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  const svc = await createMemoryService({ memoHome, scope: SCOPE, ...over });
  return { svc, memoHome };
}

function writeEvents(memoHome, events) {
  writeFileSync(
    join(memoHome, 'events.jsonl'),
    events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n',
  );
}

const EV = (ts, op, scope = SCOPE, id = 'r1', detail = {}) => ({ ts, op, scope, id, detail });

describe('svc.events（裁决 30：只读事件查询）', () => {
  test('按 ts 倒序返回，scanned 计所有非空行（含其他 scope 与坏行）', async () => {
    const { svc, memoHome } = await fresh();
    try {
      writeEvents(memoHome, [
        EV('2026-11-01T00:00:00Z', 'write'),
        '{not json',
        EV('2026-11-02T00:00:00Z', 'forget', 'repo:other'),
        EV('2026-11-03T00:00:00Z', 'curate_apply'),
      ]);
      const r = await svc.events({});
      assert.equal(r.scanned, 4);
      assert.equal(r.events.length, 2);
      assert.equal(r.truncated, false);
      assert.deepEqual(r.events.map((e) => e.op), ['curate_apply', 'write']); // 倒序
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('[since, until) 半开：含 since、不含 until', async () => {
    const { svc, memoHome } = await fresh();
    try {
      writeEvents(memoHome, [
        EV('2026-11-01T00:00:00Z', 'a'),
        EV('2026-11-02T00:00:00Z', 'b'),
        EV('2026-11-03T00:00:00Z', 'c'),
      ]);
      const r = await svc.events({ since: '2026-11-02T00:00:00Z', until: '2026-11-03T00:00:00Z' });
      assert.deepEqual(r.events.map((e) => e.op), ['b']);
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('ops 白名单过滤', async () => {
    const { svc, memoHome } = await fresh();
    try {
      writeEvents(memoHome, [EV('2026-11-01T00:00:00Z', 'write'), EV('2026-11-02T00:00:00Z', 'forget')]);
      const r = await svc.events({ ops: ['forget'] });
      assert.deepEqual(r.events.map((e) => e.op), ['forget']);
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('命中超 limit → 截断且 truncated=true；只读不写 events.jsonl', async () => {
    const { svc, memoHome } = await fresh();
    try {
      writeEvents(memoHome, [
        EV('2026-11-01T00:00:00Z', 'a'),
        EV('2026-11-02T00:00:00Z', 'b'),
        EV('2026-11-03T00:00:00Z', 'c'),
      ]);
      const before = readFileSync(join(memoHome, 'events.jsonl'), 'utf8');
      const r = await svc.events({ limit: 2 });
      assert.equal(r.truncated, true);
      assert.equal(r.events.length, 2);
      assert.equal(r.scanned, 3);
      const after = readFileSync(join(memoHome, 'events.jsonl'), 'utf8');
      assert.equal(after, before); // 只读：读事件不得写 events.jsonl
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('events.jsonl 不存在 → 空结果', async () => {
    const { svc, memoHome } = await fresh();
    try {
      const r = await svc.events({});
      assert.deepEqual(r, { events: [], scanned: 0, truncated: false });
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });
});

describe('svc.exportRecords（裁决 30：只读记录导出）', () => {
  const W = (over = {}) => ({
    text: '端口是 6379', kind: 'fact', subject: 'monitor.server',
    predicate: 'port', value: '6379', source: { agent: 'test' }, ...over,
  });

  test('默认 status=active，superseded 记录被过滤；status=all 不过滤', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write(W({ text: 'v1', value: '1' }));
      const b = await svc.write(W({ text: 'v2', value: '2' })); // 同 slot 异值 → supersede
      assert.equal(b.action, 'supersede');
      const activeOnly = await svc.exportRecords();
      assert.equal(activeOnly.total, 1);
      assert.equal(activeOnly.records[0].id, b.record.id);
      const all = await svc.exportRecords({ status: 'all' });
      assert.equal(all.total, 2);
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('时间窗 [since, until) 按 createdAt 半开', async () => {
    let t = 0;
    const base = Date.UTC(2026, 10, 2, 0, 0, 0);
    const clock = { now: () => new Date(base + t * 1000).toISOString(), nowMs: () => base + t * 1000 };
    const { svc, memoHome } = await fresh({ clock });
    try {
      await svc.write(W({ text: 'r-a', subject: 's.a' }));
      t++;
      const mid = clock.now();
      const later = await svc.write(W({ text: 'r-b', subject: 's.b' }));
      t++;
      const r = await svc.exportRecords({ status: 'all', since: mid });
      assert.deepEqual(r.records.map((x) => x.id), [later.record.id]);
      const none = await svc.exportRecords({ status: 'all', since: mid, until: later.record.createdAt });
      assert.equal(none.total, 0);
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('suspicious 记录默认遮蔽 text/value；includeSuspicious:true 放行原文', async () => {
    const { svc, memoHome } = await fresh();
    try {
      // 打标是显式传 tags，正文不必含真实形态的凭据（避免仓库里出现形似密钥的字面量，S2 门禁）
      const w = await svc.write(W({ text: '示例：密钥占位符（此处故意不含真实凭据字面量）', subject: 's.sus', tags: ['suspicious'] }));
      const masked = await svc.exportRecords();
      assert.equal(masked.total, 1);
      assert.equal(masked.records[0].text, '[suspicious withheld]');
      assert.equal(masked.records[0].value, '[suspicious withheld]');
      assert.ok(masked.records[0].tags.includes('suspicious'));
      const raw = await svc.exportRecords({ includeSuspicious: true });
      assert.equal(raw.records[0].text, w.record.text);
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('kind 过滤 + limited 截断标志', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write(W({ text: '用 pnpm', kind: 'pref', subject: 's.p' }));
      await svc.write(W({ text: '事实', kind: 'fact', subject: 's.f' }));
      const onlyFact = await svc.exportRecords({ kind: 'fact' });
      assert.equal(onlyFact.total, 1);
      assert.equal(onlyFact.records[0].kind, 'fact');
      const limited = await svc.exportRecords({ limit: 1 });
      assert.equal(limited.limited, true);
      assert.equal(limited.records.length, 1);
      assert.equal(limited.total, 2);
      const full = await svc.exportRecords({ limit: 2000 });
      assert.equal(full.limited, false);
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });

  test('每条含完整字段集合', async () => {
    const { svc, memoHome } = await fresh();
    try {
      await svc.write(W({ text: '字段检查', subject: 's.fields' }));
      const { records } = await svc.exportRecords();
      assert.deepEqual(Object.keys(records[0]).sort(), [
        'createdAt', 'hits', 'id', 'kind', 'predicate', 'source',
        'status', 'subject', 'tags', 'text', 'validFrom', 'validTo', 'value',
      ]);
    } finally {
      await svc.close(); rmSync(memoHome, { recursive: true, force: true });
    }
  });
});
