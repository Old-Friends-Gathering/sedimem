// annotation-pass.mjs 单元测试（TDD：先红后绿）
// 覆盖：盲评包导出（剥离 gold 侧字段）/ 导入校验 / 一致性对比 / 裁决工作表
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlindPackage,
  importBlindAnnotation,
  agreementReport,
  adjudicationWorksheet,
} from '../tools/annotation-pass.mjs';

const mkScenario = (id, overrides = {}) => ({
  scenarioId: id,
  family: 'fam-deploy-rollout',
  language: 'zh',
  split: 'dev',
  source: { kind: 'dsh-transcript', sourceEpoch: 1 },
  events: [
    { eventId: `${id}-m001`, role: 'user', ts: '2026-11-18T09:00:00Z', text: '把超时时间调到 30 秒' },
    { eventId: `${id}-m002`, role: 'assistant', ts: '2026-11-18T09:01:00Z', text: '已改为 30 秒。' },
  ],
  gold: [{
    goldId: `${id}-g01`, claim: '服务超时时间已调整为 30 秒', role: 'assistant', type: 'fact',
    scope: 'repo:demo', status: 'active',
    assertion: { speechAct: 'state', negated: false, about: '超时配置', condition: null },
    time: { observedAt: '2026-11-18T09:01:00Z', assertedValidFrom: '2026-11-18T09:01:00Z', assertedValidTo: null },
    evidence: [{ eventId: `${id}-m002`, quote: '已改为 30 秒' }],
    language: 'zh',
  }],
  shouldReject: null,
  adversarial: null,
  ...overrides,
});

const GOLD_KEYS = ['gold', 'shouldReject', 'adversarial', 'split', 'expectedOutcome', 'expectedErrorClass'];

function hasGoldSideField(obj, path = '') {
  if (Array.isArray(obj)) return obj.some((v, i) => hasGoldSideField(v, `${path}[${i}]`));
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (GOLD_KEYS.includes(k)) return `${path}.${k}`;
      const hit = hasGoldSideField(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

test('buildBlindPackage：剥离全部 gold 侧字段，保留事件与场景元数据', () => {
  const pkg = buildBlindPackage([mkScenario('S001'), mkScenario('S002')]);
  assert.equal(pkg.scenarios.length, 2);
  for (const s of pkg.scenarios) {
    assert.equal(hasGoldSideField(s), null, `场景 ${s.scenarioId} 泄漏 gold 侧字段：${hasGoldSideField(s)}`);
    assert.ok(s.events.length >= 1);
    assert.equal(s.family, 'fam-deploy-rollout');
  }
  assert.equal(pkg.manifest.annotationMode, 'dual-independent');
  assert.ok(pkg.manifest.blindPass, '必须有 blindPass 标识');
  assert.ok(pkg.manifest.generatedAt, '必须有生成时间');
  assert.ok(pkg.manifest.corpusScenarios >= 2);
});

test('importBlindAnnotation：通过校验；缺场景/坏枚举被拒', () => {
  const pkg = buildBlindPackage([mkScenario('S001')]);
  const good = [{
    scenarioId: 'S001',
    gold: [{ goldId: 'B-S001-g01', claim: '超时改成了 30 秒', role: 'assistant', type: 'fact', scope: 'repo:demo', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null }, evidence: [{ eventId: 'S001-m002', quote: '已改为 30 秒' }] }],
    shouldReject: null, adversarial: null,
  }];
  const ok = importBlindAnnotation(good, pkg);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.annotationMode, 'dual-independent');
  // 缺场景
  const missing = importBlindAnnotation([{ scenarioId: 'S999', gold: [], shouldReject: null, adversarial: null }], pkg);
  assert.ok(missing.errors.some((e) => e.includes('S999')));
  // 坏枚举
  const badType = importBlindAnnotation([{ scenarioId: 'S001', gold: [{ goldId: 'x', claim: 'c', role: 'user', type: 'rumor', scope: 's', status: 'active', assertion: {}, evidence: [] }], shouldReject: null, adversarial: null }], pkg);
  assert.ok(badType.errors.some((e) => e.includes('type')));
});

test('agreementReport：完全一致 → 全 match 且字段一致率 1.0；annotationMode 标注', () => {
  const gold = (claim) => [{ goldId: 'g1', claim, role: 'assistant', type: 'fact', scope: 'repo:demo', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null } }];
  const rep = agreementReport(
    [{ scenarioId: 'S001', gold: gold('超时已改为 30 秒'), shouldReject: null, adversarial: null }],
    [{ scenarioId: 'S001', gold: gold('超时已改为 30 秒'), shouldReject: null, adversarial: null }],
  );
  assert.equal(rep.totals.both, 1);
  assert.equal(rep.totals.aOnly, 0);
  assert.equal(rep.totals.bOnly, 0);
  assert.equal(rep.annotationMode, 'dual-independent');
  assert.ok(!('verdict' in rep), '工具不得产出 pass/fail 裁决（fail-closed，出口判断归人）');
});

test('agreementReport：分歧 → aOnly/bOnly 计数正确；字段分歧进入 fieldDisagreements', () => {
  const mk = (claim, type) => [{ goldId: 'g1', claim, role: 'assistant', type, scope: 'repo:demo', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null } }];
  const rep = agreementReport(
    [{ scenarioId: 'S001', gold: mk('超时已改为 30 秒', 'fact'), shouldReject: null, adversarial: null }],
    [
      { scenarioId: 'S001', gold: mk('超时已改为 30 秒', 'task-state'), shouldReject: null, adversarial: null },
      { scenarioId: 'S001', gold: mk('B 独有命题', 'fact'), shouldReject: null, adversarial: null },
    ],
  );
  assert.equal(rep.totals.both, 1);
  assert.equal(rep.totals.aOnly, 0);
  assert.equal(rep.totals.bOnly, 1);
  assert.ok(rep.totals.fieldAgreement < 1, '同 claim 不同 type 必须拉低字段一致率');
  assert.ok(rep.perScenario['S001'].fieldDisagreements.some((d) => d.field === 'type'));
});

test('agreementReport：shouldReject 分歧也要计数（无可记 vs 有 gold 是关键分歧）', () => {
  const rep = agreementReport(
    [{ scenarioId: 'S004', gold: [], shouldReject: { reason: 'chitchat' }, adversarial: null }],
    [{ scenarioId: 'S004', gold: [{ goldId: 'g1', claim: '寒暄里的事实', role: 'user', type: 'fact', scope: 's', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null } }], shouldReject: null, adversarial: null }],
  );
  assert.ok(rep.perScenario['S004'].fieldDisagreements.some((d) => d.field === 'shouldReject'));
});

test('adjudicationWorksheet：只为分歧场景产出裁决行；初始 resolution 均为 null 待人工填写', () => {
  const a = [{ scenarioId: 'S001', gold: [{ goldId: 'g1', claim: '甲说的事实', role: 'user', type: 'fact', scope: 's', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null } }], shouldReject: null, adversarial: null }];
  const b = [{ scenarioId: 'S001', gold: [{ goldId: 'g1', claim: '乙说的事实', role: 'user', type: 'fact', scope: 's', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null } }], shouldReject: null, adversarial: null }];
  const ws = adjudicationWorksheet(a, b);
  assert.ok(ws.rows.length >= 1);
  for (const row of ws.rows) {
    assert.ok('resolution' in row, '每行必须有 resolution 空位留给裁决人');
    assert.equal(row.resolution, null, '初始 resolution 必须为 null（人工填）');
    assert.ok(row.claimA || row.claimB || row.rejectA || row.rejectB, '裁决行必须能看出双方主张');
  }
});

test('F2：同遍同归一化键多条 claim 不再互相覆盖（both=1, aOnly=1），工作表出 claim-only-in-A 行', () => {
  const mk = (claim, type) => ({ goldId: 'g1', claim, role: 'assistant', type, scope: 'repo:demo', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null } });
  const passA = [{ scenarioId: 'S001', gold: [mk('同句A', 'fact'), mk('同句A', 'decision')], shouldReject: null, adversarial: null }];
  const passB = [{ scenarioId: 'S001', gold: [mk('同句A', 'fact')], shouldReject: null, adversarial: null }];
  const rep = agreementReport(passA, passB);
  assert.equal(rep.totals.both, 1);
  assert.equal(rep.totals.aOnly, 1);
  assert.equal(rep.totals.bOnly, 0);
  const ws = adjudicationWorksheet(passA, passB);
  assert.ok(ws.rows.some((r) => r.kind === 'claim-only-in-A' && r.scenarioId === 'S001'),
    `工作表必须有 claim-only-in-A 行，实际：${JSON.stringify(ws.rows)}`);
});

test('F6：归一化碰撞（同键不同原文）进入 normalizedKeyCollisions 供裁决人复核', () => {
  const mk = (claim) => ({ goldId: 'g1', claim, role: 'assistant', type: 'fact', scope: 'repo:demo', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null } });
  const rep = agreementReport(
    [{ scenarioId: 'S001', gold: [mk('v1.2 已发布'), mk('v1 2 已发布')], shouldReject: null, adversarial: null }],
    [{ scenarioId: 'S001', gold: [mk('v1.2 已发布')], shouldReject: null, adversarial: null }],
  );
  assert.ok(rep.normalizedKeyCollisions.length === 1, `应报告 1 条碰撞，实际：${JSON.stringify(rep.normalizedKeyCollisions)}`);
  const c = rep.normalizedKeyCollisions[0];
  assert.equal(c.scenarioId, 'S001');
  assert.ok(c.claims.includes('v1.2 已发布') && c.claims.includes('v1 2 已发布'));
  assert.ok(c.key.length > 0);
});

test('F7①：同场景多行 shouldReject reason 冲突不再静默取首个，进 fieldDisagreements 与 shouldRejectConflicts', () => {
  const pass = [
    { scenarioId: 'S001', gold: [], shouldReject: { reason: 'chitchat' }, adversarial: null },
    { scenarioId: 'S001', gold: [], shouldReject: { reason: 'no-new-info' }, adversarial: null },
  ];
  const rep = agreementReport(pass, [{ scenarioId: 'S001', gold: [], shouldReject: { reason: 'chitchat' }, adversarial: null }]);
  assert.ok(rep.shouldRejectConflicts.length === 1, `应有 1 条冲突，实际：${JSON.stringify(rep.shouldRejectConflicts)}`);
  assert.equal(rep.shouldRejectConflicts[0].scenarioId, 'S001');
  assert.deepEqual(rep.shouldRejectConflicts[0].reasons, ['chitchat', 'no-new-info']);
  assert.ok(rep.perScenario['S001'].fieldDisagreements.some((d) => d.field === 'shouldReject' && d.a === 'chitchat' && d.b === 'no-new-info'));
});

test('F7②：双方均 null 的字段不计入一致率（fieldAtoms 排除双 null），bothNullAtoms 单独计数', () => {
  const mk = (cond) => ({ goldId: 'g1', claim: '同句A', role: 'assistant', type: 'fact', scope: 'repo:demo', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: cond } });
  // assertion.condition 一方有值一方 null；scope 一方 null 一方非 null。
  const ga = { ...mk('cond-x') }; ga.assertion = { speechAct: 'state', negated: false, about: 'x', condition: 'cond-x' };
  const gb = { ...mk(null) }; gb.scope = undefined; // scope → null
  const rep = agreementReport(
    [{ scenarioId: 'S001', gold: [ga], shouldReject: null, adversarial: null }],
    [{ scenarioId: 'S001', gold: [gb], shouldReject: null, adversarial: null }],
  );
  // 8 个比较字段：role/type/speechAct/negated/about 一致（5），status 双方 active 一致，
  // scope（x vs null）与 condition（x vs null）各为「一方 null」→ 计入且不一致。
  assert.equal(rep.totals.fieldAtoms, 8);
  assert.equal(rep.totals.fieldAgreement, 6 / 8);
  // 再造纯双 null：about/condition 双方都 null。
  const mk2 = () => ({ goldId: 'g', claim: '同句A', role: 'assistant', type: 'fact', status: 'active', assertion: { speechAct: 'state', negated: false } });
  const rep2 = agreementReport(
    [{ scenarioId: 'S002', gold: [mk2()], shouldReject: null, adversarial: null }],
    [{ scenarioId: 'S002', gold: [mk2()], shouldReject: null, adversarial: null }],
  );
  // scope/about/condition 均 null-null → 3 个 bothNull，不计入 fieldAtoms。
  assert.equal(rep2.totals.fieldAtoms, 5);
  assert.equal(rep2.totals.bothNullAtoms, 3);
  assert.equal(rep2.totals.fieldAgreement, 1);
});

test('F8 边界：双方都无 gold → fieldAgreement=null（不强行算 0 或 1）', () => {
  const rep = agreementReport(
    [{ scenarioId: 'S001', gold: [], shouldReject: null, adversarial: null }],
    [{ scenarioId: 'S001', gold: [], shouldReject: null, adversarial: null }],
  );
  assert.equal(rep.totals.fieldAgreement, null);
  assert.equal(rep.totals.both, 0);
});

test('F8 边界：同场景多行（分片标注）合并后参与对比', () => {
  const mk = (claim, id) => ({ goldId: id, claim, role: 'assistant', type: 'fact', scope: 'repo:demo', status: 'active', assertion: { speechAct: 'state', negated: false, about: 'x', condition: null } });
  const rep = agreementReport(
    [
      { scenarioId: 'S001', gold: [mk('命题一', 'g1')], shouldReject: null, adversarial: null },
      { scenarioId: 'S001', gold: [mk('命题二', 'g2')], shouldReject: null, adversarial: null },
    ],
    [{ scenarioId: 'S001', gold: [mk('命题一', 'g1'), mk('命题二', 'g2')], shouldReject: null, adversarial: null }],
  );
  assert.equal(rep.totals.both, 2);
  assert.equal(rep.totals.aOnly, 0);
  assert.equal(rep.totals.bOnly, 0);
  assert.equal(rep.totals.fieldAgreement, 1);
});

test('F9：坏 speechAct / 坏 status 报错且错误信息含字段名', () => {
  const pkg = buildBlindPackage([mkScenario('S001')]);
  const mkRow = (g) => [{ scenarioId: 'S001', gold: [g], shouldReject: null, adversarial: null }];
  const badSpeechAct = importBlindAnnotation(mkRow({ goldId: 'x', claim: 'c', role: 'user', type: 'fact', scope: 's', status: 'active', assertion: { speechAct: 'guess' }, evidence: [] }), pkg);
  assert.ok(badSpeechAct.errors.some((e) => e.includes('speechAct')), `错误应含 'speechAct'，实际：${JSON.stringify(badSpeechAct.errors)}`);
  const badStatus = importBlindAnnotation(mkRow({ goldId: 'x', claim: 'c', role: 'user', type: 'fact', scope: 's', status: 'deleted', assertion: { speechAct: 'state' }, evidence: [] }), pkg);
  assert.ok(badStatus.errors.some((e) => e.includes('status')), `错误应含 'status'，实际：${JSON.stringify(badStatus.errors)}`);
  // 合法枚举通过。
  const good = importBlindAnnotation(mkRow({ goldId: 'x', claim: 'c', role: 'user', type: 'fact', scope: 's', status: 'suggestion-only', assertion: { speechAct: 'decide' }, evidence: [] }), pkg);
  assert.equal(good.errors.length, 0);
});
