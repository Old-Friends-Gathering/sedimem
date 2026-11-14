// tests/unit/arch-boundaries.test.js — 架构边界断言（解析器在 tests/support/arch-graph.js）
//
// 把「分层规则」变成测试：每次 CI 都扫 src/** 的 import 建图，断言五类边界。
// 违规必须带 `文件:行`，让修复一步到位。解析器的攻击面由 arch-parser.test.js 单独守着
// （副作用 import / 动态 import / 绝对路径 / self-reference / 注释假边 / 间接反向依赖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGraph, findCycles, findForbidden, findApiReverseDeps,
} from '../support/arch-graph.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const graph = buildGraph(ROOT);

const fmt = (hits) => hits.map((h) => `${h.from}:${h.line} -> ${h.dep}`).join('\n');

test('arch：src 内 import 图无环', () => {
  const cycles = findCycles(graph);
  assert.deepEqual(
    cycles.map((c) => c.join(' -> ')),
    [],
    `发现循环依赖：\n${cycles.map((c) => c.join(' -> ')).join('\n')}`,
  );
});

test('arch：src/web/** 不得 import src/mcp/** 或 src/cli/**', () => {
  const hits = findForbidden(graph, ['src/web/'], ['src/mcp/', 'src/cli/']);
  assert.deepEqual(hits.map((h) => `${h.from}:${h.line} -> ${h.dep}`), [], `web 层反向依赖：\n${fmt(hits)}`);
});

test('arch：src/mcp/** 不得 import src/cli/** 或 src/storage/**', () => {
  const hits = findForbidden(graph, ['src/mcp/'], ['src/cli/', 'src/storage/']);
  assert.deepEqual(hits.map((h) => `${h.from}:${h.line} -> ${h.dep}`), [], `mcp 层反向依赖：\n${fmt(hits)}`);
});

test('arch：src/session/** 不得 import src/mcp/**（也不得 import api/service.js）', () => {
  const hits = findForbidden(graph, ['src/session/'], ['src/mcp/', 'src/api/service.js']);
  assert.deepEqual(hits.map((h) => `${h.from}:${h.line} -> ${h.dep}`), [], `session 层反向依赖：\n${fmt(hits)}`);
});

test('arch：api 拆分模块不得（直接或间接）import src/api/service.js', () => {
  const split = [
    'src/api/lifecycle.js',
    'src/api/write-path.js',
    'src/api/search-path.js',
    'src/api/maintenance.js',
    'src/api/read-only.js',
    'src/api/retitle.js',
  ];
  const hits = findApiReverseDeps(graph, split);
  assert.deepEqual(hits, [], `api 拆分模块回依赖 service.js：\n${hits.join('\n')}`);
});

test('arch：建图自检（图非空、含已知边、三种引入形式都被抓到）', () => {
  assert.ok(graph.size > 10, `src 图节点过少: ${graph.size}`);
  const depsOf = (k) => (graph.get(k) ?? []).map((d) => d.dep);
  assert.ok(depsOf('src/api/service.js').includes('src/api/lifecycle.js'), 'service → lifecycle 缺失');
  assert.ok(depsOf('src/mcp/server.js').includes('src/session/cli-support.js'), 'mcp → session/cli-support 缺失');
  // web/server.js 用 `import { createMemoryService } from '../api/service.js'`（静态 from 形式）
  assert.ok(depsOf('src/web/server.js').includes('src/api/service.js'), 'web → api/service 缺失');
});
