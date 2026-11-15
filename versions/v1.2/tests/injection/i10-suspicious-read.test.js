import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';

const CASE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../eval/cases/i10-suspicious-read.json'), 'utf8'),
);

test('I10 suspicious 读路径：默认 search/get 正文为 [suspicious withheld]，includeSuspicious:true 才见原文，brief 永不见', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-'));
  let svc;
  try {
    svc = await createMemoryService({ memoHome, scope: 'repo:eval-i10' });

    // 裁决 16：写入照收（拒绝写入会让用户丢掉真实信息）
    const w = await svc.write({
      text: CASE.text, kind: 'fact',
      subject: CASE.subject, predicate: CASE.predicate,
      source: { agent: 'test' },
    });
    assert.ok(typeof w.action === 'string', '投毒文本写入应成功并返回 action');

    // 默认 search：能命中，但 text 必须是 [suspicious withheld]
    const def = await svc.search(CASE.query);
    const hit = def.items.find((it) => it.record.id === w.record.id);
    assert.ok(hit, '默认 search 应能命中 suspicious 记录（只是隔离正文）');
    assert.equal(
      hit.record.text, CASE.withheld,
      `默认 search 的 text 必须是 ${CASE.withheld}，实际 ${JSON.stringify(hit.record.text)}`,
    );

    // includeSuspicious:true 才见原文
    const raw = await svc.search(CASE.query, { includeSuspicious: true });
    const rawHit = raw.items.find((it) => it.record.id === w.record.id);
    assert.ok(rawHit, 'includeSuspicious:true 应命中该记录');
    assert.equal(rawHit.record.text, CASE.text, 'includeSuspicious:true 应返回原文');

    // get 默认同样隔离
    const got = await svc.get(w.record.id);
    assert.ok(got, 'get 应返回记录');
    assert.equal(got.text, CASE.withheld, `get 默认 text 必须是 ${CASE.withheld}，实际 ${JSON.stringify(got.text)}`);

    // brief 永远不返回原文（含敏感路径片段）
    const brief = await svc.brief();
    assert.ok(!brief.includes('~/.ssh'), 'brief 不得包含敏感路径 ~/.ssh');
    assert.ok(!brief.includes(CASE.text), 'brief 不得包含投毒原文');
  } finally {
    if (svc) await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
});
