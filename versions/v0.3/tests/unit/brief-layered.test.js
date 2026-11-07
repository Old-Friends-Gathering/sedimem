// tests/unit/brief-layered.test.js — 分层 brief 与扁平路径的字符上限（v0.3 / 对抗审核③）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrief } from '../../src/render/brief.js';

function rec(i, text) {
  return {
    id: `01M6T8M0J8MCSRHGB0DCGVVBJ${String(i).padStart(2, '0')}`,
    kind: 'fact', subject: 'text', predicate: 'text', value: text, text,
    status: 'active', validTo: null, validFrom: '2026-11-01T00:00:00.000Z',
    createdAt: `2026-11-01T00:00:0${i % 10}.000Z`, hits: 0, tags: [],
    source: { agent: 'test' }, contentHash: 'sha256:x', confidence: 0.8, v: 1, privacy: 'private',
  };
}

test('扁平 brief 也受 totalChars 约束（曾经只写在分层路径里）', () => {
  const records = Array.from({ length: 4 }, (_, i) => rec(i, '甲'.repeat(3900)));
  const out = renderBrief({ scope: 'repo:x', records, lines: 80 });
  assert.ok(out.length <= 8000, `输出 ${out.length} 字符，超了 totalChars=8000`);
  assert.match(out, /字符上限省略/);
});

test('blocks 存在时走上层配额；blocks 为空时与扁平字节一致', () => {
  const records = [rec(1, '一条事实'), rec(2, '两条事实')];
  const flat = renderBrief({ scope: 'repo:x', records, lines: 80 });
  const sameAsFlat = renderBrief({ scope: 'repo:x', records, lines: 80, blocks: null });
  assert.equal(sameAsFlat, flat);
  const layered = renderBrief({
    scope: 'repo:x', records, lines: 80,
    blocks: [{ key: 'slot:fact/x', recordIds: [records[0].id], stats: { count: 1, firstAt: records[0].createdAt, lastAt: records[0].createdAt } }],
  });
  assert.match(layered, /slot:fact\/x/);
  // 控制字符不得出现在给 Agent 看的输出里（key 分隔符 \u0001 要显示成 '/'）
  const withSep = renderBrief({
    scope: 'repo:x', records, lines: 80,
    blocks: [{ key: 'slot:fact\u0001x', recordIds: [records[0].id], stats: { count: 1, firstAt: records[0].createdAt, lastAt: records[0].createdAt } }],
  });
  assert.ok(!/\u0001/.test(withSep), '输出里不应出现 \u0001');
  assert.match(withSep, /slot:fact\/x/);
});
