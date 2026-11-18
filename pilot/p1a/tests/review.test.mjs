// B2 复核骨架 TDD：只读 list/show，accept/reject 为 P1b 桩。
import test from 'node:test';
import assert from 'node:assert/strict';

import { listCandidates, showCandidate } from '../tools/review.mjs';

const CANDS = [
  { candidateId: 'AAAAAAAAAAAAAAAAAAAAAAAA', status: 'pending', type: 'fact', scope: 'repo:a', claim: 'alpha claim here' },
  { candidateId: 'BBBBBBBBBBBBBBBBBBBBBBBB', status: 'pending', type: 'fact', scope: 'repo:b', claim: 'beta claim here' },
  { candidateId: 'CCCCCCCCCCCCCCCCCCCCCCCC', status: 'accepted', type: 'fact', scope: 'repo:a', claim: 'gamma claim here' },
];

test('list: 默认全部，可按 status/scope 过滤', () => {
  assert.equal(listCandidates(CANDS, {}).length, 3);
  assert.equal(listCandidates(CANDS, { status: 'pending' }).length, 2);
  assert.equal(listCandidates(CANDS, { scope: 'repo:a' }).length, 2);
});

test('show: 命中返回完整记录；未命中抛 E_NOT_FOUND', () => {
  const c = showCandidate(CANDS, 'BBBBBBBBBBBBBBBBBBBBBBBB');
  assert.equal(c.claim, 'beta claim here');
  assert.throws(() => showCandidate(CANDS, 'ZZZZ'), (e) => e.code === 'E_NOT_FOUND');
});

test('accept/reject 是 P1b 桩（导出存在且调用抛 E_NOT_IMPLEMENTED_P1B）', async () => {
  const mod = await import('../tools/review.mjs');
  assert.equal(typeof mod.decideCandidate, 'function');
  assert.throws(() => mod.decideCandidate(CANDS, 'AAAAAAAAAAAAAAAAAAAAAAAA', 'accept', {}), (e) => e.code === 'E_NOT_IMPLEMENTED_P1B');
});
