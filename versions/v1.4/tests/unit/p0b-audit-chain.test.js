// p0b B5.4：events.jsonl 统一审计（kind + seq + prevHash），本地哈希链校验与可选 git 锚。
// 边界（必须如实）：**不抗同 UID 重算**——能改写 events.jsonl 的人也能重算整条链；
// 这里只保证「静态改动/截断/乱序」能被发现，以及把链头写进本地文件/git 供外部留痕。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createMemoryService } from '../../src/api/service.js';
import { eventHash, verifyEventChain, readAuditHead, writeAnchor } from '../../src/storage/audit.js';
import { withAuditFields } from '../../src/storage/audit.js';

const SCOPE = 'repo:p0b-audit';
const CLI = fileURLToPath(new URL('../../src/cli/memo.js', import.meta.url));

function readEvents(memoHome) {
  return readFileSync(join(memoHome, 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
}

function runCli(memoHome, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, MEMO_HOME: memoHome, MEMO_SCOPE: SCOPE },
    encoding: 'utf8',
  });
}

test('B5.4 写入事件带 kind/seq/prevHash，链可校验', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-audit-'));
  const svc = await createMemoryService({ memoHome, scope: SCOPE });
  try {
    await svc.write({ kind: 'fact', text: '审计探针一', source: { agent: 'test' } });
    await svc.write({ kind: 'fact', text: '审计探针二', source: { agent: 'test' } });
    const events = readEvents(memoHome);
    assert.ok(events.length >= 2);
    for (const ev of events) {
      assert.equal(typeof ev.kind, 'string');
      assert.ok(Number.isInteger(ev.seq) && ev.seq >= 1);
      assert.equal(typeof ev.hash, 'string');
      assert.ok(ev.hash.length > 10);
    }
    assert.equal(events[0].prevHash, null);
    assert.equal(events[1].prevHash, eventHash(events[0]));
    assert.equal(events[1].seq, events[0].seq + 1);
    const verify = verifyEventChain(events);
    assert.equal(verify.ok, true, JSON.stringify(verify.broken));
    assert.equal(verify.chained, events.length);
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B5.4 篡改事件 detail 后链校验失败（静态改动可发现）', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-tamper-'));
  const svc = await createMemoryService({ memoHome, scope: SCOPE });
  try {
    await svc.write({ kind: 'fact', text: '原始结论', source: { agent: 'test' } });
    const events = readEvents(memoHome);
    const tampered = events.map((e, i) => (i === events.length - 1 ? { ...e, detail: { ...e.detail, text: '被改过' } } : e));
    const verify = verifyEventChain(tampered);
    assert.equal(verify.ok, false);
    assert.ok(verify.broken.length > 0);
    assert.match(verify.broken[0].reason, /hash|prevHash|seq/);
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B5.4 旧版无链事件不阻断：跳过它们并只校验链内行', () => {
  const legacy = [
    { ts: '2026-11-01T00:00:00.000Z', op: 'write', scope: SCOPE, id: 'x', detail: {} },
  ];
  const prev = withAuditFields({ ts: '2026-11-02T00:00:00.000Z', op: 'write', scope: SCOPE, id: 'y', detail: {} }, legacy[0]);
  const verify = verifyEventChain([...legacy, prev]);
  assert.equal(verify.ok, true, JSON.stringify(verify.broken));
  assert.equal(verify.chained, 1, '只有带 hash 的行计入链');
});

test('B5.4 readAuditHead 只读尾部：末尾半行不会污染链头', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-head-'));
  try {
    const first = withAuditFields({ ts: 't', op: 'write', scope: SCOPE, id: null, detail: {} }, null);
    writeFileSync(join(memoHome, 'events.jsonl'), `${JSON.stringify(first)}\n{"partial":`);
    const head = await readAuditHead(join(memoHome, 'events.jsonl'));
    assert.equal(head.hash, first.hash);
    assert.equal(await readAuditHead(join(memoHome, 'missing.jsonl')), null);
  } finally {
    rmSync(memoHome, { recursive: true, force: true });
  }
});

test('B5.4 锚文件写链头；memo audit verify 退出码 0/1 可判', async () => {
  const memoHome = mkdtempSync(join(tmpdir(), 'memo-p0b-anchor-'));
  const svc = await createMemoryService({ memoHome, scope: SCOPE });
  try {
    await svc.write({ kind: 'fact', text: '锚定探针', source: { agent: 'test' } });
    const events = readEvents(memoHome);
    await writeAnchor({ memoHome, events });
    assert.ok(existsSync(join(memoHome, 'events.anchor.json')));
    const disk = JSON.parse(readFileSync(join(memoHome, 'events.anchor.json'), 'utf8'));
    assert.equal(disk.chainHead, eventHash(events[events.length - 1]));
    assert.equal(disk.count, events.length);
    assert.match(disk.note, /不抗同 UID 重算/);

    const ok = runCli(memoHome, ['audit', 'verify']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /OK/);

    // 篡改最后一行（保持 JSON 可解析）→ 退出码 1
    const lines = readFileSync(join(memoHome, 'events.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    last.detail = { ...last.detail, evil: true };
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(join(memoHome, 'events.jsonl'), `${lines.join('\n')}\n`);
    const bad = runCli(memoHome, ['audit', 'verify']);
    assert.equal(bad.status, 1, '链断必须是业务失败退出码');
    assert.match(bad.stdout, /链断裂/);
  } finally {
    await svc.close();
    rmSync(memoHome, { recursive: true, force: true });
  }
});
