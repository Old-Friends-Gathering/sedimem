// I31 — 入库脱敏的四个面 + supersede 路径（v0.4 对抗审核 B1 的回归）
// 钉住：text/value/title/source.quote 都脱敏；supersede 不再绕过；tag 留痕；原文不落盘。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { itemsFileName } from '../../src/config/paths.js';

const AGENT = { agent: 'cli', quote: 'github token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123' };

async function makeService() {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i31-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i31', cwd: memoHome });
  return { service, memoHome };
}

async function truthFile(memoHome) {
  return fsp.readFile(path.join(memoHome, 'items', itemsFileName('repo:i31')), 'utf8');
}

test('I31 text / value / title / quote 四个面都脱敏且打 tag', async () => {
  const { service, memoHome } = await makeService();
  const res = await service.write({
    text: '部署用 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 这个 token',
    value: 'DB_PASSWORD=hunter2long',
    title: 'sk-abcdefghijklmnopqrstuvwxyz 的用法',
    source: AGENT,
    subject: 'deploy',
    predicate: 'token',
  });
  assert.equal(res.action, 'created');
  const disk = await truthFile(memoHome);
  assert.equal(disk.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'), false, 'github token 不得落盘');
  assert.equal(disk.includes('hunter2long'), false, 'value 里的口令不得落盘');
  assert.equal(disk.includes('sk-abcdefghijklmnopqrstuvwxyz'), false, 'title 里的 key 不得落盘');
  assert.equal(disk.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'), false, 'quote 不得漏');
  const rec = res.record;
  assert.ok(rec.tags.includes('redacted:github_token'), JSON.stringify(rec.tags));
  assert.ok(rec.tags.includes('redacted:assignment'), JSON.stringify(rec.tags));
  assert.ok(rec.tags.includes('redacted:api_key'), JSON.stringify(rec.tags));
  await service.close();
});

test('I31 supersede 也走脱敏（原来整段绕过）', async () => {
  const { service, memoHome } = await makeService();
  const created = await service.write({
    text: '连接串在文档里', subject: 'db', predicate: 'dsn', source: { agent: 'cli', quote: 'ok' },
  });
  const id = created.record.id;
  const out = await service.supersede({
    oldId: id,
    value: 'AKIAABCDEFGHIJKLMNOP',
    reason: '轮换',
  });
  const disk = await truthFile(memoHome);
  assert.equal(disk.includes('AKIAABCDEFGHIJKLMNOP'), false, 'supersede 的 value 不得明文落盘');
  assert.ok(out.record.tags.includes('redacted:aws_key'), JSON.stringify(out.record.tags));
  await service.close();
});
