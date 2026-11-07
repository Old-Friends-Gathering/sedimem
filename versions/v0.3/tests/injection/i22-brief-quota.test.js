// tests/injection/i22-brief-quota.test.js — 注入用例 I22（v0.3 C 路，issue #51）。
// 为什么存在：dsh-auto-memory 的实测教训——某层灌爆后纯优先级注入会吃光全部预算。
// 这里把散条层灌到 5000 条，断言 blocks:null 时与扁平渲染形状一致、传 blocks 后
// 三层都出现且各守硬配额、总字符不超 totalChars。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderBrief } from '../../src/render/brief.js';
import { createRecord } from '../../src/core/record.js';

const T0 = 1770000000000;
const at = (ms) => ({ nowMs: () => ms, now: () => new Date(ms).toISOString() });
const NOW = '2026-11-07T00:00:00.000Z';

const KINDS = ['fact', 'decision', 'gotcha'];
const records = Array.from({ length: 5000 }, (_, i) => createRecord(
  {
    text: `记录 ${i}：关于模块 m${i % 97} 的第 ${i % 13} 号结论，内容各不相同以避免聚簇`,
    kind: KINDS[i % 3],
    subject: `s${i % 211}`, predicate: 'p', value: `v${i}`,
    source: { agent: 'test' },
  },
  { clock: at(T0 + i * 1000) },
));

// 20 个假视图块：18 个 L2 场景块 + 2 个 L3 画像块。
const blocks = Array.from({ length: 18 }, (_, i) => ({
  blockId: `l2-${String(i).padStart(3, '0')}`,
  key: `场景/${i % 5}`,
  count: 40 + i,
  firstAt: '2026-10-01T00:00:00.000Z',
  lastAt: '2026-11-06T00:00:00.000Z',
  recordIds: [],
}));
blocks.push(
  { layer: 'L3', blockId: 'l3-a', key: 'profile-a', text: '画像：偏好确定性渲染', sourceRefs: ['r1', 'r2'], firstAt: '2026-10-01T00:00:00.000Z', lastAt: '2026-11-01T00:00:00.000Z' },
  { layer: 'L3', blockId: 'l3-b', key: 'profile-b', text: '画像：零运行时依赖', sourceRefs: ['r3'], firstAt: '2026-10-02T00:00:00.000Z', lastAt: '2026-11-02T00:00:00.000Z' },
);

const POLICY = {
  brief: { lines: 80, quota: { L2: 0.25, L3: 0.15 }, totalChars: 8000 },
};

describe('I22 · brief 分层配额', () => {
  test('blocks:null 与扁平渲染形状一致（标题 + active 统计 + 正文行）', () => {
    const layeredNull = renderBrief(records, { scope: 'repo:i22', policy: POLICY, now: NOW, blocks: null });
    const flat = renderBrief({ scope: 'repo:i22', records });
    assert.equal(layeredNull, flat, 'blocks:null 必须与旧签名输出完全一致');
    const ls = layeredNull.split('\n');
    assert.match(ls[0], /^# memo · repo:i22$/);
    assert.match(ls[1], /^active: 5000 \(fact \d+ \/ pref 0 \/ decision \d+ \/ gotcha \d+ \/ state 0\)$/);
    assert.ok(ls.slice(2).every((l) => l.startsWith('- [') || l.startsWith('…') || l.startsWith('待裁决')));
  });

  test('传 blocks：总字符 ≤ totalChars，三层都出现，L2 行数 ≤ 配额+1', () => {
    const out = renderBrief(records, { scope: 'repo:i22', policy: POLICY, now: NOW, blocks });
    const lines = out.split('\n');
    assert.ok(out.length <= 8000, `总字符 ${out.length} 超上限`);

    assert.ok(lines.includes('## L2 场景块'), 'L2 段缺失');
    assert.ok(lines.includes('## L3 画像'), 'L3 段缺失');
    assert.ok(lines.includes('## 记录'), '散条段缺失');

    const l2Lines = lines.filter((l) => l.startsWith('· '));
    const l3Lines = lines.filter((l) => l.startsWith('◇ '));
    const scatLines = lines.filter((l) => l.startsWith('- ['));
    const quotaL2 = Math.floor(0.25 * 80);
    assert.ok(l2Lines.length <= quotaL2 + 1, `L2 行数 ${l2Lines.length} > 配额+1 ${quotaL2 + 1}`);
    assert.ok(l2Lines.length >= 1 && l3Lines.length >= 1 && scatLines.length >= 1, '三层都必须有内容');
    assert.match(l2Lines[0], /^· 场景\/\d+（\d+ 条，2026-10-01~2026-11-06）$/);
    assert.ok(!l2Lines[0].includes('l2-'), 'L2 行不得展开 recordIds/blockId');
    assert.match(l3Lines[0], /^◇ 画像：/);
  });

  test('配额是硬上限：把 L2 灌到 5000 块也不得吃光预算', () => {
    const flood = Array.from({ length: 5000 }, (_, i) => ({
      blockId: `f-${i}`, key: `洪水/${i}`, count: 3,
      firstAt: '2026-11-01T00:00:00.000Z', lastAt: '2026-11-07T00:00:00.000Z', recordIds: [],
    }));
    const out = renderBrief(records, { scope: 'repo:i22', policy: POLICY, now: NOW, blocks: flood });
    const lines = out.split('\n');
    const l2Lines = lines.filter((l) => l.startsWith('· '));
    assert.ok(l2Lines.length <= Math.floor(0.25 * 80) + 1, '灌爆层仍须守配额');
    assert.ok(out.length <= 8000);
    assert.ok(lines.filter((l) => l.startsWith('- [')).length >= 1, '散条层不得被饿死');
  });

  test('字符超限先砍散条再砍 L3 再砍 L2，被砍层末尾标 …略去 N 条', () => {
    const tight = { brief: { lines: 80, quota: { L2: 0.25, L3: 0.15 }, totalChars: 1200 } };
    const out = renderBrief(records, { scope: 'repo:i22', policy: tight, now: NOW, blocks });
    assert.ok(out.length <= 1200, `总字符 ${out.length}`);
    const lines = out.split('\n');
    const scatSection = lines.slice(lines.indexOf('## 记录') + 1, lines.indexOf('待裁决') === -1 ? lines.length : lines.indexOf('待裁决'));
    assert.ok(scatSection.some((l) => /^…略去 \d+ 条$/.test(l)), '散条层被砍必须标注省略数');
    assert.ok(lines.some((l) => l.startsWith('· ')), 'L2 应最后被砍，此处仍保留');
  });

  test('空 blocks 数组 = 扁平降级', () => {
    const a = renderBrief(records, { scope: 'repo:i22', blocks: [] });
    const b = renderBrief({ scope: 'repo:i22', records });
    assert.equal(a, b);
  });
});
