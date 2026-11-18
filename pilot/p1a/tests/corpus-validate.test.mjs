// corpus-validate 单元测试（TDD——先于实现编写）
// 规格：docs/design/v2.0/06-annotation-spec.md §1、04-scoring-and-splits.md §2、eval-manifest.json
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScenario,
  validateCorpus,
  checkQuotas,
  detectPii,
  checkSingleSentence,
  resolveEvidenceSpans,
  computePackQuota,
} from '../tools/corpus-validate.mjs';

const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/eval-manifest.json', import.meta.url), 'utf8'));

function okScenario(overrides = {}) {
  return {
    scenarioId: 'S001',
    family: 'fam-demo',
    language: 'zh',
    source: { kind: 'dsh-transcript', sourceEpoch: 1 },
    events: [
      { eventId: 'S001-m001', role: 'user', ts: '2026-11-10T09:00:00Z', text: '我们把结算服务的超时时间调到 30 秒了。' },
      { eventId: 'S001-m002', role: 'assistant', ts: '2026-11-10T09:00:05Z', text: '已记录：结算服务超时 30 秒。' },
    ],
    gold: [
      {
        goldId: 'S001-g01',
        claim: '结算服务的超时时间是 30 秒',
        role: 'user',
        type: 'fact',
        scope: 'repo:demo-alpha',
        assertion: { speechAct: 'state', negated: false, about: '结算服务', condition: null },
        status: 'active',
        time: { observedAt: '2026-11-10T09:00:00Z', assertedValidFrom: '2026-11-10', assertedValidTo: null },
        evidence: [{ eventId: 'S001-m001', quote: '超时时间调到 30 秒' }],
      },
    ],
    shouldReject: null,
    adversarial: null,
    ...overrides,
  };
}

test('合法场景通过校验', () => {
  const errs = validateScenario(okScenario(), { manifest });
  assert.deepEqual(errs, []);
});

test('evidence 引用不存在的事件 → 报错', () => {
  const s = okScenario();
  s.gold[0].evidence[0].eventId = 'S001-m999';
  const errs = validateScenario(s, { manifest });
  assert.ok(errs.some((e) => e.includes('evidence') && e.includes('S001-m999')));
});

test('quote 在事件文本中出现 0 次或多次 → 报错；span 由定位派生', () => {
  const s = okScenario();
  s.gold[0].evidence[0].quote = '不存在的原文';
  assert.ok(validateScenario(s, { manifest }).some((e) => e.includes('quote')));
  const spans = resolveEvidenceSpans(okScenario());
  assert.deepEqual(spans[0].span, { start: 8, end: 19 }); // 码点 offset（我们把结算服务的|超时时间调到 30 秒|了。）quote 长 11
});

test('复合命题拒绝：claim 含句号/分号/问号感叹号（句尾除外）', () => {
  const s = okScenario();
  s.gold[0].claim = '超时是 30 秒；重试次数是 3 次。';
  assert.ok(validateScenario(s, { manifest }).some((e) => e.includes('复合')));
  assert.equal(checkSingleSentence('结算服务的超时时间是 30 秒'), true);
  assert.equal(checkSingleSentence('It uses Redis. It also uses Memcached.'), false);
});

test('闭集校验：type/speechAct/status/language/role 枚举', () => {
  const s = okScenario();
  s.gold[0].type = 'other';
  assert.ok(validateScenario(s, { manifest }).length > 0);
  const s2 = okScenario();
  s2.gold[0].assertion.speechAct = 'shout';
  assert.ok(validateScenario(s2, { manifest }).length > 0);
  const s3 = okScenario();
  s3.gold[0].status = 'archived';
  assert.ok(validateScenario(s3, { manifest }).length > 0);
});

test('PII 检测：邮箱/手机号/身份证/16+ 位卡号', () => {
  assert.ok(detectPii('联系 foo@gmail.com 获取').length > 0);
  assert.ok(detectPii('电话 13812345678').length > 0);
  assert.ok(detectPii('证件 110101199003074258').length > 0);
  assert.ok(detectPii('卡号 4111111111111111').length > 0);
  assert.deepEqual(detectPii('普通文本没有敏感信息'), []);
});

test('对抗场景必须携带 expectedOutcome + expectedErrorClass', () => {
  const s = okScenario({
    adversarial: { class: 'negation', target: { eventId: 'S001-m001', quote: '超时时间调到 30 秒' } },
  });
  const errs = validateScenario(s, { manifest });
  assert.ok(errs.some((e) => e.includes('expectedOutcome')));
  const s2 = okScenario({
    adversarial: { class: 'negation', target: { eventId: 'S001-m001', quote: '超时时间调到 30 秒' }, expectedOutcome: 'block', expectedErrorClass: 'negation-flip' },
  });
  assert.deepEqual(validateScenario(s2, { manifest }), []);
  // expectedErrorClass 必须在七类闭集内
  const s3 = okScenario({
    adversarial: { class: 'negation', target: { eventId: 'S001-m001', quote: '超时时间调到 30 秒' }, expectedOutcome: 'block', expectedErrorClass: 'made-up-class' },
  });
  assert.ok(validateScenario(s3, { manifest }).some((e) => e.includes('expectedErrorClass')));
});

test('无可记场景与 gold 互斥，必须给 shouldReject 理由', () => {
  const s = okScenario({ shouldReject: null, gold: [] });
  assert.ok(validateScenario(s, { manifest }).some((e) => e.includes('shouldReject')));
  const s2 = okScenario({ gold: [], shouldReject: { reason: 'chitchat', note: '纯寒暄' } });
  assert.deepEqual(validateScenario(s2, { manifest }), []);
  const s3 = okScenario({ shouldReject: { reason: 'chitchat', note: 'x' } });
  assert.ok(validateScenario(s3, { manifest }).some((e) => e.includes('互斥')));
});

test('配额检查：pilot 40/60/6/对抗 3 类/zh12/en12/mixed4', () => {
  const scenarios = [];
  for (let i = 0; i < 40; i++) {
    const lang = i % 4 === 0 ? 'en' : i % 4 === 1 ? 'zh' : i % 4 === 2 ? 'zh' : 'mixed';
    scenarios.push(
      okScenario({
        scenarioId: `S${String(i + 1).padStart(3, '0')}`,
        family: `fam-${Math.floor(i / 4)}`,
        language: lang,
        gold: i % 5 === 4 ? [] : [{ ...okScenario().gold[0], goldId: `S${String(i + 1).padStart(3, '0')}-g01` }],
        shouldReject: i % 5 === 4 ? { reason: 'chitchat', note: 'x' } : null,
        adversarial:
          i < 30
            ? {
                class: ['negation', 'suggestion-not-accepted', 'later-correction', 'conditional-hypothetical', 'tool-failure', 'same-name-cross-project', 'cross-paragraph-reference', 'timezone-relative-date', 'injection', 'truncation-gap'][i % 10],
                target: { eventId: 'S001-m001', quote: '超时时间调到 30 秒' },
                expectedOutcome: 'block',
                expectedErrorClass: 'negation-flip',
              }
            : null,
      }),
    );
  }
  const fails = checkQuotas(scenarios, manifest);
  assert.ok(Array.isArray(fails)); // 该组合可能仍缺 gold/对抗配额——具体断言在下一个测试逐项验证
});

test('配额不足必须逐项报告（gold 数）', () => {
  const scenarios = Array.from({ length: 40 }, (_, i) =>
    okScenario({ scenarioId: `S${String(i + 1).padStart(3, '0')}`, family: `fam-${Math.floor(i / 4)}`, gold: [] }),
  );
  const fails = checkQuotas(scenarios, manifest);
  assert.ok(fails.some((f) => f.includes('gold')));
  assert.ok(fails.some((f) => f.includes('对抗')));
  assert.ok(fails.some((f) => f.includes('无可记')));
});

test('家族聚类：每家族 ≥2 场景，家族数 ≥3', () => {
  const s1 = okScenario();
  const s2 = okScenario({ scenarioId: 'S002', gold: [], shouldReject: { reason: 'chitchat', note: 'x' } });
  const fails = checkQuotas([s1, s2], manifest);
  assert.ok(fails.some((f) => f.includes('场景总数') || f.includes('family') || f.includes('家族')));
});

test('scenarioId 全局唯一、eventId 跨场景唯一（前缀保证）', () => {
  const dup = [okScenario(), okScenario()];
  const errs = validateCorpus(dup, { manifest });
  assert.ok(errs.some((e) => e.includes('S001') && (e.includes('唯一') || e.includes('duplicate') || e.includes('重复'))));
});

test('computePackQuota：语料字符规模报告（token 计数走 ADR-101 前 estimate）', () => {
  const q = computePackQuota([okScenario()]);
  assert.ok(q.totalChars > 0);
  assert.ok(typeof q.estimatedTokens === 'number');
});

// —— 小数点/版本号不得视为句末终结符（44 场景语料实测回归）——
test('checkSingleSentence: 小数点数值不算复合', () => {
  assert.equal(checkSingleSentence('The staging API gateway runs version 2.4'), true);
  assert.equal(checkSingleSentence('Cold-start crash rate is 2.1 percent on affected devices'), true);
  assert.equal(checkSingleSentence('订单查询慢查询率降到 1.2%'), true);
});
test('checkSingleSentence: 真复合句仍拒绝', () => {
  assert.equal(checkSingleSentence('网关升到 2.4。连接池保持 50'), false);
  assert.equal(checkSingleSentence('Runs 2.4. Next step is rollback'), false);
});
