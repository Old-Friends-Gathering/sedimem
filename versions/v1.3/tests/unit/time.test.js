// tests/unit/time.test.js — core/time.js 单点化后的行为契约（W2）。
// 覆盖：parseAsOf（ISO / 带时区 / +08:00 / 非法抛 E_INVALID_ARG）、
// parseComparable（数字、ISO、m/d 缺年锚 2000、不可解析）、
// isExpired 边界、nowIso（clock 注入 / 缺省）、DAY_MS。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAsOf, parseComparable, isExpired, nowIso, DAY_MS,
} from '../../src/core/time.js';

test('parseAsOf：ISO UTC 串 → UTC 毫秒', () => {
  assert.equal(parseAsOf('2026-11-06T10:00:00.000Z'), Date.parse('2026-11-06T10:00:00.000Z'));
});

test('parseAsOf：+08:00 偏移量归一化到同一 UTC 毫秒（裁决 17）', () => {
  assert.equal(
    parseAsOf('2026-11-06T18:00:00+08:00'),
    parseAsOf('2026-11-06T10:00:00Z'),
  );
});

test('parseAsOf：带时区名不可解析 → 抛 E_INVALID_ARG', () => {
  assert.throws(() => parseAsOf('nonsense'), (e) => e.code === 'E_INVALID_ARG');
});

test('parseAsOf：非字符串 → 抛 E_INVALID_ARG', () => {
  assert.throws(() => parseAsOf(42), (e) => e.code === 'E_INVALID_ARG');
  assert.throws(() => parseAsOf(null), (e) => e.code === 'E_INVALID_ARG');
});

test('parseAsOf：label 注入保持既有错误文本', () => {
  try {
    parseAsOf('oops', 'search: asOf');
    assert.fail('must throw');
  } catch (e) {
    assert.equal(e.code, 'E_INVALID_ARG');
    assert.equal(e.message, 'search: asOf must be an ISO-8601 string, got "oops"');
  }
});

test('parseComparable：纯数字（含负数/千分位）', () => {
  assert.deepEqual(parseComparable('42'), { type: 'number', n: 42 });
  assert.deepEqual(parseComparable('-1.5'), { type: 'number', n: -1.5 });
  assert.deepEqual(parseComparable('1,000.25'), { type: 'number', n: 1000.25 });
});

test('parseComparable：ISO 日期与 yyyy-mm、yyyymmdd', () => {
  assert.equal(parseComparable('2026-03-01').n, Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(parseComparable('2026-03').n, Date.parse('2026-03-01T00:00:00Z'));
  // 8 位数字先命中「纯数字」分支（既有语义，行为零变化）
  assert.deepEqual(parseComparable('20260301'), { type: 'number', n: 20260301 });
});

test('parseComparable：m/d 缺年按 2000 锚年（同年内可比）', () => {
  assert.equal(parseComparable('3/1').n, Date.UTC(2000, 2, 1));
  assert.equal(parseComparable('3/1').n, parseComparable('3/1/2000').n);
  assert.ok(parseComparable('4/1').n > parseComparable('3/1').n);
});

test('parseComparable：不可解析 → { type: null }', () => {
  assert.deepEqual(parseComparable('hello'), { type: null });
  assert.deepEqual(parseComparable(''), { type: null });
  assert.deepEqual(parseComparable(null), { type: null });
});

test('isExpired：边界（null/空/解析失败 → false；validTo <= now → true）', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  assert.equal(isExpired(null, now), false);
  assert.equal(isExpired(undefined, now), false);
  assert.equal(isExpired('', now), false);
  assert.equal(isExpired('nonsense', now), false);
  assert.equal(isExpired('2026-11-06T10:00:00Z', now), true);  // 恰好等于 → 过期
  assert.equal(isExpired('2026-11-06T09:59:59Z', now), true);
  assert.equal(isExpired('2026-11-06T10:00:01Z', now), false);
});

test('nowIso：clock.nowMs 注入 → 与 clock.now() 一致；缺省系统时间', () => {
  const ms = Date.parse('2026-11-13T10:30:00Z');
  const clock = { nowMs: () => ms };
  assert.equal(nowIso(clock), '2026-11-13T10:30:00.000Z');
  assert.ok(!Number.isNaN(Date.parse(nowIso())), '缺省走系统时间且为合法 ISO');
});

test('DAY_MS = 86400000，且 purge 7 天宽限期可用它表达', () => {
  assert.equal(DAY_MS, 86400000);
  assert.equal(7 * DAY_MS, 7 * 24 * 60 * 60 * 1000);
});
