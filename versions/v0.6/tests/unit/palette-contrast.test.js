// 浅色主题适配（issue #115）：颜色压暗、雾化下限、节点描边，全部是纯函数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColor, contrastColor, fogAlphaFloor, nodeStroke, PALETTES,
} from '../../ui/palette.js';

const LIGHT = { light: true };
const DARK = { light: false };

test('parseColor 支持 #rgb / #rrggbb / rgb() / rgba()', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#5b9cf5'), { r: 91, g: 156, b: 245, a: 1 });
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseColor('rgba(148,163,184,0.5)'), { r: 148, g: 163, b: 184, a: 0.5 });
  assert.equal(parseColor('not-a-color'), null);
});

test('浅色下颜色被压暗，且保持色相与 alpha', () => {
  const out = contrastColor('#5b9cf5', LIGHT, 0.26);
  const c = parseColor(out);
  assert.ok(c.r < 91 && c.g < 156 && c.b < 245, `应更暗，实际 ${out}`);
  assert.equal(c.a, 1);
});

test('浅色下 rgba 的 alpha 被保留，通道被压暗', () => {
  const c = parseColor(contrastColor('rgba(148,163,184,0.5)', LIGHT, 0.42));
  assert.equal(c.a, 0.5);
  assert.ok(c.r < 148 && c.g < 163 && c.b < 184);
});

test('深色主题不改色（避免无谓抖动）', () => {
  assert.equal(contrastColor('#5b9cf5', DARK, 0.42), '#5b9cf5');
  assert.equal(contrastColor('rgba(148,163,184,0.5)', DARK, 0.42), 'rgba(148,163,184,0.5)');
});

test('雾化下限：浅色抬高（节点 0.55 / 边 0.46），深色保持原值', () => {
  assert.equal(fogAlphaFloor('node', LIGHT), 0.55);
  assert.equal(fogAlphaFloor('edge', LIGHT), 0.46);
  assert.equal(fogAlphaFloor('node', DARK), 0.35);
  assert.equal(fogAlphaFloor('edge', DARK), 0.12);
});

test('节点描边只在浅色下启用', () => {
  assert.equal(nodeStroke(DARK), null);
  const s = nodeStroke(LIGHT);
  assert.ok(s && s.color.includes('255') && s.width > 1);
});

test('两套调色板都带 light 标记，浅色的 nodeDim 比深色更深（避免被 alpha 抹平）', () => {
  assert.equal(PALETTES.DARK.light, false);
  assert.equal(PALETTES.LIGHT.light, true);
  const dim = (hex) => parseColor(hex).r;
  assert.ok(dim(PALETTES.LIGHT.nodeDim) < dim(PALETTES.DARK.nodeDim));
});
