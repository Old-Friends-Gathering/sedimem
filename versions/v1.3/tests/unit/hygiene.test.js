import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decideWrite, textSimilarity } from '../../src/hygiene/write-gate.js';
import { sameSlot, parseComparable, decideConflict, monotonicDecay } from '../../src/hygiene/conflict.js';
import { HALF_LIFE_MS, expiryFor, isExpired } from '../../src/hygiene/decay.js';
import { QuotaPolicy } from '../../src/hygiene/quota.js';
import { CurateQueue } from '../../src/hygiene/curate.js';
import { createRecord } from '../../src/core/record.js';
import { createClock } from '../../src/core/clock.js';

const T0 = 1770000000000;
const clock = createClock({ now: T0 });
const at = (ms) => ({ nowMs: () => ms, now: () => new Date(ms).toISOString() });

function rec(over = {}, ms = T0) {
  return createRecord(
    {
      text: 'demo fact', kind: 'fact', subject: 's', predicate: 'p', value: 'v',
      source: { agent: 'test' }, ...over,
    },
    { clock: at(ms) },
  );
}

describe('hygiene/write-gate decideWrite', () => {
  test('hash 命中 active → noop_duplicate', () => {
    const existing = rec();
    const incoming = rec(); // 完全相同输入 → 相同 contentHash
    const out = decideWrite(incoming, [existing], { clock });
    assert.equal(out.action, 'noop_duplicate');
    assert.ok(typeof out.reason === 'string' && out.reason.length > 0);
  });

  test('同 slot 同值（text 不同）→ noop_same_value', () => {
    const existing = rec({ subject: 'x', predicate: 'y', value: 'same' });
    const incoming = rec({ subject: 'x', predicate: 'y', value: 'same', text: '另一种说法 same' });
    const out = decideWrite(incoming, [existing], { clock });
    assert.equal(out.action, 'noop_same_value');
  });

  test('同 slot 异值、新值更晚（日期可比）→ supersede', () => {
    // 裁决 15 后：文本近重复（sim≥阈值）的异值对先被近重复拦截。
    // 本用例考察日期可比的 supersede 路径，故两条 text 必须不相似（前置断言自检）。
    const existing = rec({ subject: 'd', predicate: 'deadline', value: '2026-03-01', text: 'old deadline note alpha' }, T0);
    const incoming = rec({ subject: 'd', predicate: 'deadline', value: '2026-04-01', text: 'new deadline schedule bravo' }, T0 + 1000);
    assert.ok(textSimilarity(existing.text, incoming.text) < 0.85, 'fixture 前提：两条 text 不得近重复');
    const out = decideWrite(incoming, [existing], { clock });
    assert.equal(out.action, 'supersede');
    assert.ok(out.superseded && out.superseded.id === existing.id, '应带被取代记录');
  });

  test('同 slot 异值、不可比较 → disputed', () => {
    const existing = rec({ subject: 'n', predicate: 'ver', value: 'v18' });
    const incoming = rec({ subject: 'n', predicate: 'ver', value: 'v16', text: '旧结论 v16' });
    const out = decideWrite(incoming, [existing], { clock });
    assert.equal(out.action, 'disputed');
  });

  test('新 slot → created；candidates 为空 → created', () => {
    const out = decideWrite(rec({ subject: 'brand-new' }), [], { clock });
    assert.equal(out.action, 'created');
  });
});

describe('hygiene/conflict', () => {
  test('sameSlot：scope+subject+predicate 相等', () => {
    const a = rec({ scope: 'repo:x', subject: 's', predicate: 'p', value: '1' });
    const b = rec({ scope: 'repo:x', subject: 's', predicate: 'p', value: '2' });
    const c = rec({ scope: 'repo:x', subject: 's', predicate: 'q', value: '1' });
    const d = rec({ scope: 'repo:y', subject: 's', predicate: 'p', value: '1' });
    assert.equal(sameSlot(a, b), true);
    assert.equal(sameSlot(a, c), false);
    assert.equal(sameSlot(a, d), false);
  });

  test('parseComparable：数字 / 日期 / 不可解析', () => {
    const n = parseComparable('42');
    assert.equal(n.type, 'number');
    assert.equal(n.n, 42);
    const d = parseComparable('2026-03-01');
    assert.equal(d.type, 'date');
    assert.ok(typeof d.n === 'number');
    const no = parseComparable('hello');
    assert.equal(no.type, null);
  });

  test('decideConflict：新更晚 → supersede；不可比较 → dispute', () => {
    const prev = rec({ subject: 'd', predicate: 'x', value: '2026-03-01' });
    const newer = rec({ subject: 'd', predicate: 'x', value: '2026-04-01' });
    assert.equal(decideConflict(newer, prev, { clock }).action, 'supersede');
    const inc = rec({ subject: 'd', predicate: 'x', value: 'v16' });
    const r = decideConflict(inc, prev, { clock });
    assert.ok(r.action === 'dispute' || r.action === 'ignore', '不可比较不得 supersede');
    assert.ok(typeof r.reason === 'string');
  });

  test('monotonicDecay：单调递减、(0,1] 区间、半衰期近似 0.5', () => {
    const HL = 7776000000; // 90d
    assert.equal(monotonicDecay(0, HL), 1);
    let prev = 2;
    for (const age of [0, 1, 1000, HL / 10, HL / 2, HL, HL * 4, HL * 100]) {
      const d = monotonicDecay(age, HL);
      assert.ok(d > 0 && d <= 1, `decay(${age})=${d} 应在 (0,1]`);
      assert.ok(d <= prev, `decay 应单调递减：age=${age} d=${d} prev=${prev}`);
      prev = d;
    }
    assert.ok(Math.abs(monotonicDecay(HL, HL) - 0.5) < 1e-9, '半衰期处 decay≈0.5');
  });
});

describe('hygiene/decay', () => {
  test('HALF_LIFE_MS 与 policy.json 一致', () => {
    assert.equal(HALF_LIFE_MS.pref, 180 * 86400000);
    assert.equal(HALF_LIFE_MS.decision, 365 * 86400000);
    assert.equal(HALF_LIFE_MS.fact, 90 * 86400000);
    assert.equal(HALF_LIFE_MS.gotcha, 365 * 86400000);
    assert.equal(HALF_LIFE_MS.state, 2 * 3600000);
  });

  test('expiryFor：state 2h 后过期，其余 null', () => {
    const exp = expiryFor('state', T0);
    assert.equal(exp, new Date(T0 + 2 * 3600000).toISOString());
    assert.equal(expiryFor('fact', T0), null);
    assert.equal(expiryFor('pref', T0), null);
    assert.equal(expiryFor('decision', T0), null);
    assert.equal(expiryFor('gotcha', T0), null);
  });

  test('isExpired：过期 state 为 true，未过期为 false', () => {
    const staleState = rec({ kind: 'state' }, T0 - 3 * 3600000);
    const freshState = rec({ kind: 'state' }, T0 - 1000);
    const fact = rec({ kind: 'fact' }, T0 - 400 * 86400000);
    assert.equal(isExpired(staleState, clock), true);
    assert.equal(isExpired(freshState, clock), false);
    assert.equal(isExpired(fact, clock), false, 'fact 无 TTL，不因时间过期');
  });
});

describe('hygiene/quota', () => {
  test('value 单调性：hits 越多价值越高；越新价值越高；confidence 越高价值越高', () => {
    const q = new QuotaPolicy({});
    const low = q.value(rec({ hits: 1, confidence: 0.5 }, T0 - 2 * 86400000), clock);
    const moreHits = q.value(rec({ hits: 5, confidence: 0.5 }, T0 - 2 * 86400000), clock);
    const newer = q.value(rec({ hits: 1, confidence: 0.5 }, T0), clock);
    const hiConf = q.value(rec({ hits: 1, confidence: 1.0 }, T0 - 2 * 86400000), clock);
    assert.ok(low > 0, '基线价值应为正（hits=1）');
    assert.ok(moreHits > low, 'hits 应提升价值');
    assert.ok(newer > low, 'recency 应提升价值');
    assert.ok(hiConf > low, 'confidence 应提升价值');
  });

  test('selectEvictions：超额数、按价值升序、只返回 id', () => {
    const q = new QuotaPolicy({ maxActive: 3 });
    const rs = [
      rec({ subject: 'a' }, T0),
      rec({ subject: 'b', hits: 10 }, T0),
      rec({ subject: 'c', hits: 5 }, T0),
      rec({ subject: 'd' }, T0 - 86400000 * 30), // 旧且无 hits → 价值最低
      rec({ subject: 'e' }, T0),
    ];
    const evict = q.selectEvictions(rs, { max: 3 });
    assert.equal(evict.length, 2, '应淘汰超额的 2 条');
    assert.ok(evict.every((id) => typeof id === 'string'));
    assert.equal(evict[0], rs[3].id, '价值最低者（旧且无 hits）最先被淘汰');
  });

  test('未超额不淘汰', () => {
    const q = new QuotaPolicy({ maxActive: 10 });
    const rs = [rec(), rec({ subject: 'b' })];
    assert.equal(q.selectEvictions(rs).length, 0);
  });
});

describe('hygiene/curate CurateQueue', () => {
  test('exportBatch → readBatch → applyDecisions → listBatches 全链路', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    try {
      const q = new CurateQueue({ memoHome: home, clock });
      const a = rec({ subject: 'c', predicate: 'x', value: 'v18' });
      const b = rec({ subject: 'c', predicate: 'x', value: 'v16' });
      const batch = await q.exportBatch([{ a, b, reason: 'same slot' }], { limit: 20 });
      assert.ok(batch.batchId, '应返回 batchId');
      assert.equal(batch.pairs.length, 1);
      assert.equal(batch.pairs[0].reason, 'same slot');
      assert.ok(existsSync(join(home, 'queue')), '应落盘 queue/curate-<batchId>.json');

      const back = await q.readBatch(batch.batchId);
      assert.equal(back.batchId, batch.batchId);
      assert.equal(back.pairs.length, 1);

      const results = await q.applyDecisions(batch, [{ pairIndex: 0, decision: 'a_wins', note: '取 v18' }]);
      assert.equal(results.length, 1);
      assert.equal(results[0].pairIndex, 0);
      assert.equal(results[0].applied, true);

      const batches = await q.listBatches();
      assert.ok(batches.some((x) => x.batchId === batch.batchId));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('readBatch 不存在 → E_BATCH_NOT_FOUND', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memo-'));
    try {
      const q = new CurateQueue({ memoHome: home, clock });
      await assert.rejects(
        q.readBatch('no-such-batch'),
        (err) => err instanceof Error && err.code === 'E_BATCH_NOT_FOUND',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// 裁决 14/15：无结构记录的近重复判定。
// 相似度定义：sim = |A∩B| / min(|A|,|B|)（containment，token 集合来自 core/hash.js#tokenize）。
describe('hygiene/write-gate textSimilarity（裁决 14）', () => {
  test('完全相同 → 1；空串与任何文本 → 0；不抛错', () => {
    assert.equal(textSimilarity('用户偏好深色主题', '用户偏好深色主题'), 1, '完全相同应为 1');
    assert.equal(textSimilarity('', ''), 0, '空对空应为 0（无 token 可比，不构成近重复）');
    assert.equal(textSimilarity('', '任意文本'), 0, '空串不得与任何文本判为相似');
    assert.equal(textSimilarity('任意文本', ''), 0);
  });

  test('包含关系（短句 token 全落在长句里）→ containment = 1', () => {
    // 「同一事实 + 不同长度措辞」的短句应被长句吸收——这正是选 containment 而非 Jaccard 的理由
    const short = '用户偏好深色主题';
    const long = '用户偏好深色主题，界面整体用暗色风格';
    const sim = textSimilarity(short, long);
    assert.ok(sim >= 0.85, `包含关系 sim 应 ≥ 0.85，实际 ${sim}`);
    const simReverse = textSimilarity(long, short);
    assert.ok(Math.abs(sim - simReverse) < 1e-9, `min 为分母应近似对称：${sim} vs ${simReverse}`);
  });

  test('无关文本 → 低于阈值（不得误杀不同事实）', () => {
    const a = '数据库端口是 5432';
    const b = '会议室在 3 楼 B 区';
    const sim = textSimilarity(a, b);
    assert.ok(sim < 0.85, `无关文本 sim 应 < 0.85（默认近重复阈值），实际 ${sim}`);
  });

  test('换措辞同义句 → 达到默认阈值 0.85（近重复应被拦截）', () => {
    const a = '用户偏好深色主题';
    const b = '用户偏好深色主题 dark mode';
    assert.ok(textSimilarity(a, b) >= 0.85, '同义扩展措辞应达到默认阈值');
  });
});

describe('hygiene/write-gate 近重复判定与阈值（裁决 14/15）', () => {
  const PARAPHRASE_A = { subject: 'text', predicate: 'text', text: '用户偏好深色主题', value: '用户偏好深色主题' };
  const PARAPHRASE_B = { subject: 'text', predicate: 'text', text: '用户偏好深色主题，界面用暗色', value: '用户偏好深色主题，界面用暗色' };
  const DIFFERENT = { subject: 'text', predicate: 'text', text: '数据库端口是 5432', value: '数据库端口是 5432' };

  test('unstructured 同义句 → noop_same_value + reason=near_duplicate + 原记录打 variant', () => {
    const existing = rec(PARAPHRASE_A);
    const incoming = rec({ ...PARAPHRASE_B });
    const out = decideWrite(incoming, [existing], { clock });
    assert.equal(out.action, 'noop_same_value', `近重复应 noop_same_value，实际 ${out.action}`);
    assert.ok(
      String(out.reason).includes('near_duplicate'),
      `reason 应含 'near_duplicate'，实际 ${JSON.stringify(out.reason)}`,
    );
    assert.equal(out.record.id, existing.id, '拦截后 record 应指向原记录（不新增）');
  });

  test('unstructured 无关事实 → created（不得误杀）', () => {
    const existing = rec(PARAPHRASE_A);
    const incoming = rec({ ...DIFFERENT });
    const out = decideWrite(incoming, [existing], { clock });
    assert.equal(out.action, 'created', `无关事实应 created，实际 ${out.action}`);
  });

  test('结构化 slot：value 不等但文本相似 → 同样按近重复拦截（裁决 15）', () => {
    const existing = rec({ subject: 'ui', predicate: 'theme', text: '主题设置为深色', value: '深色' });
    const incoming = rec({ subject: 'ui', predicate: 'theme', text: '主题设置为深色模式', value: '深色模式' });
    const sim = textSimilarity(existing.text, incoming.text);
    if (sim >= 0.85) {
      const out = decideWrite(incoming, [existing], { clock });
      assert.ok(
        out.action === 'noop_same_value' || out.action === 'supersede',
        `文本相似 ≥ 阈值时不得落 disputed（裁决 15），实际 ${out.action}`,
      );
      if (out.action === 'noop_same_value') {
        assert.ok(String(out.reason).includes('near_duplicate'));
      }
    } else {
      assert.fail(`测试前提不成立：结构化样例文本相似度 ${sim} < 0.85，请换更贴近的样例`);
    }
  });

  test('阈值可配置：ctx.nearDupThreshold 提高后同义句不再拦截', () => {
    const existing = rec(PARAPHRASE_A);
    const incoming = rec({ ...PARAPHRASE_B });
    // 默认阈值（policy.dedupe.nearDupThreshold=0.85）下应拦截（上一用例已证）；
    // 把阈值抬高到 1.01（严格大于 containment 上限 1）后，同一对必须放行为 created
    const out = decideWrite(incoming, [existing], { clock, nearDupThreshold: 1.01 });
    assert.equal(out.action, 'created', `阈值调高后近重复不得拦截，实际 ${out.action}`);
  });
});
