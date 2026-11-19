// evidence.mjs 的 TDD 测试（先红后绿）
// 规格：docs/design/v2.0/09-extraction-pipeline.md §3 R3 五条机判 / §4 stale
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codePointLength,
  sliceByCodePoints,
  resolveEvidence,
  createSnapshotStore,
  hashText,
} from '../tools/evidence.mjs';

const events = new Map([
  [
    'S1-m001',
    {
      eventId: 'S1-m001',
      role: 'user',
      ts: '2026-11-19T00:00:00Z',
      text: '端口是 8080，超时改成 30 秒。',
    },
  ],
  [
    'S1-m002',
    {
      eventId: 'S1-m002',
      role: 'assistant',
      ts: '2026-11-19T00:01:00Z',
      text: '收到 🙏 我用 8080 重试了一次，仍然失败。',
    },
  ],
]);

test('T-B1 码点 span：多字节/emoji 文本的偏移按码点而非 UTF-16', () => {
  const text = events.get('S1-m002').text; // 含 emoji（代理对）
  assert.equal(text.length > codePointLength(text), true, '该文本应含代理对');
  const ev = { eventId: 'S1-m002', quote: '仍然失败' };
  const r = resolveEvidence({ events, evidence: [ev] });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  const item = r.evidence[0];
  assert.equal(sliceByCodePoints(text, item.span.start, item.span.end), '仍然失败');
  assert.equal(item.hash, hashText(text));
});

test('T-B2 quote 超 200 字符 → evidence-unsupported（quote-too-long）', () => {
  const long = 'a'.repeat(201);
  const r = resolveEvidence({
    events: new Map([['E1', { eventId: 'E1', role: 'user', ts: '', text: long }]]),
    evidence: [{ eventId: 'E1', quote: long }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].reason, 'quote-too-long');
});

test('T-B3 quote 不是切出子串的前缀 → evidence-unsupported（quote-span-mismatch）', () => {
  const r = resolveEvidence({
    events,
    evidence: [{ eventId: 'S1-m001', quote: '端口是 8081', span: { start: 0, end: 8 } }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].reason, 'quote-span-mismatch');
});

test('T-B4 quote 来自别的会话/文本 → quote-not-found（不是相似度兜底）', () => {
  const r = resolveEvidence({
    events,
    evidence: [{ eventId: 'S1-m001', quote: '端口是 8081，超时改成 30 秒。' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].reason, 'quote-not-found');
});

test('T-B5 span 切在代理对中间 → span-splits-surrogate（不被算作可定位）', () => {
  const r = resolveEvidence({
    events,
    evidence: [{ eventId: 'S1-m002', quote: '🙏', span: { start: 3, end: 4 } }], // UTF-16 半个 emoji
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].reason, 'span-splits-surrogate');
});

test('T-B6 非唯一定位（同一 quote 出现两次）→ quote-ambiguous', () => {
  const r = resolveEvidence({
    events: new Map([
      ['E1', { eventId: 'E1', role: 'user', ts: '', text: '8080 不行，8080 也不行' }],
    ]),
    evidence: [{ eventId: 'E1', quote: '8080' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].reason, 'quote-ambiguous');
});

test('T-B7 快照 hash 与事件文本不一致 → stale（禁 fuzzy re-anchor）', () => {
  const store = createSnapshotStore();
  store.put({ sourceId: 'src-1', sourceEpoch: 1, eventId: 'S1-m001', text: '端口是 9090。' });
  const r = resolveEvidence({
    events,
    evidence: [{ eventId: 'S1-m001', quote: '端口是 8080' }],
    snapshots: store,
    sourceId: 'src-1',
    sourceEpoch: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].reason, 'stale-snapshot');
});

test('T-B8 快照存在且一致 → 通过；快照缺失 → snapshot-missing（不得静默放行）', () => {
  const store = createSnapshotStore();
  store.put({ sourceId: 'src-1', sourceEpoch: 1, eventId: 'S1-m001', text: events.get('S1-m001').text });
  const ok = resolveEvidence({
    events,
    evidence: [{ eventId: 'S1-m001', quote: '端口是 8080' }],
    snapshots: store,
    sourceId: 'src-1',
    sourceEpoch: 1,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.failures));

  const empty = createSnapshotStore();
  const missing = resolveEvidence({
    events,
    evidence: [{ eventId: 'S1-m001', quote: '端口是 8080' }],
    snapshots: empty,
    sourceId: 'src-1',
    sourceEpoch: 1,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failures[0].reason, 'snapshot-missing');
});

test('T-B9 多事件证据：任一条不可定位即整体失败，且失败项指出 eventId', () => {
  const r = resolveEvidence({
    events,
    evidence: [
      { eventId: 'S1-m001', quote: '端口是 8080' },
      { eventId: 'S1-m001', quote: '不存在的引用' },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].eventId, 'S1-m001');
  assert.equal(r.failures[0].reason, 'quote-not-found');
});

test('T-B10 跨事件边界：span.end 超出文本长度 → span-out-of-range', () => {
  const r = resolveEvidence({
    events,
    evidence: [{ eventId: 'S1-m001', quote: '端口是 8080', span: { start: 0, end: 999 } }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].reason, 'span-out-of-range');
});
