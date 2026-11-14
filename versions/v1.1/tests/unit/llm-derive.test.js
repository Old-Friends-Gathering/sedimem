// tests/unit/llm-derive.test.js — LLM 派生逻辑（正常/真相字段/截断/kindHint/未就绪/预算/不抛异常）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DERIVE_PROMPT_VERSION, buildDerivePrompt, applyDerivation, deriveFingerprint,
} from '../../src/llm/derive.js';

const clock = { now: () => '2026-11-13T10:00:00.000Z', nowMs: () => 0 };

function baseRecord(extra = {}) {
  return {
    id: 'rec1', validFrom: '2026-01-01T00:00:00.000Z', kind: 'fact',
    title: '', subject: '部署', predicate: '使用', value: 'pm2',
    text: '部署流水线使用 pm2 管理进程，重启策略是 on-failure。',
    tags: [], privacy: 'shared', source: { agent: 'test' },
    ...extra,
  };
}

function okPort(text, extra = {}) {
  return {
    ready: () => true, model: 'test-model',
    complete: async () => ({ ok: true, text }),
    ...extra,
  };
}

describe('llm/derive', () => {
  test('DERIVE_PROMPT_VERSION 固定为 d1-v1', () => {
    assert.equal(DERIVE_PROMPT_VERSION, 'd1-v1');
  });

  test('buildDerivePrompt 返回 {system, user}，user 内含记录上下文', () => {
    const { system, user } = buildDerivePrompt({ record: baseRecord() });
    assert.ok(system.includes('title'));
    assert.ok(system.includes('禁止输出'));
    const userObj = JSON.parse(user);
    assert.equal(userObj.kind, 'fact');
    assert.equal(userObj.text.includes('pm2'), true);
  });

  test('正常派生：ok 状态、字段齐全、无截断标记', async () => {
    const port = okPort('{"title":"部署用 pm2","summary":"流水线用 pm2 管进程","tags":["deploy","pm2"],"kindHint":"fact"}');
    const d = await applyDerivation({ port, record: baseRecord(), clock });
    assert.equal(d.deriveStatus, 'ok');
    assert.equal(d.promptVersion, 'd1-v1');
    assert.equal(d.model, 'test-model');
    assert.equal(d.title, '部署用 pm2');
    assert.equal(d.ts, '2026-11-13T10:00:00.000Z');
    assert.ok(!('kind' in d), '派生记录不得带真相字段 kind');
    assert.ok(!('titleTruncated' in d) && !('summaryTruncated' in d));
  });

  test('含真相字段（kind/text/value/status/validTo）判 failed，且结果不带任何真相字段', async () => {
    for (const leak of ['kind', 'text', 'value', 'status', 'validTo']) {
      const port = okPort(`{"title":"x","summary":"y","${leak}":"hijack"}`);
      const d = await applyDerivation({ port, record: baseRecord(), clock });
      assert.equal(d.deriveStatus, 'failed', `字段 ${leak} 泄漏应判 failed`);
      assert.ok(!('kind' in d) && !('text' in d) && !('value' in d) && !('status' in d) && !('validTo' in d));
      // 兜底内容来自 record 安全子集，不含被劫持值
      assert.ok(!String(d.title).includes('hijack'));
    }
  });

  test('kindHint 与记录 kind 不同：只记 kindMismatch:true，不改 kind', async () => {
    const port = okPort('{"title":"t","summary":"s","tags":[],"kindHint":"decision"}');
    const d = await applyDerivation({ port, record: baseRecord(), clock });
    assert.equal(d.deriveStatus, 'ok');
    assert.equal(d.kindHint, 'decision');
    assert.equal(d.kindMismatch, true);
    // 原记录 kind 不受影响（applyDerivation 不返回也不修改原记录的 kind 语义）
    assert.ok(!('kind' in d));
  });

  test('超长截断：title >40 标 titleTruncated，summary >80 标 summaryTruncated，tags 最多 5 个', async () => {
    const longTitle = '长'.repeat(50);
    const longSummary = '摘'.repeat(100);
    const port = okPort(JSON.stringify({
      title: longTitle, summary: longSummary, tags: ['1', '2', '3', '4', '5', '6', '7'],
    }));
    const d = await applyDerivation({ port, record: baseRecord(), clock });
    assert.equal(d.title.length, 40);
    assert.equal(d.titleTruncated, true);
    assert.equal(d.summary.length, 80);
    assert.equal(d.summaryTruncated, true);
    assert.equal(d.tags.length, 5);
  });

  test('端口未就绪记 no-provider', async () => {
    const port = { ready: () => false, model: 'm', complete: async () => { throw new Error('should not call'); } };
    const d = await applyDerivation({ port, record: baseRecord(), clock });
    assert.equal(d.deriveStatus, 'no-provider');
    const d2 = await applyDerivation({ port: null, record: baseRecord(), clock });
    assert.equal(d2.deriveStatus, 'no-provider');
  });

  test('预算 blocked 记 budget-exceeded（budgetBlocked 与 E_LLM_BUDGET_EXCEEDED 两种形状）', async () => {
    const legacy = {
      ready: true, model: 'm',
      complete: async () => ({ ok: false, blocked: true, error: { code: 'E_LLM_BUDGET_EXCEEDED', message: 'quota' } }),
    };
    assert.equal((await applyDerivation({ port: legacy, record: baseRecord(), clock })).deriveStatus, 'budget-exceeded');
    const port = {
      ready: true, model: 'm',
      complete: async () => ({ ok: false, budgetBlocked: true }),
    };
    assert.equal((await applyDerivation({ port, record: baseRecord(), clock })).deriveStatus, 'budget-exceeded');
    // 普通 LLM 失败（非预算）仍是 failed
    const errPort = {
      ready: true, model: 'm',
      complete: async () => ({ ok: false, error: { code: 'E_LLM_UNAVAILABLE', message: 'down' } }),
    };
    assert.equal((await applyDerivation({ port: errPort, record: baseRecord(), clock })).deriveStatus, 'failed');
  });

  test('port 契约形态：ready 为布尔属性（createLlmPort 实际形状）', async () => {
    const port = { ready: true, model: 'm', complete: async () => ({ ok: true, text: '{"title":"t","summary":"s","tags":[]}' }) };
    const d = await applyDerivation({ port, record: baseRecord(), clock });
    assert.equal(d.deriveStatus, 'ok');
    const off = { ready: false, model: 'm', complete: async () => ({ ok: true, text: '{}' }) };
    assert.equal((await applyDerivation({ port: off, record: baseRecord(), clock })).deriveStatus, 'no-provider');
  });

  test('永不抛异常：port 抛错 / 输出非 JSON / record 非法都返回 failed 记录', async () => {
    const throwing = { ready: () => true, model: 'm', complete: async () => { throw new Error('boom'); } };
    assert.equal((await applyDerivation({ port: throwing, record: baseRecord(), clock })).deriveStatus, 'failed');
    const garbage = okPort('完全不是 JSON 的回答');
    assert.equal((await applyDerivation({ port: garbage, record: baseRecord(), clock })).deriveStatus, 'failed');
    assert.equal((await applyDerivation({ port: null, record: null, clock })).deriveStatus, 'failed');
    // clock 缺省也不抛
    const d = await applyDerivation({ port: okPort('{}'), record: baseRecord() });
    assert.ok(typeof d.ts === 'string');
  });

  test('失败兜底：无 title 时用 subject+predicate，无 text 时截前 60 字', async () => {
    const port = { ready: () => false, model: 'm', complete: async () => ({ ok: false }) };
    const d = await applyDerivation({ port, record: baseRecord(), clock });
    assert.equal(d.title, '部署 使用');
    assert.ok(d.summary.length <= 60);
    assert.ok(d.summary.includes('pm2'));

    const noTitle = baseRecord({ subject: '', predicate: '', text: '短'.repeat(30) });
    const d2 = await applyDerivation({ port, record: noTitle, clock });
    assert.equal(d2.title, '短短短'.slice(0, 24) === '' ? d2.title : noTitle.text.slice(0, 24));
    assert.ok(d2.title.length <= 24);
  });

  test('代码围栏包裹的 JSON 也能解析', async () => {
    const port = okPort('```json\n{"title":"围栏标题","summary":"围栏摘要","tags":[]}\n```');
    const d = await applyDerivation({ port, record: baseRecord(), clock });
    assert.equal(d.deriveStatus, 'ok');
    assert.equal(d.title, '围栏标题');
  });

  test('privacy-blocked：private 且端口未放行时不调用 LLM', async () => {
    let called = false;
    const port = {
      ready: () => true, model: 'm', allowPrivate: false,
      complete: async () => { called = true; return { ok: true, text: '{}' }; },
    };
    const d = await applyDerivation({ port, record: baseRecord({ privacy: 'private' }), clock });
    assert.equal(d.deriveStatus, 'privacy-blocked');
    assert.equal(called, false);
  });

  test('deriveFingerprint 稳定且区分输入', () => {
    const a = deriveFingerprint({ promptVersion: 'd1-v1', id: 'x', validFrom: 'v1' });
    assert.equal(a, deriveFingerprint({ promptVersion: 'd1-v1', id: 'x', validFrom: 'v1' }));
    assert.notEqual(a, deriveFingerprint({ promptVersion: 'd1-v1', id: 'y', validFrom: 'v1' }));
  });
});
