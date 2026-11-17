/**
 * graph-layout.test.js —— 图谱「视觉常量」的单元测试。
 *
 * 历史：v0.2 时这里测的是自研 3D 力导向（layoutTick 的推进/能量/可复现）。
 * v1.0 W6 起图谱换成 vendor 的 force-graph，那套实现连同本文件的 layoutTick 用例一起删除；
 * v1.0.1 起这些常量并进 ui/graph-ui.js（layout.js 已删除），本文件继续守着「常量别被改坏」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND_COLORS, kindColorsFromPolicy, EDGE_PREF_KEY, DEFAULT_EDGE_TYPES, OPTIONAL_EDGE_TYPES } from '../../ui/graph-ui.js';
import { nodeRadius } from '../../ui/graph-style.js';

test('KIND_COLORS：五种 kind 齐全且都是 #rrggbb', () => {
  for (const kind of ['fact', 'pref', 'decision', 'gotcha', 'state']) {
    assert.match(KIND_COLORS[kind], /^#[0-9a-f]{6}$/i, `${kind} 颜色非法`);
  }
});

test('KIND_COLORS 与宿主色板同源：policy.kinds 的颜色优先', () => {
  const policy = { kinds: { fact: { color: '#123456' }, custom: { color: '#abcdef' } } };
  const merged = kindColorsFromPolicy(policy);
  assert.equal(merged.fact, '#123456');
  assert.equal(merged.custom, '#abcdef');
  // 未在 policy 里出现的 kind 仍回落到内置色
  assert.equal(merged.decision, KIND_COLORS.decision);
});

test('kindColorsFromPolicy：policy 缺 kinds 时不抛、返回内置色', () => {
  assert.deepEqual(kindColorsFromPolicy({}), KIND_COLORS);
  assert.deepEqual(kindColorsFromPolicy(null), KIND_COLORS);
});

test('边类型：默认集与可选集不重叠，且都非空', () => {
  assert.ok(DEFAULT_EDGE_TYPES.length > 0);
  assert.ok(OPTIONAL_EDGE_TYPES.length > 0);
  for (const t of DEFAULT_EDGE_TYPES) assert.ok(!OPTIONAL_EDGE_TYPES.includes(t), `${t} 同时出现在两个集合`);
});

test('EDGE_PREF_KEY 是稳定的 localStorage 键（改它会静默丢用户偏好）', () => {
  assert.equal(EDGE_PREF_KEY, 'sedimem.graph.edges');
});

test('nodeRadius：随 hits 单调增，且有下限（单条记录也要点得中）', () => {
  const r1 = nodeRadius({ hits: 1 });
  const r5 = nodeRadius({ hits: 25 });
  assert.ok(r1 >= 3, '半径下限不足');
  assert.ok(r5 > r1, '半径未随权重增长');
  assert.ok(Number.isFinite(nodeRadius({})), '缺 hits 时必须返回有限数');
});
