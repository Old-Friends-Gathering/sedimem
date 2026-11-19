// B7.6 参考集重跑（gate 口径）保护测试
// 规格：docs/design/v2.0/09-extraction-pipeline.md §11（放行六条件）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus, buildSources, goldToClaim, runScenario, runReference } from '../tools/reference-run.mjs';

const CORPUS = 'pilot/p1a/corpus';

function scenario() {
  return {
    scenarioId: 'S900',
    family: 'fam-test',
    language: 'en',
    source: { kind: 'dsh-transcript', sourceEpoch: 1 },
    split: 'dev',
    events: [
      { eventId: 'S900-m001', role: 'user', ts: '2026-11-19T00:00:00Z', text: 'The port is 8080.' },
      { eventId: 'S900-m002', role: 'user', ts: '2026-11-19T00:00:10Z', text: 'Retry is done.' },
    ],
    gold: [
      {
        goldId: 'S900-g01',
        claim: 'The port is 8080',
        role: 'user',
        type: 'fact',
        scope: 'repo:demo',
        assertion: { speechAct: 'state', negated: false, about: 'deploy', condition: null },
        status: 'active',
        time: { observedAt: '2026-11-19T00:00:00Z', assertedValidFrom: null, assertedValidTo: null },
        evidence: [{ eventId: 'S900-m001', quote: 'The port is 8080' }],
        language: 'en',
        family: 'fam-test',
      },
    ],
  };
}

test('R6-1 loadCorpus 读入全部 scenarios-*.jsonl 且场景 ID 唯一', () => {
  const all = loadCorpus(CORPUS);
  assert.ok(all.length >= 200);
  const ids = new Set(all.map((s) => s.scenarioId));
  assert.equal(ids.size, all.length);
});

test('R6-2 goldToClaim 把 gold 转成管线入参：quote/role/ts 来自证据事件', () => {
  const s = scenario();
  const c = goldToClaim(s.gold[0], s);
  assert.equal(c.claim, 'The port is 8080');
  assert.equal(c.scope, 'repo:demo');
  assert.equal(c.evidence[0].quote, 'The port is 8080');
  assert.equal(c.evidence[0].ts, '2026-11-19T00:00:00Z');
  assert.equal(c.role, 'user');
  assert.equal(c.assertion.about, 'deploy');
});

test('R6-3 runScenario 对 oracle gold 走真矩阵：可接受的进真相层、被拒的不进', () => {
  const s = scenario();
  const src = buildSources([s]);
  const r = runScenario(s, src, { clock: () => '2026-11-19T01:00:00Z' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].decision, 'accept');
  assert.equal(r.rows[0].row, 9);
  assert.equal(r.accepted.length, 1);
  assert.ok(r.accepted[0].recordId);
});

test('R6-4 runScenario 无 gold 的场景不产行（无可记/纯注入场景）', () => {
  const s = { ...scenario(), gold: [] };
  const r = runScenario(s, buildSources([s]), {});
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.accepted, []);
});

test('R6-5 runReference 聚合 totals/行分布/reject 原因，且 contentDigest 稳定', () => {
  const s = scenario();
  const a = runReference([s], { clock: () => '2026-11-19T01:00:00Z' });
  const b = runReference([s], { clock: () => '2026-11-19T01:00:00Z' });
  assert.deepEqual(a.totals, { gold: 1, accept: 1, hold: 0, reject: 0 });
  assert.equal(a.acceptRate, 1);
  assert.deepEqual(a.rowHistogram, { '9:policy-accept': 1 });
  assert.equal(a.contentDigest, b.contentDigest);
});

test('R6-6 only 过滤只跑指定场景（调试路径不改变口径）', () => {
  const s1 = scenario();
  const s2 = { ...scenario(), scenarioId: 'S901', gold: [], events: [{ eventId: 'S901-m001', role: 'user', ts: '', text: 'hi' }] };
  const r = runReference([s1, s2], { only: ['S901'] });
  assert.equal(r.scenarioCount, 1);
  assert.equal(r.totals.gold, 0);
});

test('R6-7 参考集重跑不得写入真相层文件、不得联网（工具只返回内存对象）', async () => {
  const fs = await import('node:fs');
  const before = fs.existsSync('pilot/p1a/out');
  const r = runReference([scenario()], {});
  assert.equal(typeof r, 'object');
  assert.ok(!('writeFileSync' in r));
  // 只读路径声明：runReference 不写文件（写盘只在 writeReport）
  assert.equal(fs.existsSync('pilot/p1a/out'), before);
});
