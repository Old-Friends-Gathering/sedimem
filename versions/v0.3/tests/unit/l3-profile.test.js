// tests/unit/l3-profile.test.js — L3 画像层单元测试（issue #52）
// 覆盖：候选优先级 / batchSize 截断 / 已覆盖跳过 / sourceRefs 校验全套 /
// text 超长 / buildL3Record 形状 / traceL3 stale+missing / 纯函数不改入参。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planL3, validateL3Draft, buildL3Record, traceL3,
} from '../../src/views/l3.js';

// 与 policy.json kinds 段一致的权重子集（decision 1.4 > pref 1.3 > gotcha 1.2 > fact 1.0）
const POLICY = {
  kinds: {
    fact: { weight: 1.0 },
    pref: { weight: 1.3 },
    decision: { weight: 1.4 },
    gotcha: { weight: 1.2 },
    state: { weight: 0.6 },
  },
};

const NOW = new Date('2026-11-07T00:00:00Z');

let seq = 0;
/** 造一条活记录（id 用合法 ULID 形状，保证可作 sourceRefs） */
function rec({ kind = 'fact', subject = 'text', predicate = 'text', text = 't', status = 'active', tags, sourceRefs } = {}) {
  seq++;
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FA' + String(seq).padStart(2, '0').slice(-2);
  const r = {
    id, v: 1, scope: 'repo:t', kind, subject, predicate,
    text, value: text, validFrom: '2026-01-01T00:00:00Z', validTo: null,
    createdAt: '2026-01-01T00:00:00Z', expiredAt: null, status,
    confidence: 0.8, source: { agent: 'test' }, contentHash: 'sha256:x', hits: 0,
    privacy: 'private', tags: tags ?? [],
  };
  if (sourceRefs) r.sourceRefs = sourceRefs;
  return r;
}

/** 26 位合法 ULID（Crockford base32）样例 */
const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01FC5S0TABCDEFGHJKMNPQRSTV';

test('planL3：decision 组排在 fact 组前（kind 权重来自 policy.kinds）', () => {
  const records = [
    rec({ kind: 'fact', subject: 's1', predicate: 'p1' }),
    rec({ kind: 'decision', subject: 's2', predicate: 'p2' }),
  ];
  const { candidates } = planL3(records, null, { policy: POLICY, now: NOW });
  assert.equal(candidates.length, 2);
  assert.match(candidates[0].key, /^slot:s2/); // decision 组先出
  assert.equal(candidates[0].kinds[0], 'decision');
  assert.deepEqual(candidates[1].kinds, ['fact']);
});

test('planL3：batchSize 截断，超出的组计入 skipped', () => {
  const records = [];
  for (let i = 0; i < 15; i++) records.push(rec({ kind: 'decision', subject: `s${i}`, predicate: 'p' }));
  const { candidates, skipped } = planL3(records, null, { policy: POLICY, now: NOW });
  assert.equal(candidates.length, 10); // 默认 batchSize=10
  assert.equal(skipped, 5);
  // 截断后仍确定序：key 升序（同权重同大小）
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i - 1].key < candidates[i].key);
  }
});

test('planL3：maxCallsPerRun 比 batchSize 更紧时按调用预算截断', () => {
  const records = [];
  for (let i = 0; i < 8; i++) records.push(rec({ kind: 'pref', subject: `s${i}`, predicate: 'p' }));
  const policy = { ...POLICY, l3: { batchSize: 10, maxCallsPerRun: 5 } };
  const { candidates, callsEstimate, skipped } = planL3(records, null, { policy, now: NOW });
  assert.equal(candidates.length, 5);
  assert.ok(callsEstimate <= 5);
  assert.equal(skipped, 3);
});

test('planL3：已被未过期 L3 覆盖的记录跳过并计数', () => {
  const a = rec({ kind: 'decision', subject: 's', predicate: 'p' });
  const b = rec({ kind: 'decision', subject: 's2', predicate: 'p' });
  const cover = rec({
    kind: 'pref', tags: ['L3'], sourceRefs: [a.id],
  });
  const { candidates, skipped } = planL3([a, b, cover], null, { policy: POLICY, now: NOW });
  assert.equal(skipped, 1);
  const flat = candidates.flatMap((c) => c.recordIds);
  assert.ok(!flat.includes(a.id), 'a 已被覆盖，不应再成候选');
  assert.ok(flat.includes(b.id));
});

test('planL3：superseded 记录不进候选，也不算 skipped', () => {
  const dead = rec({ kind: 'decision', subject: 'dead', predicate: 'p', status: 'superseded' });
  const live = rec({ kind: 'fact', subject: 'live', predicate: 'p' });
  const { candidates, skipped } = planL3([dead, live], null, { policy: POLICY, now: NOW });
  assert.equal(skipped, 0);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].recordIds, [live.id]);
});

test('planL3：不修改入参 records/blocks（纯函数）', () => {
  const records = [rec({ kind: 'pref', subject: 's', predicate: 'p' })];
  const blocks = [{ key: 'slot:s', recordIds: [records[0].id] }];
  const snapshot = JSON.stringify({ records, blocks });
  planL3(records, blocks, { policy: POLICY, now: NOW });
  assert.equal(JSON.stringify({ records, blocks }), snapshot);
});

test('validateL3Draft：sourceRefs 为空 / 非数组 / 非法项 / 非 ULID 全部拒绝', () => {
  const base = { text: '用户偏好零依赖实现', confidence: 0.9, sourceRefs: [ULID_A] };
  assert.equal(validateL3Draft({ ...base, sourceRefs: [] }).code, 'E_L3_SOURCEREFS_EMPTY');
  assert.equal(validateL3Draft({ ...base, sourceRefs: null }).code, 'E_L3_SOURCEREFS_EMPTY');
  assert.equal(validateL3Draft({ ...base, sourceRefs: [42] }).code, 'E_L3_SOURCEREFS_SHAPE');
  assert.equal(validateL3Draft({ ...base, sourceRefs: ['not-a-ulid'] }).code, 'E_L3_SOURCEREFS_NOT_ULID');
  // 小写 / 含 I L O U 的都不算 Crockford ULID
  assert.equal(validateL3Draft({ ...base, sourceRefs: ['01arz3ndektsv4rrffq69g5fav'] }).code, 'E_L3_SOURCEREFS_NOT_ULID');
  assert.deepEqual(validateL3Draft(base), { ok: true });
});

test('validateL3Draft：text 空 / 超长 / 无出处断言词 / confidence 越界拒绝', () => {
  const base = { sourceRefs: [ULID_A], confidence: 0.9 };
  assert.equal(validateL3Draft({ ...base, text: '' }).code, 'E_L3_TEXT_EMPTY');
  assert.equal(validateL3Draft({ ...base, text: 'x'.repeat(2001) }).code, 'E_L3_TEXT_TOO_LONG');
  assert.equal(validateL3Draft({ ...base, text: '他喜欢用 vim', confidence: 0.9 }).code, 'E_L3_UNSOURCED_PRONOUN');
  assert.equal(validateL3Draft({ ...base, text: '用户是夜猫子', confidence: 0.9 }).code, 'E_L3_UNSOURCED_USER_CLAIM');
  assert.equal(validateL3Draft({ ...base, text: '这个人总是迟到', confidence: 0.9 }).code, 'E_L3_UNSOURCED_ALWAYS');
  assert.equal(validateL3Draft({ ...base, text: '偏好零运行时依赖', confidence: 0 }).code, 'E_L3_CONFIDENCE_RANGE');
  assert.equal(validateL3Draft({ ...base, text: '偏好零运行时依赖', confidence: 1.2 }).code, 'E_L3_CONFIDENCE_RANGE');
  // 边界内通过：confidence=1、恰好 2000 字、有出处的中性表述
  assert.deepEqual(validateL3Draft({ ...base, text: 'y'.repeat(2000), confidence: 1 }), { ok: true });
});

test('buildL3Record：tags 带 L3、TTL 默认 30 天、kind 缺省 pref、sourceRefs 原样', () => {
  const draft = {
    text: '偏好零运行时依赖', confidence: 0.9, sourceRefs: [ULID_A, ULID_B],
    tags: ['custom'], kind: 'decision',
  };
  const built = buildL3Record(draft, { now: NOW });
  assert.equal(built.kind, 'decision');
  assert.deepEqual(built.tags, ['custom', 'L3']);
  assert.deepEqual(built.sourceRefs, [ULID_A, ULID_B]);
  // 默认 ttl 30 天；active 记录的 TTL 用 expiredAt（validTo 必须为 null，见真相层不变式）
  assert.equal(built.expiredAt, '2026-12-07T00:00:00.000Z');
  assert.equal('validTo' in built && built.validTo !== undefined ? built.validTo : null, null);
  assert.equal(built.source.agent, 'l3');
  // 缺省 kind → pref；ttlMs 覆盖生效
  const built2 = buildL3Record(
    { text: 't', confidence: 0.8, sourceRefs: [ULID_A] },
    { now: NOW, policy: { l3: { ttlMs: 1000 } } },
  );
  assert.equal(built2.kind, 'pref');
  assert.ok(built2.tags.includes('L3'));
  assert.equal(built2.expiredAt, '2026-11-07T00:00:01.000Z');
});

test('traceL3：标出 stale（superseded/tombstoned）与 missing', () => {
  const ok = rec({ subject: 'a', predicate: 'p' });
  const sup = rec({ subject: 'b', predicate: 'p', status: 'superseded' });
  const tomb = rec({ subject: 'c', predicate: 'p', status: 'tombstoned' });
  const l3 = { sourceRefs: [ok.id, sup.id, tomb.id, '01 MISSING IS NOT A ULID XX'.replace(/[^0-9A-HJKMNP-TV-Z]/g, '').padEnd(26, 'Z').slice(0, 26)] };
  const t = traceL3(l3, [ok, sup, tomb]);
  assert.deepEqual(t.sourceRefs, l3.sourceRefs);
  assert.equal(t.missing.length, 1);
  assert.deepEqual(t.stale, [
    { id: sup.id, status: 'superseded' },
    { id: tomb.id, status: 'tombstoned' },
  ]);
  // 全部健康时干净
  const t2 = traceL3({ sourceRefs: [ok.id] }, [ok]);
  assert.deepEqual(t2.missing, []);
  assert.deepEqual(t2.stale, []);
});
