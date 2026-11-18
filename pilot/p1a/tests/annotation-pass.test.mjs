// annotation-pass.mjs 单元测试（TDD：先红后绿）
// 覆盖：盲评包导出（剥离 gold 侧字段）/ 导入校验 / 一致性对比 / 裁决工作表
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlindPackage,
  importBlindAnnotation,
  agreementReport,
  adjudicationWorksheet,
  buildGoldset,
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

// ---------- buildGoldset（P1a 出口：裁决表 → 版本化 goldset） ----------
const G = (claim, extra = {}) => ({
  goldId: `g-${claim}`, claim, role: 'assistant', type: 'fact', scope: 'repo:demo',
  status: 'active', assertion: { speechAct: 'state', negated: false, about: null, condition: null },
  time: { observedAt: '2026-11-18T09:01:00Z' }, evidence: [{ eventId: 'S001-m002', quote: '已改为 30 秒' }],
  language: 'zh', ...extra,
});
const PASS = (sid, gold, shouldReject = false) => [{ scenarioId: sid, shouldReject, reason: shouldReject ? '无可记' : '', gold }];

test('goldset：两份完全一致时直接采用 A 侧，adjudicated=0，annotationMode=dual-independent', () => {
  const a = PASS('S001', [G('超时已改为 30 秒')]);
  const r = buildGoldset(a, a, { annotationMode: 'dual-independent', rows: [], pending: 0 }, { clock: () => new Date('2026-11-18T12:00:00Z') });
  assert.equal(r.errors.length, 0, `不应有错误：${JSON.stringify(r.errors)}`);
  assert.equal(r.goldset.annotationMode, 'dual-independent');
  assert.equal(r.goldset.goldsetVersion, 'goldset-v1');
  assert.equal(r.goldset.frozenAt, '2026-11-18T12:00:00.000Z');
  assert.equal(r.goldset.scenarios.length, 1);
  assert.equal(r.goldset.scenarios[0].gold.length, 1);
  assert.equal(r.goldset.stats.adjudicated, 0);
});

test('goldset：裁决表还有 resolution=null 的行 → 拒绝产出（fail-closed）', () => {
  const ws = { annotationMode: 'dual-independent', rows: [{ scenarioId: 'S001', kind: 'field-mismatch', fields: ['type'], resolution: null }], pending: 1 };
  const r = buildGoldset(PASS('S001', [G('x')]), PASS('S001', [G('x', { type: 'decision' })]), ws);
  assert.equal(r.goldset, null, '未裁决时不得产出 goldset');
  assert.ok(r.errors.some((e) => e.includes('未裁决')), `错误应提示未裁决，实际：${JSON.stringify(r.errors)}`);
});

test('goldset：非法 resolution 值 → 报错并拒绝产出', () => {
  const ws = { annotationMode: 'dual-independent', rows: [{ scenarioId: 'S001', kind: 'field-mismatch', fields: ['type'], resolution: 'maybe' }], pending: 0 };
  const r = buildGoldset(PASS('S001', [G('x')]), PASS('S001', [G('x', { type: 'decision' })]), ws);
  assert.equal(r.goldset, null);
  assert.ok(r.errors.some((e) => e.includes('非法 resolution')), `错误应含「非法 resolution」，实际：${JSON.stringify(r.errors)}`);
});

test('goldset：字段分歧裁决为 b → 采用 B 侧的字段值', () => {
  const ws = { annotationMode: 'dual-independent', rows: [{ scenarioId: 'S001', kind: 'field-mismatch', fields: ['type'], resolution: 'b' }], pending: 0 };
  const r = buildGoldset(
    PASS('S001', [G('超时已改为 30 秒', { type: 'fact' })]),
    PASS('S001', [G('超时已改为 30 秒', { type: 'decision' })]),
    ws,
  );
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.goldset.scenarios[0].gold[0].type, 'decision', 'resolution=b 应取 B 的 type');
  assert.equal(r.goldset.stats.adjudicated, 1);
});

test('goldset：仅 A 有的 claim 裁决为 b → 丢弃该 claim（计入 droppedA）', () => {
  const ws = { annotationMode: 'dual-independent', rows: [{ scenarioId: 'S001', kind: 'claim-only-in-A', resolution: 'b' }], pending: 0 };
  const r = buildGoldset(PASS('S001', [G('只有 A 说的事实')]), PASS('S001', []), ws);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.goldset.scenarios[0].gold.length, 0, '裁决为 b 时 A 独有 claim 应被丢弃');
  assert.equal(r.goldset.stats.droppedA, 1);
});

test('goldset：仅 B 有的 claim 裁决为 both → 两条都保留', () => {
  const ws = { annotationMode: 'dual-independent', rows: [{ scenarioId: 'S001', kind: 'claim-only-in-B', resolution: 'both' }], pending: 0 };
  const r = buildGoldset(PASS('S001', [G('共同事实')]), PASS('S001', [G('共同事实'), G('只有 B 说的事实')]), ws);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.goldset.scenarios[0].gold.length, 2, 'resolution=both 时两边 claim 都保留');
});

test('goldset：shouldReject 分歧裁决为 a → 采用 A 的判定，且保留 reason', () => {
  const ws = { annotationMode: 'dual-independent', rows: [{ scenarioId: 'S001', kind: 'reject-mismatch', rejectA: true, rejectB: false, resolution: 'a' }], pending: 0 };
  const r = buildGoldset(PASS('S001', [], true), PASS('S001', [G('不该记的事')]), ws);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.goldset.scenarios[0].shouldReject, true);
  assert.equal(r.goldset.scenarios[0].gold.length, 0);
});

test('goldset：缺场景（只在一边出现）→ 报错', () => {
  const ws = { annotationMode: 'dual-independent', rows: [], pending: 0 };
  const r = buildGoldset(PASS('S001', [G('a')]), PASS('S002', [G('b')]), ws);
  assert.equal(r.goldset, null);
  assert.ok(r.errors.some((e) => e.includes('缺场景')), `错误应含「缺场景」，实际：${JSON.stringify(r.errors)}`);
});


// ---------- B4②：goldset 生成（裁决落地 → 可版本化 goldset-vN） ----------
const g = (claim, over = {}) => ({
  goldId: 'g', claim, role: 'assistant', type: 'fact', scope: 'repo:demo', status: 'active',
  assertion: { speechAct: 'state', negated: false, about: 'x', condition: null },
  evidence: [], language: 'zh', ...over,
});
const PASS2 = (sid, gold, shouldReject = false, reason = '') => [{ scenarioId: sid, gold, shouldReject, reason }];

test('buildGoldset：双份完全一致时直接产出，且不产生待裁决计数', () => {
  const a = PASS2('S001', [g('超时已改为 30 秒')]);
  const b = PASS2('S001', [g('超时已改为 30 秒')]);
  const ws = adjudicationWorksheet(a, b);
  const r = buildGoldset(a, b, ws);
  assert.deepEqual(r.errors, []);
  assert.equal(r.goldset.annotationMode, 'dual-independent');
  assert.equal(r.goldset.goldsetVersion, 'goldset-v1');
  assert.ok(r.goldset.frozenAt);
  assert.equal(r.goldset.scenarios[0].gold.length, 1);
  assert.equal(r.goldset.stats.adjudicated, 0);
});

test('buildGoldset：裁决表存在未裁决行时拒绝产出（fail-closed）', () => {
  const a = PASS2('S001', [g('超时已改为 30 秒', { type: 'fact' })]);
  const b = PASS2('S001', [g('超时已改为 30 秒', { type: 'decision' })]);
  const ws = adjudicationWorksheet(a, b);
  assert.ok(ws.pending > 0, '构造的分歧应产生待裁决行');
  const r = buildGoldset(a, b, ws);
  assert.equal(r.goldset, null);
  assert.ok(r.errors.some((e) => e.includes('未裁决')), `错误应含「未裁决」，实际：${JSON.stringify(r.errors)}`);
});

test('buildGoldset：field-mismatch 判 b 时采用 B 的字段值', () => {
  const a = PASS2('S001', [g('超时已改为 30 秒', { type: 'fact' })]);
  const b = PASS2('S001', [g('超时已改为 30 秒', { type: 'decision' })]);
  const ws = adjudicationWorksheet(a, b);
  for (const row of ws.rows) row.resolution = 'b';
  const r = buildGoldset(a, b, ws);
  assert.deepEqual(r.errors, []);
  assert.equal(r.goldset.scenarios[0].gold[0].type, 'decision');
  assert.equal(r.goldset.stats.adjudicated, ws.rows.length);
});

test('buildGoldset：claim-only-in-A 判 b 表示丢弃 A 的独有 claim', () => {
  const a = PASS2('S001', [g('A 独有命题'), g('共有命题')]);
  const b = PASS2('S001', [g('共有命题')]);
  const ws = adjudicationWorksheet(a, b);
  for (const row of ws.rows) row.resolution = 'b';
  const r = buildGoldset(a, b, ws);
  const claims = r.goldset.scenarios[0].gold.map((x) => x.claim);
  assert.ok(!claims.includes('A 独有命题'), `不应保留 A 独有 claim，实际：${JSON.stringify(claims)}`);
  assert.equal(r.goldset.stats.droppedA, 1);
});

test('buildGoldset：claim-only-in-B 判 both 时两边 claim 都保留', () => {
  const a = PASS2('S001', [g('共有命题')]);
  const b = PASS2('S001', [g('共有命题'), g('B 独有命题')]);
  const ws = adjudicationWorksheet(a, b);
  for (const row of ws.rows) row.resolution = 'both';
  const r = buildGoldset(a, b, ws);
  assert.equal(r.goldset.scenarios[0].gold.length, 2);
});

test('buildGoldset：shouldReject 分歧按裁决取值', () => {
  const a = PASS2('S004', [], true, 'chitchat');
  const b = PASS2('S004', [g('寒暄里的事实')], false, '');
  const ws = adjudicationWorksheet(a, b);
  assert.ok(ws.rows.some((x) => x.kind === 'reject-mismatch'));
  for (const row of ws.rows) row.resolution = 'a';
  const r = buildGoldset(a, b, ws);
  assert.equal(r.goldset.scenarios[0].shouldReject, true);
});

test('buildGoldset：布尔形态 shouldReject 与对象形态等价识别（真实 pass 文件为布尔）', () => {
  const a = [{ scenarioId: 'S004', gold: [], shouldReject: true, reason: 'chitchat' }];
  const b = [{ scenarioId: 'S004', gold: [], shouldReject: { reason: 'chitchat' } }];
  const rep = agreementReport(a, b);
  assert.equal(rep.perScenario.S004.fieldDisagreements.length, 0, '布尔与对象同义时不应报分歧');
});

test('buildGoldset：非法 resolution 拒绝产出', () => {
  const a = PASS2('S001', [g('超时已改为 30 秒', { type: 'fact' })]);
  const b = PASS2('S001', [g('超时已改为 30 秒', { type: 'decision' })]);
  const ws = adjudicationWorksheet(a, b);
  for (const row of ws.rows) row.resolution = 'x';
  const r = buildGoldset(a, b, ws);
  assert.equal(r.goldset, null);
  assert.ok(r.errors.some((e) => e.includes('非法 resolution')), `错误应含「非法 resolution」，实际：${JSON.stringify(r.errors)}`);
});

// ---------- import 时的证据校验（quote 必须逐字出自盲评包事件） ----------
test('importBlindAnnotation：证据 eventId 不存在 / quote 非逐字子串 → 报错点名', () => {
  const pkg = {
    manifest: { blindPass: 'pass-2' },
    scenarios: [{ scenarioId: 'S1', events: [{ eventId: 'S1-m001', text: '连接池已提升到 200。' }] }],
  };
  const bad = [
    { scenarioId: 'S1', gold: [{ claim: '连接池提升', type: 'fact', evidence: [{ eventId: 'S1-m999', quote: '连接池已提升到 200' }] }] },
  ];
  const r1 = importBlindAnnotation(bad, pkg);
  assert.ok(r1.errors.some((e) => e.includes('S1-m999')), '未知 eventId 必须点名');

  const badQuote = [
    { scenarioId: 'S1', gold: [{ claim: '连接池提升', type: 'fact', evidence: [{ eventId: 'S1-m001', quote: '连接池已提升到 300' }] }] },
  ];
  const r2 = importBlindAnnotation(badQuote, pkg);
  assert.ok(r2.errors.some((e) => e.includes('quote') && e.includes('S1')), 'quote 非逐字子串必须点名');

  const ok = [
    { scenarioId: 'S1', gold: [{ claim: '连接池提升', type: 'fact', evidence: [{ eventId: 'S1-m001', quote: '连接池已提升到 200' }] }] },
  ];
  assert.deepEqual(importBlindAnnotation(ok, pkg).errors, []);
});

test('importBlindAnnotation：claim 超 100 字符 → 报错', () => {
  const pkg = { scenarios: [{ scenarioId: 'S1', events: [{ eventId: 'S1-m001', text: 'x' }] }] };
  const long = 'a'.repeat(101);
  const rows = [{ scenarioId: 'S1', gold: [{ claim: long, type: 'fact', evidence: [{ eventId: 'S1-m001', quote: 'x' }] }] }];
  const r = importBlindAnnotation(rows, pkg);
  assert.ok(r.errors.some((e) => e.includes('100')), '超长 claim 必须点名');
});

// ---------- 自动裁决（记录化的裁决策略，非人工） ----------
test('applyUnionPolicy：only-A→a、only-B→b、字段分歧→merge，并统计 confirmed 比例', async () => {
  const { applyUnionPolicy } = await import('../tools/adjudicate.mjs');
  const ws = {
    rows: [
      { scenarioId: 'S1', kind: 'claim-only-in-A', claimA: 'a1', claimB: null, resolution: null },
      { scenarioId: 'S1', kind: 'claim-only-in-B', claimA: null, claimB: 'b1', resolution: null },
      { scenarioId: 'S2', kind: 'field-mismatch', fields: ['type'], claimA: 'x', claimB: 'x', resolution: null },
    ],
  };
  const { rows, stats } = applyUnionPolicy(ws);
  assert.deepEqual(rows.map((r) => r.resolution), ['a', 'b', 'merge']);
  assert.equal(stats.rows, 3);
  assert.equal(stats.byResolution.a, 1);
  assert.equal(stats.byResolution.b, 1);
  assert.equal(stats.byResolution.merge, 1);
});

test('applyUnionPolicy：拒绝覆盖已有人工裁决（有 resolution 的行保持原样）', async () => {
  const { applyUnionPolicy } = await import('../tools/adjudicate.mjs');
  const ws = { rows: [{ scenarioId: 'S1', kind: 'claim-only-in-A', claimA: 'a1', claimB: null, resolution: 'both' }] };
  const { rows, stats } = applyUnionPolicy(ws);
  assert.equal(rows[0].resolution, 'both');
  assert.equal(stats.preserved, 1);
});
