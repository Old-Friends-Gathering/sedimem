// I26 — 入库脱敏（v0.4 D7 / issue #104）
// 钉住：凭据在**进真相层之前**就被遮掉（磁盘上看不到原文）、脱敏痕迹进 tags、
// 原文不可检索、且脱敏幂等（重复脱敏不产生 [REDACTED:[REDACTED:…]] 嵌套）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryService } from '../../src/api/service.js';
import { redactText } from '../../src/hygiene/redact.js';

const SRC = { agent: 'test' };
const TOKEN = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function readAll(memoHome) {
  const dir = path.join(memoHome, 'items');
  const out = [];
  for (const name of await fsp.readdir(dir)) out.push(await fsp.readFile(path.join(dir, name), 'utf8'));
  return out.join('\n');
}

test('I26 令牌先脱敏再落盘：磁盘无原文、tags 留痕、检索不到原文', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i26-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i26', cwd: memoHome });
  try {
    const w = await service.write({
      text: `部署用的 GitHub 令牌是 ${TOKEN}，别外传`,
      kind: 'gotcha',
      source: SRC,
    });
    assert.equal(w.action, 'created');
    assert.ok(w.record.tags.includes('redacted:github_token'), `tags: ${w.record.tags}`);
    assert.ok(!w.record.text.includes(TOKEN), '返回的记录里也不能有原文');

    const onDisk = await readAll(memoHome);
    assert.ok(!onDisk.includes(TOKEN), '真相层磁盘上不得出现原文');

    const found = await service.search(TOKEN, { limit: 10 });
    assert.equal(found.items.length, 0, '原文不可被检索（不可逆遮蔽）');
    const foundByTopic = await service.search('GitHub 令牌 部署', { limit: 10 });
    assert.ok(foundByTopic.items.length >= 1, '脱敏后仍可按上下文检索到该条');

    // 幂等：对已脱敏文本再跑一次不产生嵌套遮蔽
    const again = redactText(w.record.text);
    assert.equal(again.changed, false, `重复脱敏应无变化，实际 ${JSON.stringify(again.redactions)}`);
    assert.ok(!again.text.includes('[REDACTED:[REDACTED:'));
  } finally {
    await service.close();
  }
});

test('I26 关掉脱敏（policy.redact.enabled=false）时行为回到 0.3.x', async () => {
  const memoHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'memo-i26b-'));
  const service = await createMemoryService({ memoHome, scope: 'repo:i26b', cwd: memoHome, policy: { redact: { enabled: false } } });
  try {
    const w = await service.write({ text: `令牌 ${TOKEN} 明文写入`, kind: 'state', source: SRC });
    assert.ok(w.record.text.includes(TOKEN), '显式关闭时必须保持原样（可回退）');
    assert.ok(!w.record.tags.some((t) => t.startsWith('redacted:')), '不脱敏就不打痕迹 tag');
  } finally {
    await service.close();
  }
});
