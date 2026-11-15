import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SCOPE_PATTERN,
  clientKey,
  initScopeState,
  readScopeOverride,
  resolveUseTarget,
  scopeFilePath,
  writeScopeOverride,
} from '../../src/mcp/scope-state.js';

// 契约：docs/02 §3.6 裁决 28 —— 运行期分库选择
// 这一层的存在理由：MCP server 是常驻进程，cwd 固定；Claude/Codex 按项目 cwd 解析。
// 若 scope 不可在运行期切换，「三端共享一个记忆库」就是假的（DSH 永远写 dir:desktop）。

function tmpHome() {
  const dir = mkdtempSync(join(tmpdir(), 'memo-scope-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('scope-state：形状校验', () => {
  test('接受 repo:/dir:/user:/global: 前缀 + 小写字母数字与 . _ -', () => {
    for (const s of ['repo:demo-project', 'dir:work', 'user:alice', 'global:all', 'dir:a', 'repo:x.y_z-1']) {
      assert.ok(SCOPE_PATTERN.test(s), `应接受 ${s}`);
    }
  });
  test('拒绝大写/空白/中文/空名/超长/未知前缀', () => {
    for (const s of ['BAD SCOPE', 'repo:', 'repo:UPPER', 'dir:名字', 'tmp:abc', 'repo:' + 'a'.repeat(65), '']) {
      assert.equal(SCOPE_PATTERN.test(s), false, `应拒绝 ${JSON.stringify(s)}`);
    }
  });
});

describe('scope-state：clientKey 归一化（覆盖文件按客户端隔离）', () => {
  test('常见客户端名归一化', () => {
    assert.equal(clientKey('claude-code'), 'claude-code');
    assert.equal(clientKey('DSH'), 'dsh');
    assert.equal(clientKey('Codex CLI'), 'codex-cli');
    assert.equal(clientKey('my.bot_v2'), 'my-bot-v2');
  });
  test('空/未知/超长 → default 或截断（绝不产出空文件名）', () => {
    assert.equal(clientKey(undefined), 'default');
    assert.equal(clientKey(''), 'default');
    assert.equal(clientKey('!!!'), 'default');
    assert.equal(clientKey('a'.repeat(80)).length, 32);
  });
  test('不同客户端 → 不同文件（防止 DSH 的 scope 覆盖污染 Claude/Codex）', () => {
    assert.notEqual(scopeFilePath('/h', 'dsh'), scopeFilePath('/h', 'claude-code'));
    assert.equal(scopeFilePath('/h', 'dsh'), '/h/.scope.dsh.json');
  });
  test('两个客户端的覆盖互不影响', () => {
    const { dir, cleanup } = tmpHome();
    try {
      writeScopeOverride(dir, 'dir:proj-a', 'dsh');
      writeScopeOverride(dir, 'dir:proj-b', 'claude-code');
      assert.equal(readScopeOverride(dir, 'dsh'), 'dir:proj-a');
      assert.equal(readScopeOverride(dir, 'claude-code'), 'dir:proj-b');
      assert.equal(readScopeOverride(dir, 'codex'), undefined);
    } finally {
      cleanup();
    }
  });
});

describe('scope-state：持久化覆盖文件', () => {
  test('缺失 → undefined（不得抛错，否则 server 起不来）', () => {
    const { dir, cleanup } = tmpHome();
    try {
      assert.equal(readScopeOverride(dir), undefined);
    } finally {
      cleanup();
    }
  });
  test('损坏 JSON / 形状非法 → undefined（静默降级回 cwd，不 brick）', () => {
    const { dir, cleanup } = tmpHome();
    try {
      writeFileSync(scopeFilePath(dir), '{not json');
      assert.equal(readScopeOverride(dir), undefined);
      writeFileSync(scopeFilePath(dir), JSON.stringify({ scope: 'BAD SCOPE' }));
      assert.equal(readScopeOverride(dir), undefined);
      writeFileSync(scopeFilePath(dir), JSON.stringify({ scope: 'dir:ok' }));
      assert.equal(readScopeOverride(dir), 'dir:ok');
    } finally {
      cleanup();
    }
  });
  test('写入 → 可读回；父目录自动创建；非法 scope 抛 E_INVALID_ARG 且不落盘', () => {
    const { dir, cleanup } = tmpHome();
    try {
      const nested = join(dir, 'a', 'b');
      const file = writeScopeOverride(nested, 'dir:demo-project');
      assert.equal(file, scopeFilePath(nested));
      assert.equal(readScopeOverride(nested), 'dir:demo-project');
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(raw.scope, 'dir:demo-project');
      assert.ok(raw.at, '记录时间戳，便于排查「谁改的、什么时候改的」');

      assert.throws(() => writeScopeOverride(nested, 'BAD SCOPE'), /非法 scope|E_INVALID_ARG|shape/i);
      assert.equal(readScopeOverride(nested), 'dir:demo-project', '非法写入不得覆盖既有选择');
    } finally {
      cleanup();
    }
  });
});

describe('scope-state：启动优先级 env > 覆盖文件 > cwd', () => {
  const fakeResolve = ({ cwd }) => ({ scope: `dir:${String(cwd).split('/').pop()}`, root: cwd });
  test('MEMO_SCOPE 最高优先级', () => {
    const { dir, cleanup } = tmpHome();
    try {
      writeScopeOverride(dir, 'dir:fromfile');
      const st = initScopeState({ memoHome: dir, cwd: '/x/proj', env: { MEMO_SCOPE: 'repo:fromenv' }, resolveScope: fakeResolve });
      assert.deepEqual(st, { scope: 'repo:fromenv', source: 'env' });
    } finally {
      cleanup();
    }
  });
  test('空字符串 MEMO_SCOPE 视为未设置（避免 `MEMO_SCOPE=` 意外清空分库）', () => {
    const { dir, cleanup } = tmpHome();
    try {
      const st = initScopeState({ memoHome: dir, cwd: '/x/proj', env: { MEMO_SCOPE: '   ' }, resolveScope: fakeResolve });
      assert.deepEqual(st, { scope: 'dir:proj', source: 'cwd' });
    } finally {
      cleanup();
    }
  });
  test('无 env 时读覆盖文件', () => {
    const { dir, cleanup } = tmpHome();
    try {
      mkdirSync(dir, { recursive: true });
      writeScopeOverride(dir, 'dir:fromfile', 'dsh');
      const st = initScopeState({ memoHome: dir, cwd: '/x/proj', env: {}, resolveScope: fakeResolve, client: 'dsh' });
      assert.deepEqual(st, { scope: 'dir:fromfile', source: 'file:.scope.dsh.json' });
    } finally {
      cleanup();
    }
  });
  test('都没有 → 按 cwd 解析', () => {
    const { dir, cleanup } = tmpHome();
    try {
      const st = initScopeState({ memoHome: dir, cwd: '/x/proj', env: {}, resolveScope: fakeResolve });
      assert.deepEqual(st, { scope: 'dir:proj', source: 'cwd' });
    } finally {
      cleanup();
    }
  });
});

describe('scope-state：memory_scope(use) 的目标解析', () => {
  test('显式 scope 直接用，且不调用路径解析', () => {
    let called = false;
    const resolveScope = () => {
      called = true;
      return { scope: 'dir:x' };
    };
    assert.equal(resolveUseTarget({ scope: 'repo:demo-project', resolveScope }), 'repo:demo-project');
    assert.equal(called, false);
  });
  test('path → 复用 cwd 规则，且显式忽略 MEMO_SCOPE（env 传空对象）', () => {
    let got;
    const resolveScope = (args) => {
      got = args;
      return { scope: 'repo:demo-project' };
    };
    assert.equal(resolveUseTarget({ path: '/tmp/demo-project', resolveScope }), 'repo:demo-project');
    assert.equal(got.cwd, '/tmp/demo-project');
    assert.deepEqual(got.env, {}, '调用方说「按这个路径解析」，不该被 MEMO_SCOPE 再劫持一次');
  });
  test('相对路径 / 两者都缺 / 非法 scope 一律 E_INVALID_ARG（fail-loud，不猜）', () => {
    const resolveScope = () => ({ scope: 'dir:x' });
    assert.throws(() => resolveUseTarget({ path: 'relative/dir', resolveScope }), (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => resolveUseTarget({ resolveScope }), (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => resolveUseTarget({ scope: 'BAD SCOPE', resolveScope }), (e) => e.code === 'E_INVALID_ARG');
  });
});
