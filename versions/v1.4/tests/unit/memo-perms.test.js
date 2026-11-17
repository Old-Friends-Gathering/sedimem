// tests/unit/memo-perms.test.js — B4：`~/.memo` 0700 / 文件 0600 + 启动自查只告警
// 契约：docs/02 §3.24、docs/08 §7。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  MEMO_DIR_MODE, MEMO_FILE_MODE, describePermIssues, ensureMemoDir, inspectMemoPerms, isModePrivate,
} from '../../src/config/perms.js';
import { issueWebToken, readWebToken, webTokenPath } from '../../src/config/web-token.js';
import { createMemoryService } from '../../src/api/service.js';
import { scopeFilePath, writeScopeOverride } from '../../src/core/scope-state.js';

const modeOf = async (p) => (await fs.stat(p)).mode & 0o777;

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-perms-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('B4 权限：ensureMemoDir 新建 0700，token 文件 0600 且每次启动重新生成', async (t) => {
  const home = await tempHome(t);
  const nested = path.join(home, 'a', 'b');
  await ensureMemoDir(nested);
  assert.equal(await modeOf(nested), MEMO_DIR_MODE);

  const first = await issueWebToken(nested);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/, 'token 必须是 32 字节 base64url（43 字符），不是固定常量');
  assert.equal(await modeOf(webTokenPath(nested)), MEMO_FILE_MODE);
  assert.equal(await readWebToken(nested), first);

  const second = await issueWebToken(nested);
  assert.notEqual(second, first, '每次 serve 启动重新生成会话 token');
  assert.equal(await readWebToken(nested), second);
  assert.equal(await modeOf(webTokenPath(nested)), MEMO_FILE_MODE, '重新生成后仍是 0600');
});

test('B4 权限：启动自查发现宽权限 → issues + 告警文案（不阻断）', async (t) => {
  const home = await tempHome(t);

  // 目录 0755 + 一个 0644 的事件文件：现实中最常见的存量状态
  await fs.chmod(home, 0o755);
  await fs.writeFile(path.join(home, 'events.jsonl'), '', { mode: 0o644 });
  await fs.chmod(path.join(home, 'events.jsonl'), 0o644);
  await fs.writeFile(webTokenPath(home), `${'a'.repeat(43)}\n`, { mode: 0o644 });
  await fs.chmod(webTokenPath(home), 0o644);

  const report = await inspectMemoPerms(home);
  assert.equal(report.ok, false);
  const kinds = report.issues.map((i) => `${i.kind}:${path.basename(i.path)}`);
  assert.ok(kinds.includes('dir:memo-perms-') || report.issues.some((i) => i.kind === 'dir'), '应报告目录权限过宽');
  assert.ok(report.issues.some((i) => i.kind === 'file' && i.path.endsWith('events.jsonl')));
  assert.ok(report.issues.some((i) => i.kind === 'file' && i.path.endsWith('web-token')));
  assert.ok(report.issues.every((i) => i.expected === MEMO_DIR_MODE || i.expected === MEMO_FILE_MODE));

  const lines = describePermIssues(report);
  assert.equal(lines.length, report.issues.length);
  assert.match(lines[0], /权限过宽/);
  assert.match(lines[0], /建议 0[67]00/);

  // 收窄后自查通过（服务不替用户 chmod，用户显式修完再确认）
  await fs.chmod(home, 0o700);
  await fs.chmod(path.join(home, 'events.jsonl'), 0o600);
  await fs.chmod(webTokenPath(home), 0o600);
  const fixed = await inspectMemoPerms(home);
  assert.equal(fixed.ok, true);
  assert.deepEqual(describePermIssues(fixed), []);
});

test('B4 权限：Windows 明确不承诺 mode 位（skipped，不误报）', async (t) => {
  const home = await tempHome(t);
  await fs.chmod(home, 0o755);
  const report = await inspectMemoPerms(home, { platform: 'win32' });
  assert.equal(report.skipped, true);
  assert.equal(report.ok, true);
  assert.equal(report.issues.length, 0);
  assert.deepEqual(describePermIssues(report), []);
});

test('B4 权限：真实写库落在 0600 文件上（items / events），目录 0700', async (t) => {
  const home = await tempHome(t);
  const service = await createMemoryService({ memoHome: home, scope: 'repo:perms-write' });
  t.after(() => service.close());
  await service.write({
    text: '权限回归：真相层文件必须 0600', kind: 'fact', source: { agent: 'test' },
  });
  const itemsDir = path.join(home, 'items');
  assert.equal(await modeOf(itemsDir), MEMO_DIR_MODE, 'items 目录应 0700');
  assert.equal(await modeOf(path.join(itemsDir, 'repo:perms-write.jsonl')), MEMO_FILE_MODE);
  assert.equal(await modeOf(path.join(home, 'events.jsonl')), MEMO_FILE_MODE);
});

test('B4 权限：分库覆盖文件（配置）也是 0600，并纳入启动自查', async (t) => {
  const home = await tempHome(t);
  const file = writeScopeOverride(home, 'repo:perms-scope', 'dsh');
  assert.equal(file, scopeFilePath(home, 'dsh'));
  assert.equal(await modeOf(file), MEMO_FILE_MODE);

  // 存量宽权限的覆盖文件要被自查抓到（不静默放过）
  await fs.chmod(file, 0o644);
  const report = await inspectMemoPerms(home);
  assert.ok(report.issues.some((i) => i.kind === 'file' && i.path === file));
});

test('B4 权限：isModePrivate 只看 group/other 位', () => {
  assert.equal(isModePrivate(0o700), true);
  assert.equal(isModePrivate(0o600), true);
  assert.equal(isModePrivate(0o755), false);
  assert.equal(isModePrivate(0o644), false);
  assert.equal(isModePrivate(0o770), false);
});
