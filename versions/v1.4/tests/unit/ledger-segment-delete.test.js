import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendSegment, readSegments, deleteSegment, segmentsFile } from '../../src/session/ledger.js';

function fixture(seqs) {
  const home = mkdtempSync(path.join(tmpdir(), 'memo-segdel-'));
  const taskId = '20260101-0000-aaaa';
  mkdirSync(path.join(home, 'sessions', taskId), { recursive: true });
  const anchor = path.join(home, 'sessions', taskId, 's.v4.jsonl.zstd');
  writeFileSync(anchor, 'x');
  return { home, taskId, anchor };
}

test('deleteSegment 追加墓碑，读视图隐藏，原行保留', async () => {
  const { home, taskId, anchor } = fixture();
  const a = await appendSegment({ memoHome: home, taskId, segment: { fromSeq: 1, toSeq: 10, anchor: { path: anchor }, summary: 'a' } });
  const b = await appendSegment({ memoHome: home, taskId, segment: { fromSeq: 10, toSeq: 20, anchor: { path: anchor }, summary: 'b' } });
  const res = await deleteSegment({ memoHome: home, taskId, id: a.segment.id, reason: 'test' });
  assert.equal(res.alreadyDeleted, false);
  const after = readSegments({ memoHome: home, taskId });
  assert.deepEqual(after.segments.map((s) => s.id), [b.segment.id]);
  const raw = readFileSync(segmentsFile(home, taskId), 'utf8');
  assert.match(raw, /segment-tombstone/);
  assert.match(raw, new RegExp(a.segment.id));
});

test('deleteSegment 幂等：重复删除不再追加墓碑', async () => {
  const { home, taskId, anchor } = fixture();
  const a = await appendSegment({ memoHome: home, taskId, segment: { fromSeq: 1, toSeq: 10, anchor: { path: anchor }, summary: 'a' } });
  await deleteSegment({ memoHome: home, taskId, id: a.segment.id });
  const before = readFileSync(segmentsFile(home, taskId), 'utf8').split('\n').filter(Boolean).length;
  const again = await deleteSegment({ memoHome: home, taskId, id: a.segment.id });
  assert.equal(again.alreadyDeleted, true);
  const after = readFileSync(segmentsFile(home, taskId), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before);
});

test('deleteSegment 未知 id fail-loud', async () => {
  const { home, taskId } = fixture();
  await assert.rejects(() => deleteSegment({ memoHome: home, taskId, id: 'nope' }), /E_SEGMENT_NOT_FOUND|不存在/);
});
