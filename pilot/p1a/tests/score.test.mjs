// B2 评分器 TDD：TP/FP/FN 一对一、七类严重错误、mixed 双组计入、pilot fail-closed。
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeClaim, scoreRun } from '../tools/score.mjs';

const GOLD = (over = {}) => ({
  goldId: 'g1', claim: '连接池已提升到 200', role: 'user', type: 'fact', scope: 'repo:demo-a',
  assertion: { speechAct: 'state', negated: false, about: null, condition: null },
  status: 'active', evidence: [{ eventId: 'm1', quote: '连接池已提升到 200' }],
  ...over,
});
const SCEN = (over = {}) => ({
  scenarioId: 'S1', family: 'fam-a', language: 'zh',
  events: [{ eventId: 'm1', role: 'user', ts: 't', text: '连接池已提升到 200。' }],
  gold: [GOLD()], shouldReject: null, adversarial: null,
  ...over,
});
const CAND = (over = {}) => ({
  candidateId: 'C1', status: 'pending', type: 'fact', claim: '连接池已提升到 200', role: 'user',
  scope: 'repo:demo-a',
  assertion: { speechAct: 'state', negated: false, about: null, condition: null },
  evidence: [{ eventId: 'm1', quote: '连接池已提升到 200', start: 0, end: 10, hash: 'sha256:x' }],
  ...over,
});

test('normalizeClaim: 大小写/标点/空白归一', () => {
  assert.equal(normalizeClaim('Hello, World!'), normalizeClaim('hello world'));
  assert.equal(normalizeClaim('  连接池 200。'), normalizeClaim('连接池 200'));
});

test('精确匹配 → TP，P=R=1', () => {
  const r = scoreRun({ candidates: [CAND()], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r.totals.tp, 1);
  assert.equal(r.totals.fp, 0);
  assert.equal(r.totals.fn, 0);
  assert.equal(r.groups.zh.tp, 1);
});

test('候选为 gold 子命题 → FN+FP（04 §2 子超集口径）', () => {
  const c = CAND({ claim: '连接池已提升', evidence: [{ eventId: 'm1', quote: '连接池已提升', start: 0, end: 6, hash: 'h' }] });
  const r = scoreRun({ candidates: [c], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r.totals.fp, 1);
  assert.equal(r.totals.fn, 1);
});

test('negation-flip：候选否定位相反计严重错误', () => {
  const c = CAND({ assertion: { speechAct: 'state', negated: true, about: null, condition: null } });
  const r = scoreRun({ candidates: [c], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r.totals.tp, 1);
  assert.equal(r.severe['negation-flip'], 1);
});

test('speaker-misattribution：role 不一致计严重错误', () => {
  const c = CAND({ role: 'assistant' });
  const r = scoreRun({ candidates: [c], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r.severe['speaker-misattribution'], 1);
});

test('suggestion-promoted：gold suggest 候选 agree/decide 计严重错误；state 不算（04 §4 逐字对齐）', () => {
  const g = GOLD({ assertion: { speechAct: 'suggest', negated: false, about: null, condition: null } });
  const rAgree = scoreRun({ candidates: [CAND({ assertion: { speechAct: 'agree', negated: false, about: null, condition: null } })], scenarios: [SCEN({ gold: [g] })], manifest: { stage: 'pilot' } });
  assert.equal(rAgree.severe['suggestion-promoted'], 1);
  const rDecide = scoreRun({ candidates: [CAND({ assertion: { speechAct: 'decide', negated: false, about: null, condition: null } })], scenarios: [SCEN({ gold: [g] })], manifest: { stage: 'pilot' } });
  assert.equal(rDecide.severe['suggestion-promoted'], 1);
  const rState = scoreRun({ candidates: [CAND({ assertion: { speechAct: 'state', negated: false, about: null, condition: null } })], scenarios: [SCEN({ gold: [g] })], manifest: { stage: 'pilot' } });
  assert.equal(rState.severe['suggestion-promoted'], 0, 'state 是普通陈述降级，不是变批准');
});

test('cross-scope-leak：scope 不一致计严重错误；scopeUnresolved 占位豁免（R2-M#3）', () => {
  const c = CAND({ scope: 'repo:other' });
  const r = scoreRun({ candidates: [c], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r.severe['cross-scope-leak'], 1);
  const ph = CAND({ scope: 'pilot:synthetic', scopeUnresolved: true });
  const r2 = scoreRun({ candidates: [ph], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r2.severe['cross-scope-leak'], 0, '占位 scope 不构成泄漏判定依据');
});

test('FP 候选的 severe 逃逸也计数（R2-m#4）：未匹配候选记 retract 为当前 + 证据不可定位', () => {
  const g = GOLD({ status: 'retracted', type: 'fact', claim: '网关已经回滚到 1.2.3' });
  const bad = CAND({ claim: '网关已经回滚完成并且运行正常', type: 'fact', evidence: [{ eventId: 'm1', quote: '查无此句', start: 0, end: 4, hash: 'h' }] });
  const r = scoreRun({ candidates: [bad], scenarios: [SCEN({ gold: [g] })], manifest: { stage: 'pilot' } });
  assert.equal(r.totals.fp, 1);
  assert.equal(r.severe['retract-treated-current'], 1, 'FP 候选把已撤回事实当当前事实');
  assert.equal(r.severe['unsupported-fact'], 1, 'FP 候选证据不可定位同样计');
});

test('unsupported-fact：多证据候选任一条不可定位即计（R2-m#5）', () => {
  const c = CAND({ evidence: [
    { eventId: 'm1', quote: '数据库连接池已提升到 200。', start: 0, end: 14, hash: 'h' },
    { eventId: 'm1', quote: '这条不存在', start: 0, end: 5, hash: 'h' },
  ] });
  const r = scoreRun({ candidates: [c], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r.severe['unsupported-fact'], 1);
});

test('not-done-became-done：gold not-done 候选 active task-state 计严重错误', () => {
  const g = GOLD({ status: 'not-done', type: 'task-state' });
  const c = CAND({ type: 'task-state', status: 'pending' });
  const r = scoreRun({ candidates: [c], scenarios: [SCEN({ gold: [g] })], manifest: { stage: 'pilot' } });
  assert.equal(r.severe['not-done-became-done'], 1);
});

test('unsupported-fact：候选证据 quote 在事件中不可定位计严重错误', () => {
  const c = CAND({ evidence: [{ eventId: 'm1', quote: '查无此句', start: 0, end: 4, hash: 'h' }] });
  const r = scoreRun({ candidates: [c], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r.severe['unsupported-fact'], 1);
});

test('记录型场景零候选 → 零输出列表；shouldReject 零候选不算', () => {
  const silent = SCEN({ scenarioId: 'S2', events: [{ eventId: 'm2', role: 'user', ts: 't', text: '好的。' }], gold: [GOLD({ goldId: 'g2' })] });
  const reject = SCEN({ scenarioId: 'S3', events: [{ eventId: 'm3', role: 'user', ts: 't', text: '好的好的好的好的好的好的好的好的' }], shouldReject: { reason: 'chitchat' }, gold: [] });
  const r = scoreRun({ candidates: [CAND()], scenarios: [SCEN(), silent, reject], manifest: { stage: 'pilot' } });
  assert.deepEqual(r.zeroOutput, ['S2'], 'S1 有 TP 不算零输出');
  assert.equal(r.totals.fn, 1);
  const r2 = scoreRun({ candidates: [], scenarios: [SCEN(), silent, reject], manifest: { stage: 'pilot' } });
  assert.deepEqual(r2.zeroOutput, ['S1', 'S2']);
  assert.equal(r2.totals.fn, 2);
});

test('mixed 场景同时计入 zh 与 en 两组', () => {
  const m = SCEN({ language: 'mixed' });
  const r = scoreRun({ candidates: [CAND()], scenarios: [m], manifest: { stage: 'pilot' } });
  assert.equal(r.groups.zh.tp, 1);
  assert.equal(r.groups.en.tp, 1);
});

test('pilot fail-closed：verdict 必须为 null 且有说明', () => {
  const r = scoreRun({ candidates: [CAND()], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.equal(r.verdict, null);
  assert.ok(r.note.includes('pilot'));
});

test('block 对抗：候选命中对抗 target 即计 block-violation', () => {
  const adv = { class: 'negation', target: { eventId: 'm1', quote: '连接池已提升到 200' }, expectedOutcome: 'block', expectedErrorClass: 'negation-flip' };
  const r = scoreRun({ candidates: [CAND()], scenarios: [SCEN({ adversarial: adv })], manifest: { stage: 'pilot' } });
  assert.equal(r.adversarial.blockViolations, 1);
});

test('家族计数按 scenario.family 聚合', () => {
  const r = scoreRun({ candidates: [CAND()], scenarios: [SCEN()], manifest: { stage: 'pilot' } });
  assert.deepEqual(r.families, [{ family: 'fam-a', scenarios: 1, tp: 1, fp: 0, fn: 0 }]);
});
