// tests/unit/retitle.test.js — issue #61 第 5 项：`memo retitle` 回填。
// 契约：deriveTitle 是纯函数（不碰磁盘）；retitleRecords 只补缺 title 的记录，
// 以「追加同 id 补丁行 + retitle 事件」的方式写真相层（append-only，行数只增不减）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '../../src/api/service.js';
import { withPatch } from '../../src/core/record.js';
import { itemsFileName } from '../../src/config/paths.js';
import { deriveTitle, retitleRecords, TITLE_MAX } from '../../src/api/retitle.js';

// 三个真实 subject（交付要求里点名的那三条）
const REAL_SUBJECTS = [
  'Mac mini A4x Business Review 2026-11-06 停摆',
  'scheme-lead-review-role-redesign-20261103',
  'fae-kb 三方合并报告 already_covered',
];

let seq = 0;
function itemsPath(memoHome, scope) {
  return join(memoHome, 'items', itemsFileName(scope));
}
function readLines(memoHome, scope) {
  return readFileSync(itemsPath(memoHome, scope), 'utf8').trimEnd().split('\n');
}

/** 起一个临时 MEMO_HOME 的服务；用完 close + 删目录。 */
async function withService(fn) {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-retitle-'));
  const scope = `repo:retitle-${++seq}`;
  const svc = await createMemoryService({ memoHome, scope });
  try {
    await fn({ svc, memoHome, scope });
  } finally {
    await svc.close().catch(() => {});
    rmSync(memoHome, { recursive: true, force: true });
  }
}

async function seed(svc, subject, text = `正文：${subject}`) {
  const w = await svc.write({
    text,
    kind: 'fact',
    subject,
    predicate: 'p',
    value: text,
    source: { agent: 'retitle-test' },
  });
  return w.record.id;
}

// ————————————————————— deriveTitle（纯函数）————————————————————

test('deriveTitle：下划线 / 连字符折成空格，连续空白折成 1 个', () => {
  assert.equal(deriveTitle({ subject: 'fae_kb-already_covered' }), 'fae kb already covered');
  assert.equal(deriveTitle({ subject: '  a__b---c  ' }), 'a b c');
});

test('deriveTitle：剥掉尾部日期 slug，只吃日期本体、后面的中文保留', () => {
  assert.equal(deriveTitle({ subject: '评审 2026-11-06 停摆' }), '评审 停摆');
  assert.equal(deriveTitle({ subject: '方案评审 20261103' }), '方案评审');
  assert.equal(deriveTitle({ subject: '方案评审 2026/11/03' }), '方案评审');
});

test('deriveTitle：超长截到 24 字符（含 …），且不劈开英文单词', () => {
  const short = deriveTitle({ subject: 'x'.repeat(40) });
  assert.equal([...short].length, TITLE_MAX);
  assert.equal(short, `${'x'.repeat(TITLE_MAX - 1)}…`);
  // 24 位切点落在 "Review" 中间 → 退到最近空格
  assert.equal(deriveTitle({ subject: REAL_SUBJECTS[0] }), 'Mac mini A4x Business…');
  assert.ok([...deriveTitle({ subject: REAL_SUBJECTS[1] })].length <= TITLE_MAX);
});

test('deriveTitle：已有 title 原样返回（人工标题永远不覆盖）', () => {
  assert.equal(deriveTitle({ title: '人工写好的标题', subject: 'ignored_subject' }), '人工写好的标题');
  const long = 'z'.repeat(60); // 超长也照原样返回：调用方按「有 title 就跳过」处理
  assert.equal(deriveTitle({ title: long, subject: 'x' }), long);
});

test('deriveTitle：subject 为空 / 只剩日期或分隔符 → 空串', () => {
  assert.equal(deriveTitle({ subject: '' }), '');
  assert.equal(deriveTitle({ subject: '   ' }), '');
  assert.equal(deriveTitle({}), '');
  assert.equal(deriveTitle({ subject: '2026-11-03' }), '');
});

test('deriveTitle：slug 形态不盲删前缀；非 slug 的 `label:` 前缀才剥', () => {
  // scheme-… 归一后仍是 slug（ASCII > 60% 且 ≥2 空格）→ 保留原词，不做前缀手术
  assert.equal(deriveTitle({ subject: 'scheme-lead-review-20261103' }), 'scheme lead review');
  // 中文为主的 subject 不是 slug → 「Bug: 」这种无歧义标签可以剥
  assert.equal(deriveTitle({ subject: 'Bug: 登录页白屏问题' }), '登录页白屏问题');
});

// ————————————————————— retitleRecords（落盘）————————————————————

test('retitle：dryRun 报告 3 条且不落盘 → 实跑回填 3 条 → 再跑幂等 0 条', async () => {
  await withService(async ({ svc, memoHome, scope }) => {
    const ids = [];
    for (const subject of REAL_SUBJECTS) ids.push(await seed(svc, subject));

    const original = readLines(memoHome, scope);
    assert.equal(original.length, 3); // 种子 3 行，每行一条 v1 快照

    // —— dryRun：统计 + 样例，绝不写盘 ——
    const dry = await retitleRecords(svc, { dryRun: true });
    assert.equal(dry.total, 3);
    assert.equal(dry.changed, 3);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.samples.length, 3);
    assert.deepEqual(dry.samples.map((s) => s.id).sort(), [...ids].sort());
    assert.equal(dry.samples[0].title, 'Mac mini A4x Business…');
    assert.deepEqual(readLines(memoHome, scope), original); // 字节级没变

    // —— 实跑：每条追加一行 v2 补丁 ——
    const real = await retitleRecords(svc);
    assert.equal(real.total, 3);
    assert.equal(real.changed, 3);
    assert.deepEqual(real.failed, []);
    assert.equal(real.samples.length, 3);

    const after = readLines(memoHome, scope);
    assert.equal(after.length, original.length + 3); // 只增不减
    assert.deepEqual(after.slice(0, original.length), original); // 原行原样还在
    const patches = after.slice(original.length).map((l) => JSON.parse(l));
    for (const p of patches) {
      assert.equal(p.v, 2);
      assert.ok(p.title.length > 0 && [...p.title].length <= TITLE_MAX);
      assert.ok(ids.includes(p.id));
    }

    // 审计事件：一条记录一条 retitle 事件
    const { events } = await svc.events({ ops: ['retitle'], limit: 100 });
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.detail.title).sort(), patches.map((p) => p.title).sort());

    // —— 幂等：已有 title 直接跳过，不再追加任何行 ——
    const again = await retitleRecords(svc);
    assert.equal(again.changed, 0);
    assert.deepEqual(again.failed, []);
    assert.equal(readLines(memoHome, scope).length, after.length);

    // 搜索命中时能看到 title（title 已进真相层，不只是内存态）
    const { items } = await svc.search('business');
    const hit = items.map((it) => it.record).find((r) => r.id === ids[0]);
    assert.ok(hit, 'search 应能命中 Mac mini 那条');
    assert.equal(hit.title, 'Mac mini A4x Business…');
    assert.equal((await svc.get(ids[1])).title, deriveTitle({ subject: REAL_SUBJECTS[1] }));
  });
});

test('retitle：已有 title 与空 subject 都跳过；limit 限制单次回填条数', async () => {
  await withService(async ({ svc, memoHome, scope }) => {
    // 1) 手工写好 title 的记录：_commit 直写补丁行，等价于旧版本已回填过
    const titledId = await seed(svc, 'has_title_subject');
    const rec = svc._records.get(titledId);
    await svc._commit(withPatch(rec, { title: '人工标题' }), 'write', {});
    // 2) subject 为空：没有素材，不许写空标题
    const emptyId = await seed(svc, '');
    // 3) 唯一一条待回填
    const todoId = await seed(svc, 'proposal-上限验证-20261101');

    const before = readLines(memoHome, scope).length;
    const dry = await retitleRecords(svc, { dryRun: true });
    assert.equal(dry.total, 3);
    assert.equal(dry.changed, 1); // 只算第 3 条
    assert.equal(dry.samples[0].title, 'proposal 上限验证');

    const real = await retitleRecords(svc, { limit: 1 });
    assert.equal(real.changed, 1);
    assert.equal(real.samples[0].id, todoId);
    assert.equal(readLines(memoHome, scope).length, before + 1);

    const again = await retitleRecords(svc);
    assert.equal(again.changed, 0); // 人工标题、空 subject、已回填三条都不再动
    assert.equal(svc._records.get(titledId).title, '人工标题');
    assert.equal(svc._records.get(emptyId).title, undefined);
    assert.equal(svc._records.get(todoId).title, 'proposal 上限验证');
  });
});

test('retitle：同一 id 多版本只按 v 最大的那条判断（不给墓碑追加无意义 title）', async () => {
  const rows = [
    { id: 'same-id', v: 1, subject: 'old_subject' },
    { id: 'same-id', v: 3, title: '已被回填', subject: 'new_subject' },
    { id: 'other-id', v: 2, subject: 'another_subject' },
  ];
  const svc = {
    _ensureOpen() {},
    exportRecords: async () => ({ records: rows, total: rows.length, limited: false }),
  };
  const dry = await retitleRecords(svc, { dryRun: true });
  assert.equal(dry.total, 2); // 两个 id，不是一个版本行算一条
  assert.equal(dry.changed, 1);
  assert.equal(dry.samples[0].id, 'other-id');
});

test('retitle：limit 非负整数校验', async () => {
  const svc = {
    _ensureOpen() {},
    exportRecords: async () => ({ records: [], total: 0, limited: false }),
  };
  for (const bad of [-1, 1.5, '3', null]) {
    await assert.rejects(() => retitleRecords(svc, { dryRun: true, limit: bad }), /limit/);
  }
});
