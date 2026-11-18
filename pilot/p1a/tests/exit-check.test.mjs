// exit-check.mjs TDD：P1a 出口核验的机算实现（先红后绿）。
// 规格来源：plans/v2.0-p1.md §0.2/§7.1 + docs/design/v2.0/README.md 冻结核验表。
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExit, parseFrozenTable, renderExitReport } from '../tools/exit-check.mjs';

const MANIFEST = (over = {}) => ({
  stage: 'exit',
  thresholds: {
    corpus: {
      minScenariosTotal: { exitLevel: 4, pilot: 2 },
      minGoldClaims: { exitLevel: 4, pilot: 2 },
      minScenariosDev: { exitLevel: 2 },
      minScenariosTest: { exitLevel: 2 },
      minNonRecordable: { exitLevel: 1 },
      minTestZh: { exitLevel: 1, exitScope: 'test' },
      minTestEn: { exitLevel: 1, exitScope: 'test' },
      minAdversarialPerClass: { exitLevel: 1, exitScope: 'test' },
    },
    nearDuplicateDice: { value: 0.85 },
    adversarialClasses: ['negation', 'tool-failure'],
    adversarialOutcomeMap: { negation: 'emit-with-flag', 'tool-failure': 'block' },
    ...over,
  },
});

const SC = (id, split, lang, { adv, reject, goldCount = 1 } = {}) => ({
  scenarioId: id,
  family: 'fam-a',
  language: lang,
  split,
  events: [{ eventId: `${id}-m001`, role: 'user', ts: 't', text: `事件文本 ${id}` }],
  gold: Array.from({ length: goldCount }, (_, i) => ({
    goldId: `${id}-g0${i + 1}`, claim: `命题 ${id} ${i + 1}`, role: 'user', type: 'fact', scope: 'repo:x',
    assertion: { speechAct: 'state', negated: false, about: null, condition: null },
    status: 'active', evidence: [{ eventId: `${id}-m001`, quote: `事件文本 ${id}` }], language: lang, family: 'fam-a',
  })),
  shouldReject: reject ? { reason: 'chitchat' } : null,
  adversarial: adv ? { class: adv, target: { eventId: `${id}-m001`, quote: `事件文本 ${id}` }, expectedOutcome: MANIFEST().thresholds.adversarialOutcomeMap[adv], expectedErrorClass: 'unsupported-fact' } : null,
});

// 九项 = 1a/1b/2/3/4/5/6/7/8（上位 §0.4 把第 1 项拆成状态机与幂等两条）
const FROZEN_OK = parseFrozenTable(
  ['1a', '1b', 2, 3, 4, 5, 6, 7, 8].map((i) => `| ${i} | 项 ${i} | spec | test | frozen（2026-11-18） |`).join('\n'),
);

test('parseFrozenTable：解析编号与状态，frozen 带日期算已冻结', () => {
  assert.equal(FROZEN_OK.length, 9);
  assert.ok(FROZEN_OK.every((r) => r.frozen));
  const mixed = parseFrozenTable('| 1 | a | spec | test | proposed |\n| 2 | b | spec | test | frozen |');
  assert.deepEqual(mixed.map((r) => r.frozen), [false, true]);
});

test('evaluateExit：全达标 → ok=true 且无失败项', () => {
  const scenarios = [
    SC('S1', 'dev', 'zh'), SC('S2', 'dev', 'zh'),
    SC('S3', 'test', 'zh', { adv: 'negation' }), SC('S4', 'test', 'en', { adv: 'tool-failure' }),
    SC('S5', 'dev', 'zh', { reject: true, goldCount: 0 }),
  ];
  const r = evaluateExit({
    scenarios, manifest: MANIFEST(), frozenRows: FROZEN_OK,
    annotation: { mode: 'dual-independent', pass1: true, pass2: true, goldset: true },
  });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok && !c.pending)));
  assert.equal(r.pending.length, 0);
});

test('evaluateExit：语料不足/无对抗/未冻结 → 失败项点名', () => {
  const scenarios = [SC('S1', 'dev', 'zh'), SC('S2', 'test', 'zh')];
  const r = evaluateExit({
    scenarios, manifest: MANIFEST(), frozenRows: parseFrozenTable('| 1 | a | s | t | proposed |'),
    annotation: { mode: 'pilot', pass1: true, pass2: false, goldset: false },
  });
  assert.equal(r.ok, false);
  const failed = r.checks.filter((c) => !c.ok && !c.pending).map((c) => c.id);
  assert.ok(failed.includes('corpus-scenarios'), `应点名 corpus-scenarios，实际：${failed}`);
  assert.ok(failed.includes('adversarial-quota'), `应点名 adversarial-quota，实际：${failed}`);
  assert.ok(failed.includes('frozen-decisions'), `应点名 frozen-decisions，实际：${failed}`);
});

test('evaluateExit：参考产物未完成 → pending（不算失败），但 ok=false 且 blockedBy 指向它', () => {
  const scenarios = [
    SC('S1', 'dev', 'zh'), SC('S2', 'dev', 'zh'),
    SC('S3', 'test', 'zh', { adv: 'negation' }), SC('S4', 'test', 'en', { adv: 'tool-failure' }),
    SC('S5', 'dev', 'zh', { reject: true, goldCount: 0 }),
  ];
  const r = evaluateExit({
    scenarios, manifest: MANIFEST(), frozenRows: FROZEN_OK,
    annotation: { mode: 'pilot', pass1: true, pass2: false, goldset: false },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pending.map((c) => c.id), ['annotation-dual']);
  assert.deepEqual(r.blockedBy, ['annotation-dual']);
});

test('renderExitReport：输出含每项状态与总结行', () => {
  const scenarios = [
    SC('S1', 'dev', 'zh'), SC('S2', 'dev', 'zh'),
    SC('S3', 'test', 'zh', { adv: 'negation' }), SC('S4', 'test', 'en', { adv: 'tool-failure' }),
    SC('S5', 'dev', 'zh', { reject: true, goldCount: 0 }),
  ];
  const r = evaluateExit({
    scenarios, manifest: MANIFEST(), frozenRows: FROZEN_OK,
    annotation: { mode: 'pilot', pass1: true, pass2: false, goldset: false },
  });
  const text = renderExitReport(r);
  assert.match(text, /P1a 出口核验/);
  assert.match(text, /annotation-dual/);
  assert.match(text, /待完成 1 项/);
});

// ---------- 模型参考来源模式：model-dual-blinded（模型盲评双遍 + 裁决） ----------
test('annotation-dual：model-dual-blinded 满足资产出口但带来源声明（caveat），不冒充 dual-independent', () => {
  const scenarios = [
    SC('S1', 'dev', 'zh'), SC('S2', 'dev', 'zh'),
    SC('S3', 'test', 'zh', { adv: 'negation' }), SC('S4', 'test', 'en', { adv: 'tool-failure' }),
    SC('S5', 'dev', 'zh', { reject: true, goldCount: 0 }),
  ];
  const r = evaluateExit({
    scenarios, manifest: MANIFEST(), frozenRows: FROZEN_OK,
    annotation: { mode: 'model-dual-blinded', pass1: true, pass2: true, goldset: true },
  });
  const chk = r.checks.find((c) => c.id === 'annotation-dual');
  assert.equal(chk.ok, true);
  assert.equal(chk.pending, false);
  assert.ok(chk.caveat, '模型来源必须留下 caveat');
  assert.match(chk.caveat, /model-dual-blinded/);
  assert.equal(r.ok, true);
  assert.deepEqual(r.blockedBy, []);
  assert.deepEqual(r.caveats, ['annotation-dual']);
});

test('annotation-dual：dual-independent 无 caveat', () => {
  const scenarios = [
    SC('S1', 'dev', 'zh'), SC('S2', 'dev', 'zh'),
    SC('S3', 'test', 'zh', { adv: 'negation' }), SC('S4', 'test', 'en', { adv: 'tool-failure' }),
    SC('S5', 'dev', 'zh', { reject: true, goldCount: 0 }),
  ];
  const r = evaluateExit({
    scenarios, manifest: MANIFEST(), frozenRows: FROZEN_OK,
    annotation: { mode: 'dual-independent', pass1: true, pass2: true, goldset: true },
  });
  const chk = r.checks.find((c) => c.id === 'annotation-dual');
  assert.equal(chk.ok, true);
  assert.equal(chk.caveat, undefined);
  assert.deepEqual(r.caveats, []);
});

test('renderExitReport：模型参考模式结论行标注 caveat 数', () => {
  const scenarios = [
    SC('S1', 'dev', 'zh'), SC('S2', 'dev', 'zh'),
    SC('S3', 'test', 'zh', { adv: 'negation' }), SC('S4', 'test', 'en', { adv: 'tool-failure' }),
    SC('S5', 'dev', 'zh', { reject: true, goldCount: 0 }),
  ];
  const r = evaluateExit({
    scenarios, manifest: MANIFEST(), frozenRows: FROZEN_OK,
    annotation: { mode: 'model-dual-blinded', pass1: true, pass2: true, goldset: true },
  });
  const text = renderExitReport(r);
  assert.match(text, /⚠️/);
  assert.match(text, /参考来源声明 1 项/);
});

// 用户策略r2：模型参考可用，不要求人工标注；资产ok不代表生产实现就绪。
test('r2：模型参考来源声明不再要求人工复核，且明确仅检查P1a资产', () => {
  const r = evaluateExit({
    scenarios: [], manifest: MANIFEST(), frozenRows: FROZEN_OK,
    annotation: { mode: 'model-dual-blinded', pass1: true, pass2: true, goldset: true },
  });
  const chk = r.checks.find((c) => c.id === 'annotation-dual');
  assert.equal(chk.ok, true);
  assert.doesNotMatch(chk.detail, /以人工双标注复核为硬前置|待第二标注人/);
  assert.equal(r.policyVersion, 'auto-memory-r2');
  assert.equal(r.scope, 'p1a-assets');
  assert.equal(r.runtimeImplemented, false);
});

test('r2：参考产物缺失仍pending，但不是等待人工人选', () => {
  const r = evaluateExit({ scenarios: [], manifest: MANIFEST(), frozenRows: FROZEN_OK, annotation: {} });
  const chk = r.checks.find((c) => c.id === 'annotation-dual');
  assert.equal(chk.ok, false);
  assert.equal(chk.pending, true);
  assert.match(chk.detail, /参考产物/);
  assert.doesNotMatch(chk.detail, /第二标注人|人工.*前置/);
});
