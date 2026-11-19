// 聊天纠正 7 类 matcher（B7.5）
// 规格：docs/design/v2.0/09-extraction-pipeline.md §7（七类 + 判定顺序 + degraded 口径）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCorrection, CORRECTION_KINDS } from '../tools/corrections.mjs';

const truth = [
  { recordId: 'tr-1', scope: 'repo:demo', claim: '端口是 8080', assertion: { subject: 'deploy-service', predicate: 'port', value: '8080' } },
  { recordId: 'tr-2', scope: 'repo:demo', claim: '部署已完成', type: 'task-state', status: 'active', assertion: { subject: 'deploy', predicate: 'state', value: 'done' } },
];

test('C-1 更正式且新值可解析 → correction', () => {
  const r = matchCorrection({ text: '刚才说错了，端口应为 8081', truth, scope: 'repo:demo' });
  assert.equal(r.kind, 'correction');
  assert.equal(r.targetRecordId, 'tr-1');
  assert.equal(r.newValue, '8081');
});

test('C-2 「先别改，仍用 8080」→ retraction（无新值）', () => {
  const r = matchCorrection({ text: '先别改，仍用 8080', truth, scope: 'repo:demo' });
  assert.equal(r.kind, 'retraction');
});

test('C-3 引用标记 → quote（不覆盖既有事实）', () => {
  const r = matchCorrection({ text: '文档里说「端口是 9090」', truth, scope: 'repo:demo' });
  assert.equal(r.kind, 'quote');
});

test('C-4 助手自称完成 → assistant-claim（不得升级为已完成）', () => {
  const r = matchCorrection({ text: '我已经把部署完成了', truth, scope: 'repo:demo', role: 'assistant' });
  assert.equal(r.kind, 'assistant-claim');
});

test('C-5 工具失败/退出码非 0 → tool-failure（只更新该次执行状态）', () => {
  const r = matchCorrection({ text: '命令执行失败，exit code 1', truth, scope: 'repo:demo', role: 'tool' });
  assert.equal(r.kind, 'tool-failure');
});

test('C-6 跨 scope 同名主体 → cross-scope（允许并存，不跨边界覆盖）', () => {
  const r = matchCorrection({ text: '另一个项目的端口改成了 9090', truth, scope: 'repo:other' });
  assert.equal(r.kind, 'cross-scope');
});

test('C-7 两个合法来源冲突且不可判定 → disputed', () => {
  const r = matchCorrection({ text: 'A 说是 8080，B 说是 9090，不知道哪个对', truth, scope: 'repo:demo' });
  assert.equal(r.kind, 'disputed');
});

test('C-8 不是纠正 → null；kind 必须落在七类闭集内', () => {
  const r = matchCorrection({ text: '今天天气不错', truth, scope: 'repo:demo' });
  assert.equal(r.kind, null);
  assert.deepEqual(CORRECTION_KINDS, ['correction', 'retraction', 'quote', 'assistant-claim', 'cross-scope', 'tool-failure', 'disputed']);
});

test('C-9 缺 predicate 时退化为 about+文本匹配并标 degraded', () => {
  const degradedTruth = [{ recordId: 'tr-9', scope: 'repo:demo', claim: '端口是 8080', assertion: { subject: 'deploy-service', value: '8080' } }];
  const r = matchCorrection({ text: '端口应为 8081', truth: degradedTruth, scope: 'repo:demo' });
  assert.equal(r.kind, 'correction');
  assert.equal(r.matcher, 'degraded');
  assert.equal(r.targetRecordId, 'tr-9');
});
