// tests/unit/settings-view.test.js —— W8：设置页纯函数（DOM 无关，node 可测）
// 覆盖：rowsForSummary 三种输入（字段缺失 / 正常值 / writeEnabled 两态）
//       formatPolicyValue 的 null / boolean / 数字 / 其他类型格式化
//       kindsTable 与 rowsForHygiene 的兜底；源码级禁 innerHTML / eval 静态检查。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  rowsForSummary, formatPolicyValue, kindsTable, rowsForHygiene,
} from '../../ui/settings-view.js';

describe('settings-view/formatPolicyValue', () => {
  test('null / undefined / 空串 → —', () => {
    assert.equal(formatPolicyValue(null), '—');
    assert.equal(formatPolicyValue(undefined), '—');
    assert.equal(formatPolicyValue(''), '—');
  });

  test('boolean → 是 / 否', () => {
    assert.equal(formatPolicyValue(true), '是');
    assert.equal(formatPolicyValue(false), '否');
  });

  test('数字 → 十进制字符串；NaN / Infinity → —', () => {
    assert.equal(formatPolicyValue(600), '600');
    assert.equal(formatPolicyValue(0.45), '0.45');
    assert.equal(formatPolicyValue(NaN), '—');
    assert.equal(formatPolicyValue(Infinity), '—');
  });

  test('字符串原样；对象 JSON 一行兜底', () => {
    assert.equal(formatPolicyValue('sqlite'), 'sqlite');
    assert.equal(formatPolicyValue({ a: 1 }), '{"a":1}');
  });
});

describe('settings-view/rowsForSummary', () => {
  test('字段缺失：所有策略字段显示 —，语义道写「见 policy.llm」不编造', () => {
    const groups = rowsForSummary({});
    const all = Object.fromEntries(groups.flatMap((g) => g.rows.map((r) => [r.k, r.v])));
    assert.equal(all.valueRecommendChars, '—');
    assert.equal(all.textHardMaxChars, '—');
    assert.equal(all.titleEnforce, '—');
    assert.equal(all['index.backend'], '—');
    assert.equal(all['语义道'], '见 policy.llm');
    assert.equal(all['LLM 总结'], '由 policy.llm.provider 决定，默认 none（关闭）');
  });

  test('正常值：四个分组齐全，检索阈值与 write 契约取自 policy 各段', () => {
    const groups = rowsForSummary({
      version: '1.0.0',
      scope: 'repo:demo',
      memoHome: '/tmp/memo',
      writeEnabled: true,
      policy: {
        nearDupThreshold: 0.45,
        scanThreshold: 0.45,
        scanDiceThreshold: 0.15,
        write: { valueRecommendChars: 120, textHardMaxChars: 4000, titleEnforce: false },
        index: { backend: 'sqlite' },
        llm: { provider: 'none' },
      },
    });
    const byTitle = Object.fromEntries(groups.map((g) => [g.title, g]));
    assert.deepEqual(groups.map((g) => g.title), [
      '版本与分库', '写侧契约（policy.write）', '检索（policy.dedupe / index）', 'LLM 派生层（policy.kinds / llm）',
    ]);
    const v = Object.fromEntries(byTitle['版本与分库'].rows.map((r) => [r.k, r.v]));
    assert.deepEqual(v, { version: '1.0.0', scope: 'repo:demo', memoHome: '/tmp/memo', writeEnabled: '可写' });
    const w = Object.fromEntries(byTitle['写侧契约（policy.write）'].rows.map((r) => [r.k, r.v]));
    assert.deepEqual(w, { valueRecommendChars: '120', textHardMaxChars: '4000', titleEnforce: '否' });
    const r = Object.fromEntries(byTitle['检索（policy.dedupe / index）'].rows.map((r) => [r.k, r.v]));
    assert.equal(r['dedupe.nearDupThreshold'], '0.45');
    assert.equal(r['index.backend'], 'sqlite');
    assert.equal(r['语义道'], '见 policy.llm'); // provider 存在但无语义道状态字段，仍如实指路
    const l = Object.fromEntries(byTitle['LLM 派生层（policy.kinds / llm）'].rows.map((r) => [r.k, r.v]));
    assert.equal(l['LLM 总结'], 'provider=none');
  });

  test('writeEnabled=true / false：值与徽标两态', () => {
    const on = rowsForSummary({ writeEnabled: true })[0].rows.find((x) => x.k === 'writeEnabled');
    const off = rowsForSummary({ writeEnabled: false })[0].rows.find((x) => x.k === 'writeEnabled');
    const unset = rowsForSummary({})[0].rows.find((x) => x.k === 'writeEnabled');
    assert.deepEqual({ v: on.v, badge: on.badge }, { v: '可写', badge: 'ok' });
    assert.deepEqual({ v: off.v, badge: off.badge }, { v: '只读', badge: 'ro' });
    assert.equal(unset.v, '只读'); // 未声明可写一律按只读（与 edit-view 同约定）
    assert.equal(unset.badge, 'ro');
  });
});

describe('settings-view/kindsTable 与 rowsForHygiene', () => {
  test('kindsTable：正常展开为行；缺失返回空行', () => {
    const t = kindsTable({ fact: { halfLifeMs: 86400000, weight: 1, color: '#1e90ff' } });
    assert.deepEqual(t.header, ['kind', 'halfLifeMs', 'weight', 'color']);
    assert.deepEqual(t.rows, [['fact', '86400000', '1', '#1e90ff']]);
    assert.deepEqual(kindsTable(null).rows, []);
  });

  test('rowsForHygiene：取 series 最后一条；series 缺失全 —', () => {
    const rows = rowsForHygiene({ series: [
      { date: '2026-11-13', dupRatio: 0.1, conflictRate: 0.2, active: 100 },
      { date: '2026-11-14', dupRatio: 0.11, conflictRate: 0.22, active: 110 },
    ] });
    assert.deepEqual(rows, [
      { k: '日期', v: '2026-11-14' },
      { k: 'dupRatio', v: '0.11' },
      { k: 'conflictRate', v: '0.22' },
      { k: 'active', v: '110' },
    ]);
    assert.deepEqual(
      rowsForHygiene(null).map((r) => r.v),
      ['—', '—', '—', '—'],
    );
  });
});

test('静态检查：settings-view.js 禁 innerHTML / eval / new Function', () => {
  const SRC = readFileSync(new URL('../../ui/settings-view.js', import.meta.url), 'utf8');
  assert.ok(!/\binnerHTML\b/.test(SRC), 'settings-view.js 不得出现 innerHTML');
  assert.ok(!/\beval\b/.test(SRC), 'settings-view.js 不得出现 eval');
  assert.ok(!/new Function/.test(SRC), 'settings-view.js 不得出现 new Function');
});
