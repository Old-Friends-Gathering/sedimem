import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkAssertion } from '../tools/assertion-checks.mjs';

// Helpers -----------------------------------------------------------------
const claim = (over = {}) => ({
  claim: '示例断言',
  type: 'task-state',
  assertion: { speechAct: 'state', negated: false, about: 'demo' },
  status: 'confirmed',
  ...over,
});
const ev = (over = {}) => ({ eventId: 'e1', quote: '已完成了', role: 'user', ...over });

// input -------------------------------------------------------------------
test('input: 缺失 claim / assertion / evidence 返回 ok=false 且 check=input，不抛异常', () => {
  for (const bad of [null, undefined, {}]) {
    const r = checkAssertion(bad);
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].check, 'input');
    assert.ok(r.violations[0].reason.length > 0);
  }
  const noAssertion = checkAssertion({ claim: { claim: 'x', type: 't' }, evidence: [ev()] });
  assert.equal(noAssertion.ok, false);
  assert.equal(noAssertion.violations[0].check, 'input');
  const noEvidence = checkAssertion({ claim: claim(), evidence: [] });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.violations[0].check, 'input');
});

// speaker -----------------------------------------------------------------
test('speaker: assertion 未声明 speaker 时不违规', () => {
  const r = checkAssertion({ claim: claim(), evidence: [ev({ role: 'assistant' })] });
  assert.equal(r.ok, true);
});

test('speaker: speaker=user 且证据 role=user 一致通过', () => {
  const r = checkAssertion({
    claim: claim({ assertion: { speechAct: 'state', negated: false, about: 'x', speaker: 'user' } }),
    evidence: [ev({ role: 'user' })],
  });
  assert.equal(r.ok, true);
});

test('speaker: speaker=tool 且证据 role=tool 通过；role=user 违规', () => {
  const a = { speechAct: 'state', negated: false, about: 'x', speaker: 'tool' };
  const ok = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'tool' })] });
  assert.equal(ok.ok, true);
  const bad = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'user' })] });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].check, 'speaker');
});

test('speaker: speaker=tool:git 且 role=tool:git 通过；role=tool 无 toolName 时也通过；role=tool:web 违规', () => {
  const a = { speechAct: 'state', negated: false, about: 'x', speaker: 'tool:git' };
  const ok1 = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'tool:git' })] });
  assert.equal(ok1.ok, true);
  const ok2 = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'tool' })] });
  assert.equal(ok2.ok, true);
  const ok3 = checkAssertion({
    claim: claim({ assertion: { ...a, toolName: 'git' } }),
    evidence: [ev({ role: 'tool' })],
  });
  assert.equal(ok3.ok, true);
  const bad = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'tool:web' })] });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].check, 'speaker');
});

test('speaker: role=assistant 且 speaker=user 且引文含「用户说」→ 违规（应标 quoted）', () => {
  const r = checkAssertion({
    claim: claim({ assertion: { speechAct: 'state', negated: false, about: 'x', speaker: 'user' } }),
    evidence: [ev({ role: 'assistant', quote: '用户说：明天不发布' })],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].check, 'speaker');
});

test('speaker: quoted 角色与任何 speaker 声明不冲突', () => {
  const r = checkAssertion({
    claim: claim({ assertion: { speechAct: 'state', negated: false, about: 'x', speaker: 'user' } }),
    evidence: [ev({ role: 'quoted' })],
  });
  assert.equal(r.ok, true);
});

// negated -----------------------------------------------------------------
test('negated: quote 含「没有」而 negated=false → 违规；negated=true 通过', () => {
  const a = { speechAct: 'state', negated: false, about: 'x' };
  const bad = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ quote: '没有做这件事' })] });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].check, 'negated');
  const good = checkAssertion({
    claim: claim({ assertion: { ...a, negated: true } }),
    evidence: [ev({ quote: '没有做这件事' })],
  });
  assert.equal(good.ok, true);
});

test('negated: quote 无否定标记而 negated=true → 违规', () => {
  const r = checkAssertion({
    claim: claim({ assertion: { speechAct: 'state', negated: true, about: 'x' } }),
    evidence: [ev({ quote: '任务已经完成' })],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].check, 'negated');
});

test('negated: 边界词「不仅/不过/不确定/not only」不视为否定标记', () => {
  for (const q of ['不仅要测试', '不过是小事', '还不确定方案', 'not only finished the report']) {
    const r = checkAssertion({
      claim: claim({ assertion: { speechAct: 'state', negated: false, about: 'x' } }),
      evidence: [ev({ quote: q })],
    });
    assert.equal(r.ok, true, `quote="${q}" 不应触发 negated 违规`);
  }
});

test('negated: 英文 never/not/no 标记生效', () => {
  const bad = checkAssertion({
    claim: claim({ assertion: { speechAct: 'state', negated: false, about: 'x' } }),
    evidence: [ev({ quote: 'he never approved it' })],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].check, 'negated');
});

// speechAct=suggest ---------------------------------------------------------
test('suggest: quote 含建议式且 status 非 suggestion-only/conditional → 违规；status=suggestion-only 通过', () => {
  const a = { speechAct: 'suggest', negated: false, about: 'x' };
  const bad = checkAssertion({ claim: claim({ assertion: a, status: 'confirmed' }), evidence: [ev({ quote: '建议用方案B' })] });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].check, 'speechAct-suggest');
  for (const s of ['suggestion-only', 'conditional']) {
    const good = checkAssertion({ claim: claim({ assertion: a, status: s }), evidence: [ev({ quote: '建议用方案B' })] });
    assert.equal(good.ok, true, `status=${s} 应通过`);
  }
});

// speechAct=complete --------------------------------------------------------
test('complete: type 非 task-state → 违规', () => {
  const r = checkAssertion({
    claim: claim({ type: 'fact', assertion: { speechAct: 'complete', negated: false, about: 'x' } }),
    evidence: [ev({ role: 'tool' })],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].check, 'speechAct-complete');
});

test('complete: 工具输出证据通过；用户确认（含 已/完成/确认）通过', () => {
  const a = { speechAct: 'complete', negated: false, about: 'x' };
  const t = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'tool:ci', quote: 'build succeeded' })] });
  assert.equal(t.ok, true);
  const u = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'user', quote: '确认交付' })] });
  assert.equal(u.ok, true);
});

test('complete: 助手自称完成（role=assistant）→ 违规；用户未确认字样 → 违规', () => {
  const a = { speechAct: 'complete', negated: false, about: 'x' };
  const asst = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'assistant', quote: '我已经完成了' })] });
  assert.equal(asst.ok, false);
  assert.equal(asst.violations[0].check, 'speechAct-complete');
  const uPlain = checkAssertion({ claim: claim({ assertion: a }), evidence: [ev({ role: 'user', quote: '看起来还行' })] });
  assert.equal(uPlain.ok, false);
  assert.equal(uPlain.violations[0].check, 'speechAct-complete');
});

// speechAct=retract ---------------------------------------------------------
test('retract: quote 含撤回式且 status!=retracted → 违规；status=retracted 通过', () => {
  const a = { speechAct: 'retract', negated: false, about: 'x' };
  const bad = checkAssertion({ claim: claim({ assertion: a, status: 'confirmed' }), evidence: [ev({ quote: '刚才说错了，撤回' })] });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].check, 'speechAct-retract');
  const good = checkAssertion({ claim: claim({ assertion: a, status: 'retracted' }), evidence: [ev({ quote: '刚才说错了，撤回' })] });
  assert.equal(good.ok, true);
});

// 多证据 --------------------------------------------------------------------
test('多证据：任一证据不符即 ok=false，violations 逐条记录', () => {
  const r = checkAssertion({
    claim: claim({ assertion: { speechAct: 'state', negated: false, about: 'x', speaker: 'user' } }),
    evidence: [ev({ eventId: 'e1', role: 'user' }), ev({ eventId: 'e2', role: 'tool' })],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].check, 'speaker');
});

// —— B7 审核 M9/M10 回归：否定误报与「疑问句当确认」 ——
test('negated: note/cannot/没错 等子串不得被当否定标记（M9 回归）', () => {
  for (const q of ['note: port is 8080', 'the note says 8080', '没错，这个方案没问题', '没问题，照旧']) {
    const r = checkAssertion({
      claim: claim({ assertion: { speechAct: 'state', negated: false, about: 'x' } }),
      evidence: [ev({ quote: q })],
    });
    assert.equal(r.ok, true, `quote="${q}" 不应被判否定`);
  }
});

test('negated: 真正的英文/中文否定仍必须被识别', () => {
  for (const q of ['it does not work', 'never deployed', '还没有上线', 'we cannot reproduce it']) {
    const r = checkAssertion({
      claim: claim({ assertion: { speechAct: 'state', negated: false, about: 'x' } }),
      evidence: [ev({ quote: q })],
    });
    assert.equal(r.ok, false, `quote="${q}" 应判否定违规`);
  }
});

test('speechAct=complete：疑问句「完成了吗」不构成用户确认（M10 回归）', () => {
  const r = checkAssertion({
    claim: claim({ type: 'task-state', assertion: { speechAct: 'complete', about: 'x' } }),
    evidence: [ev({ role: 'user', quote: '完成了吗' })],
  });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].check, 'speechAct-complete');
});

test('speechAct=complete：用户明确确认「已完成，确认」构成证据', () => {
  const r = checkAssertion({
    claim: claim({ type: 'task-state', assertion: { speechAct: 'complete', about: 'x' } }),
    evidence: [ev({ role: 'user', quote: '已完成，确认' })],
  });
  assert.equal(r.ok, true);
});

test('speechAct=complete：英文疑问式（无问号）也不算确认（B6 回归）', () => {
  for (const q of ['is everything finished', 'did you complete the deploy', '完成了没有呢']) {
    const r = checkAssertion({
      claim: claim({ type: 'task-state', assertion: { speechAct: 'complete', about: 'x' } }),
      evidence: [ev({ role: 'user', quote: q })],
    });
    assert.equal(r.ok, false, `"${q}" 是提问，不应算确认`);
  }
});
