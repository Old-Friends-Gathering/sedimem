// tests/unit/capture.test.js — B2 半自动捕获：抽取、队列、accept 入库、reject 不入库
// 临时 MEMO_HOME（mkdtemp），不碰真实库。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractCandidates } from '../../src/capture/extract.js';
import { createCaptureQueue } from '../../src/capture/queue.js';
import { captureCli } from '../../src/cli/capture.js';
import { createMemoryService } from '../../src/api/service.js';

const SCOPE = 'repo:sedimem-test';

function tmpMemoHome() {
  return mkdtempSync(path.join(tmpdir(), 'sedimem-capture-'));
}

const SAMPLE = [
  // —— 正例（>=6）——
  '记住：构建前要跑 pnpm install，否则 lockfile 会漂移', // 纯「记住」→ fact（无规范词）
  '约定以后代码评审必须两人通过才能合并', // 约定/必须 → decision（规范类）
  '不要在生产环境直接执行 DROP TABLE', // 引导词 不要 → decision
  '禁止把密钥写进配置文件', // 引导词 禁止 → decision
  '- 部署顺序是先迁移数据库再发后端最后发前端', // 列表项 fact
  '1. 每次发版后要在群里同步变更摘要', // 数字列表 fact
  '结论：这次延迟的根因是索引缺失', // 前缀 fact
  '注意：macOS 下 fs.watch 有去抖差异', // 前缀 gotcha
  '坑：pnpm 的 hoist 模式会放大幽灵依赖', // 前缀 gotcha
  '问题：偶发的连接池泄漏尚未定位', // 前缀 bug
  // —— 反例（>=4）——
  '```js',
  'const x = 1; // 代码块内的“决定”不算候选',
  '```',
  'https://example.com/docs/记住',
  '——！！！？？？……',
  '-- ',
  'Best regards,',
  'x'.repeat(500), // 超长行
  '今天天气不错', // 无命中引导词
].join('\n');

test('extractCandidates: 正例 >=6、反例 >=4、去重与 kind 正确', () => {
  const out = extractCandidates(SAMPLE);
  const texts = out.map((c) => c.text);

  // 正例数量 >= 6
  assert.ok(out.length >= 6, `expected >=6 candidates, got ${out.length}`);

  // 引导词分工（docs/02 裁决 62）：约定/决定/必须/禁止/不要 → decision；记住/记一下/以后 → fact
  assert.ok(out.some((c) => c.text.includes('DROP TABLE') && c.kind === 'decision'));
  assert.ok(out.some((c) => c.text.includes('密钥') && c.kind === 'decision'));
  assert.ok(out.some((c) => c.text.startsWith('记住：') && c.kind === 'fact'), '「记住」只是记录请求，落 fact');
  assert.ok(
    out.some((c) => c.text.startsWith('约定') && c.kind === 'decision'),
    '「约定」是规范，落 decision',
  );

  // 列表项 → fact
  assert.ok(out.some((c) => c.text.startsWith('- ') && c.kind === 'fact'));
  assert.ok(out.some((c) => c.text.startsWith('1. ') && c.kind === 'fact'));

  // 前缀映射
  assert.ok(out.some((c) => c.text.startsWith('结论：') && c.kind === 'fact'));
  assert.ok(out.some((c) => c.text.startsWith('注意：') && c.kind === 'gotcha'));
  assert.ok(out.some((c) => c.text.startsWith('坑：') && c.kind === 'gotcha'));
  assert.ok(out.some((c) => c.text.startsWith('问题：') && c.kind === 'bug'));

  // 反例：代码块内容 / URL / 纯标点 / 签名 / 超长 / 无引导词 都不出现
  for (const bad of ['const x = 1', 'https://example.com', '——！！！', 'Best regards', '今天天气不错']) {
    assert.ok(!texts.some((t) => t.includes(bad)), `should skip: ${bad}`);
  }
  assert.ok(!texts.some((t) => t.length > 400), 'should skip overlong lines');

  // 每条都有 reason；normalize 后无重复
  assert.ok(out.every((c) => typeof c.reason === 'string' && c.reason.length > 0));
  const dup = extractCandidates('记住 A 是 B\n记住 A 是 B');
  assert.equal(dup.length, 1);

  // maxItems 截断
  const many = Array.from({ length: 60 }, (_, i) => `记住 第${i}条规则`).join('\n');
  assert.equal(extractCandidates(many).length, 50);
});

test('capture 队列：add → list(pending) → accept 入库（active 增加、状态 accepted）', async () => {
  const memoHome = tmpMemoHome();
  try {
    const queue = createCaptureQueue({ memoHome, scope: SCOPE });
    const cands = extractCandidates(SAMPLE).filter((c) => c.kind !== 'bug');
    const { added } = queue.add(cands, { by: 'tester' });
    assert.equal(added.length, cands.length);
    assert.equal(queue.size(), cands.length);

    const pending = queue.list({ status: 'pending' });
    assert.equal(pending.length, cands.length);

    const service = await createMemoryService({ memoHome, scope: SCOPE });
    try {
      const before = (await service.stats()).active;
      const ids = pending.map((r) => r.id);
      const out = await queue.accept(ids, { service, by: 'tester' });
      assert.equal(out.accepted.length, ids.length);
      assert.equal(out.rejected.length, 0);

      const after = (await service.stats()).active;
      assert.ok(after > before, `active should increase: ${before} -> ${after}`);
      assert.equal(queue.list({ status: 'accepted' }).length, ids.length);
      assert.equal(queue.list({ status: 'pending' }).length, 0);
    } finally {
      await service.close();
    }
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('accept bug 候选回落 gotcha；重复 accept 幂等', async () => {
  const memoHome = tmpMemoHome();
  try {
    const queue = createCaptureQueue({ memoHome, scope: SCOPE });
    const { added } = queue.add([
      { text: '问题：偶发的连接池泄漏尚未定位', kind: 'bug', reason: '前缀 问题：' },
    ]);
    const id = added[0].id;

    const service = await createMemoryService({ memoHome, scope: SCOPE });
    try {
      const first = await queue.accept([id], { service, by: 'tester' });
      assert.equal(first.accepted.length, 1);
      assert.equal(first.accepted[0].action, 'created');

      // 幂等：同 id 再 accept 不重复入库
      const second = await queue.accept([id], { service, by: 'tester' });
      assert.equal(second.accepted.length, 0);
      assert.equal(second.rejected.length, 1);
      assert.match(second.rejected[0].reason, /already accepted/);

      const rec = await service.search('连接池');
      assert.equal(rec.items.length, 1);
      assert.equal(rec.items[0].record.kind, 'gotcha');
    } finally {
      await service.close();
    }
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('reject 不入库；重复文本 add 去重', async () => {
  const memoHome = tmpMemoHome();
  try {
    const queue = createCaptureQueue({ memoHome, scope: SCOPE });
    const { added } = queue.add([
      { text: '记住 网关超时是 3 秒', kind: 'fact', reason: '引导词 记住' },
    ]);
    // 重复文本入队被跳过
    const again = queue.add([{ text: '记住 网关超时是 3 秒', kind: 'fact', reason: 'dup' }]);
    assert.equal(again.added.length, 0);
    assert.equal(again.skipped.length, 1);

    const out = queue.reject([added[0].id], { note: '不需要' });
    assert.equal(out.rejected.length, 1);
    assert.equal(queue.list({ status: 'rejected' })[0].note, '不需要');

    const service = await createMemoryService({ memoHome, scope: SCOPE });
    try {
      const st = await service.stats();
      assert.equal(st.total, 0, 'rejected candidate must not enter store');
      // rejected 后 accept 也拒绝（非 pending）
      const acc = await queue.accept([added[0].id], { service });
      assert.equal(acc.accepted.length, 0);
    } finally {
      await service.close();
    }
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('captureCli scan/list/reject 走临时 MEMO_HOME', async () => {
  const memoHome = tmpMemoHome();
  process.env.MEMO_HOME = memoHome;
  try {
    const src = path.join(memoHome, 'input.txt');
    writeFileSync(src, '记住 备份窗口是每天凌晨两点\nhttps://skip.me\n', 'utf8');

    const scan = await captureCli({ sub: 'scan', file: src, scope: SCOPE, json: true });
    assert.equal(scan.candidates.length, 1);
    assert.equal(scan.added.length, 1);

    const list = await captureCli({ sub: 'list', scope: SCOPE, json: true });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'pending');

    const rej = await captureCli({
      sub: 'reject', scope: SCOPE, json: true, ids: [list[0].id], note: '测试拒绝',
    });
    assert.equal(rej.rejected.length, 1);
  } finally {
    delete process.env.MEMO_HOME;
    rmSync(memoHome, { recursive: true, force: true });
  }
});
