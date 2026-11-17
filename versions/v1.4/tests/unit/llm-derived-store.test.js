// tests/unit/llm-derived-store.test.js — 派生层 sidecar 存储（追加/最后行/非ok/rebuild/真相层不变）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDerived, appendDerived, rebuildDerived, derivedFilePath } from '../../src/llm/derived-store.js';
import { JsonlStore } from '../../src/storage/jsonl-store.js';

const FIXED_TS = '2026-11-13T10:00:00.000Z';

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'memo-llm-derived-'));
}

function okRow(id, validFrom, extra = {}) {
  return {
    id, validFrom, promptVersion: 'd1-v1', model: 'test-model',
    title: `标题-${id}`, summary: `摘要-${id}`, tags: ['t'],
    deriveStatus: 'ok', ts: FIXED_TS, ...extra,
  };
}

describe('llm/derived-store', () => {
  test('追加后可读：appendDerived 落盘，loadDerived 返回该条', async () => {
    const home = freshHome();
    try {
      await appendDerived({ memoHome: home, scope: 'repo:demo', record: okRow('id1', '2026-01-01T00:00:00.000Z') });
      const map = await loadDerived({ memoHome: home, scope: 'repo:demo' });
      assert.equal(map.size, 1);
      const row = map.get('id1@2026-01-01T00:00:00.000Z');
      assert.equal(row.title, '标题-id1');
      assert.equal(row.deriveStatus, 'ok');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('取最后一行：同键追加两次，读到的是最新一条', async () => {
    const home = freshHome();
    try {
      await appendDerived({ memoHome: home, scope: 'repo:demo', record: okRow('id1', 'v1', { title: '旧标题' }) });
      await appendDerived({ memoHome: home, scope: 'repo:demo', record: okRow('id1', 'v1', { title: '新标题' }) });
      const map = await loadDerived({ memoHome: home, scope: 'repo:demo' });
      assert.equal(map.size, 1);
      assert.equal(map.get('id1@v1').title, '新标题');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('非 ok 状态视为无派生：failed/no-provider/budget-exceeded 都不进 Map', async () => {
    const home = freshHome();
    try {
      for (const status of ['failed', 'no-provider', 'budget-exceeded', 'privacy-blocked']) {
        await appendDerived({
          memoHome: home, scope: 'repo:demo',
          record: { ...okRow(`id-${status}`, 'v1'), deriveStatus: status },
        });
      }
      const map = await loadDerived({ memoHome: home, scope: 'repo:demo' });
      assert.equal(map.size, 0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('坏行不阻塞读取：半行 JSON 被跳过，好行照常返回', async () => {
    const home = freshHome();
    try {
      await appendDerived({ memoHome: home, scope: 'repo:demo', record: okRow('id1', 'v1') });
      const p = derivedFilePath(home, 'repo:demo');
      // 模拟崩溃残留的半行（无换行结尾也可以）
      const { appendFileSync } = await import('node:fs');
      appendFileSync(p, '{"id":"id2","validFrom":"v1","tit', 'utf8');
      const map = await loadDerived({ memoHome: home, scope: 'repo:demo' });
      assert.equal(map.size, 1);
      assert.ok(map.has('id1@v1'));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('rebuild 原子且幂等：收敛同键、无 tmp 残留、重复 rebuild 字节相同', async () => {
    const home = freshHome();
    try {
      await appendDerived({ memoHome: home, scope: 'repo:demo', record: okRow('id1', 'v1', { title: '旧' }) });
      await appendDerived({ memoHome: home, scope: 'repo:demo', record: okRow('id1', 'v1', { title: '新' }) });
      await appendDerived({ memoHome: home, scope: 'repo:demo', record: okRow('id2', 'v1') });
      const p = derivedFilePath(home, 'repo:demo');
      const r1 = await rebuildDerived({ memoHome: home, scope: 'repo:demo' });
      assert.equal(r1.keys, 2);
      const bytes1 = readFileSync(p, 'utf8');
      assert.ok(!existsSync(`${p}.tmp`), 'rename 后不应残留 tmp');
      const r2 = await rebuildDerived({ memoHome: home, scope: 'repo:demo' });
      assert.equal(r2.keys, 2);
      assert.equal(readFileSync(p, 'utf8'), bytes1, '幂等：字节相同');
      // 收敛后仍取最后一行语义
      const map = await loadDerived({ memoHome: home, scope: 'repo:demo' });
      assert.equal(map.get('id1@v1').title, '新');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('派生写入后真相层 sha256 不变（I44/Q15）', async () => {
    const home = freshHome();
    const scope = 'repo:demo';
    try {
      // 先造一条真相层记录
      const clock = { nowMs: () => 0, now: () => FIXED_TS };
      const rec = {
        id: 't1', validFrom: FIXED_TS,
        text: '用户偏好深色主题', kind: 'pref', subject: '用户', predicate: '偏好',
        value: '深色主题', source: { agent: 'test' }, scope, clock,
      };
      const store = new JsonlStore({ memoHome: home });
      await store.append(rec);
      const itemsPath = join(home, 'items', `${scope}.jsonl`);
      const shaBefore = createHash('sha256').update(readFileSync(itemsPath)).digest('hex');
      // 派生写入
      await appendDerived({ memoHome: home, scope, record: okRow('t1', FIXED_TS) });
      await rebuildDerived({ memoHome: home, scope });
      const shaAfter = createHash('sha256').update(readFileSync(itemsPath)).digest('hex');
      assert.equal(shaAfter, shaBefore, '派生前后真相层字节必须不变');
      const all = await store.loadScope(scope);
      assert.equal(all.length, 1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('scopeKeyOf 路径归一：scope 冒号折叠成文件名安全片段', async () => {
    const home = freshHome();
    try {
      await appendDerived({ memoHome: home, scope: 'Repo Demo/x', record: okRow('id1', 'v1') });
      assert.ok(existsSync(join(home, 'derived', 'repo-demo-x.jsonl')));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
