// tests/unit/arch-parser.test.js — 解析器自身的攻击面（对抗审核提的 6 类绕过）
//
// 这些用例的作用不是"再测一遍业务"，而是证明 arch-boundaries 的断言**不是纸糊的**：
// 每一条都对应一个「看似拆干净、其实还能绕过」的写法。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSpecs, resolveSpec, loadSelfRef, findApiReverseDeps, stripComments,
} from '../support/arch-graph.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const selfRef = loadSelfRef(ROOT);
const fromFile = path.join(ROOT, 'src', 'web', 'scopes.js');

const specs = (src) => parseSpecs(src).map((s) => s.spec);

test('parseSpecs：三种引入形式都抓到（from / 副作用 import / 动态 import 字面量）', () => {
  const src = [
    "import { a } from '../mcp/server.js';",
    "import '../cli/curate.js';",
    "const m = await import('../mcp/validate.js');",
    "export * from '../mcp/scope-state.js';",
  ].join('\n');
  assert.deepEqual(specs(src), [
    '../mcp/server.js',
    '../cli/curate.js',
    '../mcp/validate.js',
    '../mcp/scope-state.js',
  ]);
});

test('parseSpecs：注释里的 from 不产生假边（行注释 / 块注释 / 注释里的 /*）', () => {
  const src = [
    '// 策略来自 hygiene/* 与 config/policy.json',
    "// import x from '../mcp/server.js';",
    '/*',
    " * 历史写法：import y from '../cli/memo.js'",
    ' */',
    "import { real } from '../core/clock.js';",
  ].join('\n');
  assert.deepEqual(specs(src), ['../core/clock.js']);
});

test('parseSpecs：字符串字面量里的 from 不误伤', () => {
  const src = "const hint = \"don't import from '../mcp/x.js'\";\nimport { a } from '../core/ids.js';";
  assert.deepEqual(specs(src), ['../core/ids.js']);
});

test('stripComments：保持长度与行号不变（错误定位依赖行号）', () => {
  const src = 'a\n// comment\nb /* x\ny */ c\n';
  const out = stripComments(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('resolveSpec：相对 / 不带 .js / 绝对路径 / self-reference', () => {
  const rel = resolveSpec({ root: ROOT, fromFile, spec: '../mcp/server.js', selfRef });
  assert.equal(rel, 'src/mcp/server.js');

  const noExt = resolveSpec({ root: ROOT, fromFile, spec: '../mcp/validate', selfRef });
  assert.equal(noExt, 'src/mcp/validate.js');

  // 绝对路径必须被解析回 src 内（否则「写成 /tmp/... 就绕过」）
  const abs = path.join(ROOT, 'src', 'cli', 'curate.js');
  assert.equal(resolveSpec({ root: ROOT, fromFile, spec: abs, selfRef }), 'src/cli/curate.js');

  // 裸包名（含 node: 内置）不算 src 依赖
  assert.equal(resolveSpec({ root: ROOT, fromFile, spec: 'node:fs', selfRef }), null);
  assert.equal(resolveSpec({ root: ROOT, fromFile, spec: 'some-pkg', selfRef }), null);
});

test('findApiReverseDeps：经 src/api/_shared.js 中转的间接反向依赖也能抓到', () => {
  const graph = new Map([
    ['src/api/retitle.js', [{ dep: 'src/api/_shared.js', line: 3 }]],
    ['src/api/_shared.js', [{ dep: 'src/api/service.js', line: 1 }]],
    ['src/api/lifecycle.js', [{ dep: 'src/core/errors.js', line: 8 }]],
  ]);
  const hits = findApiReverseDeps(graph, ['src/api/retitle.js', 'src/api/lifecycle.js']);
  assert.equal(hits.length, 1, `应只抓到 retitle 一条，实际：${JSON.stringify(hits)}`);
  assert.match(hits[0], /retitle\.js -> \.\.\. -> service\.js（经 src\/api\/_shared\.js:3）/);
});
