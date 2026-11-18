// split-corpus 测试 —— dev/test 家族分层切分 + 近重复不跨集
// 规格：docs/plans/v2.0-p1.md §7 B3、04-scoring-and-splits.md §2（近重复不跨集合）、
//       eval-manifest.json thresholds.nearDuplicateDice=0.85

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diceBigram,
  assignSplit,
  nearDupAcrossSets,
  validateSplit,
} from '../tools/split-corpus.mjs';
import { loadCorpus } from '../tools/corpus-validate.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(HERE, '../corpus');
const MANIFEST = path.join(HERE, '../config/eval-manifest.json');

const fam = (n) => ({ scenarioId: n, family: 'fam-x', language: 'zh', events: [{ eventId: `${n}-m001`, role: 'user', ts: '2026-11-01T00:00:00Z', text: `事件 ${n}` }], gold: [] });

test('diceBigram：完全相同=1，完全不同=0，中英都可用', () => {
  assert.equal(diceBigram('结算服务超时三十秒', '结算服务超时三十秒'), 1);
  assert.equal(diceBigram('部署服务超时三十秒', '结算服务超时三十秒') > 0, true);
  assert.equal(diceBigram('abc def', 'xyz uvw'), 0);
  assert.equal(diceBigram('', ''), 0);
  // 多重集分母回归：值必须落在 [0,1]（B3 语料实测曾算出 >1）
  for (const [a, b] of [
    ['Rollback failed deployment API returned 403 Forbidden runbook bot token expired', 'Rollback failed deployment API returned 403 Forbidden runbook bot token expired'],
    ['the quota raise failed still sixty cpm', 'quota raise to 120 cpm failed still 60 cpm'],
    ['aaaa bbbb cccc dddd', 'aaaa bbbb'],
  ]) {
    const d = diceBigram(a, b);
    assert.ok(d >= 0 && d <= 1, `dice 越界 ${d}`);
  }
  assert.equal(diceBigram('aaaa bbbb', 'aaaa bbbb'), 1);
});

test('assignSplit：确定性（同种子同结果）、家族分层、dev/test 都有每个家族', () => {
  const scenarios = [];
  for (let i = 1; i <= 30; i++) scenarios.push(fam(`S${String(i).padStart(3, '0')}`));
  const a = assignSplit(scenarios, { seed: 42 });
  const b = assignSplit(scenarios, { seed: 42 });
  assert.deepEqual(a, b, '同种子必须同结果');
  const dev = a.filter((s) => s.split === 'dev').length;
  const testN = a.filter((s) => s.split === 'test').length;
  assert.equal(dev + testN, 30);
  assert.ok(dev >= 10 && testN >= 10, `家族 30 个场景应两边都成规模，实际 dev=${dev} test=${testN}`);
  const c = assignSplit(scenarios, { seed: 7 });
  const key = (arr) => arr.map((s) => `${s.scenarioId}:${s.split}`).join(',');
  assert.notEqual(key(a), key(c), '不同种子应可能产生不同分配（看 scenarioId→split 映射，不是序列模式）');
});

test('nearDupAcrossSets：近重复对被报告，阈值来自 manifest（0.85）', () => {
  const base = '我们把结算服务的超时时间从 10 秒调整到 30 秒，这周五随版本一起上线';
  const twin = '我们把结算服务的超时时间从 10 秒调整到 30 秒，这周四随版本一起上线';
  const other = '数据库连接池已扩容到 200，慢查询阈值同步下调到 200 毫秒';
  const pairs = nearDupAcrossSets(
    [
      { ...fam('S001'), split: 'dev', events: [{ eventId: 'S001-m001', role: 'user', ts: '', text: base }] },
      { ...fam('S002'), split: 'test', events: [{ eventId: 'S002-m001', role: 'user', ts: '', text: twin }] },
      { ...fam('S003'), split: 'test', events: [{ eventId: 'S003-m001', role: 'user', ts: '', text: other }] },
    ],
    { threshold: 0.85 },
  );
  assert.equal(pairs.length, 1, `只应报告 S001~S002 一对，实际 ${JSON.stringify(pairs)}`);
  assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ['S001', 'S002']);
});

test('validateSplit：真实语料——家族两端都有、无跨集近重复', async () => {
  const scenarios = await loadCorpus(CORPUS_DIR);
  assert.ok(Array.isArray(scenarios) && scenarios.length > 0, '语料目录非空');
  const assigned = assignSplit(scenarios, { seed: 20261118 });
  const problems = validateSplit(assigned, { dice: 0.85 });
  assert.equal(problems.length, 0, `不应有切分问题：${JSON.stringify(problems.slice(0, 5))}`);
});
