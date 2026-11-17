// p0b B5.3：隔离区只存引用（uri + hash + ≤200 字 quote），不存正文；
// TTL/配额与 inbox 同表；accept 只走人工提升。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createQuarantine } from '../../src/capture/quarantine.js';
import { createMemoryService } from '../../src/api/service.js';

const SCOPE = 'repo:p0b-quarantine';
const CLI = fileURLToPath(new URL('../../src/cli/memo.js', import.meta.url));
const BODY = 'RAW-BODY-SECRET-不应出现在隔离区';
const LONG_QUOTE = `引用摘要${'句'.repeat(300)}`;

function fresh() {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-quar-'));
  return { memoHome, q: createQuarantine({ memoHome, scope: SCOPE }) };
}

test('B5.3 只存引用：正文键被丢弃，quote 截到 ≤200 字，TTL 可标记过期', () => {
  const { memoHome, q } = fresh();
  try {
    const [row] = q.add({
      uri: 'https://example.com/page',
      hash: 'sha256:abc',
      quote: LONG_QUOTE,
      text: BODY, // 调用方误传正文：必须被丢弃
      body: BODY,
      content: BODY,
      addedBy: 'alice',
    });
    assert.equal(row.uri, 'https://example.com/page');
    assert.equal(row.hash, 'sha256:abc');
    assert.equal(row.quote.length, 201, '≤200 字 + 省略号');
    assert.ok(row.quote.endsWith('…'));
    assert.equal('text' in row, false);
    assert.equal('body' in row, false);
    assert.equal('content' in row, false);
    const raw = readFileSync(q._file, 'utf8');
    assert.equal(raw.includes(BODY), false, '隔离区文件绝不能有正文');
    assert.equal(raw.includes('RAW-BODY-SECRET'), false);
    assert.equal(q.list().length, 1);
    const expiredQ = createQuarantine({ memoHome, scope: SCOPE, ttlMs: 0 });
    assert.equal(expiredQ.list()[0].expired, true, '过期只标记，不静默删除');
    assert.equal(expiredQ.list().length, 1);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B5.3 uri/hash 必填；与 inbox 同配额表（E_QUEUE_QUOTA）', () => {
  const { memoHome } = fresh();
  try {
    const q = createQuarantine({ memoHome, scope: SCOPE, maxQueueBytes: 400 });
    assert.throws(() => q.add({ uri: 'only-uri' }), (e) => e.code === 'E_INVALID_ARG');
    assert.throws(() => q.add({ hash: 'only-hash' }), (e) => e.code === 'E_INVALID_ARG');
    let quota = null;
    for (let i = 0; i < 10 && quota === null; i++) {
      try {
        q.add({ uri: `https://e/${i}`, hash: `h${i}`, quote: 'x'.repeat(50), addedBy: 'alice' });
      } catch (e) {
        quota = e;
      }
    }
    assert.ok(quota, '超过 capture.maxQueueBytes 必须拒绝');
    assert.equal(quota.code, 'E_QUEUE_QUOTA');
    assert.match(quota.detail.file, /\.quarantine\.jsonl$/);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B5.3 accept 只走人工：--by 必填且 capture/auto 不能冒充人工', async () => {
  const { memoHome, q } = fresh();
  const svc = await createMemoryService({ memoHome, scope: SCOPE });
  try {
    const [row] = q.add({ uri: 'https://example.com/a', hash: 'sha256:aaa', quote: '值得记住的一句话', addedBy: 'alice' });
    await assert.rejects(() => q.accept([row.id], { service: svc, by: '' }), (e) => e.code === 'E_INVALID_ARG');
    await assert.rejects(() => q.accept([row.id], { service: svc, by: 'capture' }), (e) => e.code === 'E_INVALID_ARG');
    await assert.rejects(() => q.accept([row.id], { service: svc, by: 'auto' }), (e) => e.code === 'E_INVALID_ARG');

    const out = await q.accept([row.id], { service: svc, by: 'alice' });
    assert.deepEqual(out.accepted, [row.id]);
    const items = readFileSync(join(memoHome, 'items', readdirSync(join(memoHome, 'items'))[0]), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const rec = items.find((r) => r.text === '值得记住的一句话');
    assert.ok(rec, '人工提升后进真相层，文本只有 quote');
    assert.equal(rec.text.includes(BODY), false);
    assert.ok(rec.tags.includes('quarantine'));
    assert.equal(rec.source.quote, 'https://example.com/a#sha256:aaa', 'source.quote 只记引用，不复制正文');
    assert.equal(rec.source.agent, 'alice');
    // 幂等：重复 accept 不再落库
    const again = await q.accept([row.id], { service: svc, by: 'alice' });
    assert.deepEqual(again.accepted, []);
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B5.3 过期引用不能被提升；reject 不落真相层', async () => {
  const { memoHome } = fresh();
  const q = createQuarantine({ memoHome, scope: SCOPE, ttlMs: 0 });
  const svc = await createMemoryService({ memoHome, scope: SCOPE });
  try {
    const [row] = q.add({ uri: 'https://example.com/b', hash: 'h-b', quote: '过期引用', addedBy: 'alice' });
    const out = await q.accept([row.id], { service: svc, by: 'alice' });
    assert.deepEqual(out.accepted, []);
    assert.equal(out.skipped[0].reason, 'expired');
    const [row2] = q.add({ uri: 'https://example.com/c', hash: 'h-c', quote: '被拒绝', addedBy: 'alice' });
    assert.deepEqual(q.reject([row2.id], { by: 'alice' }).rejected, [row2.id]);
    assert.equal(q.list({ status: 'rejected' }).length, 1);
    const itemsDir = join(memoHome, 'items');
    let files = [];
    try { files = readdirSync(itemsDir); } catch { /* 没有 items 目录 */ }
    const allText = files.map((f) => readFileSync(join(itemsDir, f), 'utf8')).join('\n');
    assert.equal(allText.includes('被拒绝'), false, 'reject 绝不能进真相层');
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B5.3 CLI：list 只显示引用；accept 不带 --by 必须失败', () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-quar-cli-'));
  try {
    const q = createQuarantine({ memoHome, scope: SCOPE });
    const [row] = q.add({ uri: 'https://example.com/cli', hash: 'h-cli', quote: '命令行引用', addedBy: 'alice' });
    const env = { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: SCOPE };
    const list = spawnSync(process.execPath, [CLI, 'quarantine', 'list', '--json'], { env, encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    const payload = JSON.parse(list.stdout);
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].uri, 'https://example.com/cli');
    assert.equal(JSON.stringify(payload).includes(BODY), false);

    const noBy = spawnSync(process.execPath, [CLI, 'quarantine', 'accept', row.id], { env, encoding: 'utf8' });
    assert.notEqual(noBy.status, 0, 'accept 没有 --by 必须非零退出');
    assert.match(noBy.stderr, /人工/);

    const ok = spawnSync(process.execPath, [CLI, 'quarantine', 'accept', row.id, '--by', 'alice'], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /已提升 1 条/);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});
