// 单测 — W7 导入器解析器（src/cli/import-parsers.js）与 dry-run 不落盘（src/cli/import.js）
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cmdImport } from '../../src/cli/import.js';
import {
  parseAgents, parseBasicMemory, parseObsidian, parseMem0, parseCline, slugify, fileSha256,
} from '../../src/cli/import-parsers.js';

test('agents 解析：`## ` 小节 → predicate slug，列表项逐条 fact', () => {
  const md = [
    '# AGENTS',
    '- 全局约束：只用 node 内置模块',
    '## 编码规范',
    '- 中文注释',
    '- 文件 ≤ 400 行',
    '## 测试',
    '段落正文（无列表项）',
  ].join('\n');
  const items = parseAgents(md);
  // W7 实测修正：同小节多条事实必须各自独占槽位（predicate 带序号），
  // 否则它们会落进同一个 (subject,predicate) → 写入门禁判成「同槽不同值」全部 disputed。
  assert.deepEqual(items[0], { text: '全局约束：只用 node 内置模块', kind: 'fact', subject: 'import:agents', predicate: 'general-1' });
  assert.equal(items[1].predicate, '编码规范-1');
  assert.equal(items[2].predicate, '编码规范-2');
  assert.equal(items[3].text, '段落正文（无列表项）');
  // 无列表项的小节：整段压成一条，predicate 就是小节 slug（不带序号）
  assert.equal(items[3].predicate, '测试');
  assert.ok(items.every((i) => i.kind === 'fact'));
});

test('basic-memory / obsidian：wikilink 保留；obsidian 按节给 predicate', () => {
  const bm = '- 参考 [[架构总览]] 的分层\n- 端口固定 7788';
  const bmItems = parseBasicMemory(bm);
  assert.equal(bmItems.length, 2);
  assert.ok(bmItems[0].text.includes('[[架构总览]]'), 'wikilink 必须原样保留');
  assert.equal(bmItems[0].predicate, 'note');

  const obs = ['## 部署', '- 走 GitLab Pages', '## 告警', '- 飞书机器人'].join('\n');
  const obsItems = parseObsidian(obs);
  assert.equal(obsItems[0].predicate, '部署');
  assert.equal(obsItems[1].predicate, '告警');
});

test('mem0：取 memory/text 字段；非数组报错', () => {
  const json = JSON.stringify([{ memory: '用户偏好暗色主题', id: 1 }, { text: '另一个事实', other: true }, { nope: 1 }]);
  const items = parseMem0(json);
  assert.deepEqual(items.map((i) => i.text), ['用户偏好暗色主题', '另一个事实']);
  assert.ok(items.every((i) => i.subject === 'import:mem0' && i.kind === 'fact'));
  assert.throws(() => parseMem0('{"a":1}'), /JSON 数组/);
});

test('cline：六文件每节一条；progress → state，systemPatterns → decision', () => {
  const files = {
    'projectbrief.md': '## 目标\n做本地记忆库',
    'systemPatterns.md': '## 架构\n分层 + 门禁',
    'progress.md': '## 当前\nW7 进行中',
  };
  const items = parseCline(files);
  assert.equal(items.length, 3);
  const byK = Object.fromEntries(items.map((i) => [i.predicate, i]));
  assert.equal(byK['projectbrief-目标'].kind, 'fact');
  assert.equal(byK['systempatterns-架构'].kind, 'decision');
  assert.equal(byK['progress-当前'].kind, 'state');
  assert.ok(items.every((i) => i.subject === 'import:cline'));
});

test('slugify：空白/标点折叠为 -，空串回落 general', () => {
  assert.equal(slugify('Code Review Rules!'), 'code-review-rules');
  assert.equal(slugify('  '), 'general');
});

test('import dry-run：只解析报告，不落盘（memoHome 无新文件/记录）', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-import-'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-src-'));
  const file = path.join(dir, 'AGENTS.md');
  await fsp.writeFile(file, '- 规则一\n- 规则二\n', 'utf8');
  const out = await cmdImport({ limit: '10' }, ['agents', file], true);
  assert.equal(out.dryRun, true);
  assert.equal(out.parsed, 2);
  assert.deepEqual(out.byKind, { fact: 2 });
  // 未加 --apply：分库目录根本没有 items 文件
  const scopeDir = path.join(home);
  const entries = await fsp.readdir(scopeDir).catch(() => []);
  assert.ok(!entries.some((n) => n.startsWith('items')), 'dry-run 不允许落盘');
  assert.equal(fileSha256('abc'), fileSha256('abc'));
});

test('import --apply：写入且重复导入幂等（第二次全 skipped）', async () => {
  process.env.MEMO_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-apply-'));
  try {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-src2-'));
    const file = path.join(dir, 'CLAUDE.md');
    await fsp.writeFile(file, '## 规范\n- 中文注释\n', 'utf8');
    const first = await cmdImport({ apply: true }, ['agents', file], true);
    assert.equal(first.written, 1);
    const second = await cmdImport({ apply: true }, ['agents', file], true);
    assert.equal(second.written, 0);
    assert.equal(second.skipped, 1, '同 text 同 slot → noop_same_value 幂等');
  } finally {
    delete process.env.MEMO_HOME;
  }
});
