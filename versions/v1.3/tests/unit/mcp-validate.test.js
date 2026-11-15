// validateArgs —— MCP 参数校验器（fail-loud，替代形同虚设的 additionalProperties）
// 之前 20% 行覆盖 / 0% 函数覆盖：这个测试把每个关键字都走一遍。

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../../src/mcp/validate.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string' },
    kind: { type: 'string', enum: ['fact', 'decision'] },
    limit: { type: 'number', minimum: 1, maximum: 50 },
    scope: { type: 'string', pattern: '^(repo|dir):[a-z0-9._-]+$' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

test('validateArgs：合法参数通过', () => {
  const r = validateArgs(SCHEMA, { text: 'x', kind: 'fact', limit: 5, scope: 'repo:a', tags: ['t'] });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('validateArgs：未知参数被拒（additionalProperties:false 真的生效）', () => {
  const r = validateArgs(SCHEMA, { text: 'x', nope: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('nope')), JSON.stringify(r.errors));
});

test('validateArgs：缺必填 / 类型错 / enum 越界 / 数值越界 / pattern 不符 / items 类型错 全部报出', () => {
  const cases = [
    [{}, 'text'],
    [{ text: 1 }, '类型'],
    [{ text: 'x', kind: 'nope' }, '取值越界'],
    [{ text: 'x', limit: 0 }, 'minimum'],
    [{ text: 'x', limit: 51 }, 'maximum'],
    [{ text: 'x', scope: 'bad' }, 'pattern'],
    [{ text: 'x', tags: [1] }, 'tags[0] 类型不符'],
  ];
  for (const [args, needle] of cases) {
    const r = validateArgs(SCHEMA, args);
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(args)}`);
    assert.ok(r.errors.some((e) => e.includes(needle)), `${JSON.stringify(args)} → ${JSON.stringify(r.errors)}`);
  }
});

test('validateArgs：非对象参数直接拒', () => {
  for (const bad of [null, 'x', 42, []]) {
    const r = validateArgs(SCHEMA, bad);
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
  }
});
