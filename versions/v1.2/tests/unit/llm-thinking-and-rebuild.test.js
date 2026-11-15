/**
 * llm-thinking-and-rebuild.test.js —— v1.0.2 两个真实故障的回归。
 *
 * 1) GLM-4.5+ 默认开「思考」，把 max_tokens 烧在 reasoning 上，content 变成空串 →
 *    derive 全部 unparseable-output。修法是请求体带 thinking:{type:'disabled'}，
 *    并保留 policy.llm.thinking='auto' 的显式开启。
 * 2) `memo derive --rebuild` 旧实现把「已有 derived」当输入，等于什么都没重建；
 *    正确语义 = 把 active 记录重新入队并排空。这里用假端口断言「重建会重新调模型」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLlmPort } from '../../src/llm/port.js';
import { createMemoryService } from '../../src/api/service.js';

const policyWith = (over) => ({ llm: { provider: 'openai-compatible', egress: 'egress-allowed', baseUrl: 'https://example.com/v4', apiKey: 'k', model: 'm', ...over } });

test('默认关思考：请求体带 thinking.disabled', async () => {
  let body = null;
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"title":"t","summary":"s"}' } }], usage: {} }) }; };
  const port = createLlmPort({ policy: policyWith({}), memoHome: '/tmp/x', fetchImpl });
  const res = await port.complete({ purpose: 'derive', system: 's', user: 'u' });
  assert.equal(res.ok, true);
  assert.deepEqual(body.thinking, { type: 'disabled' });
});

test('thinking=auto 时不发送 thinking 字段（真的想用推理链）', async () => {
  let body = null;
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) }; };
  const port = createLlmPort({ policy: policyWith({ thinking: 'auto' }), memoHome: '/tmp/x', fetchImpl });
  await port.complete({ purpose: 'derive', system: 's', user: 'u' });
  assert.equal(body.thinking, undefined);
});

test('rebuildDerived：重新调模型，写回 sidecar（不是「压缩旧结果」）', async () => {
  const memoHome = mkdtempSync(path.join(tmpdir(), 'memo-rebuild-'));
  let calls = 0;
  const fakePort = {
    name: 'fake', model: 'fake', ready: true, keySource: 'test',
    async complete() {
      calls += 1;
      return { ok: true, text: JSON.stringify({ title: `派生标题${calls}`, summary: '派生摘要' }), usage: { inTokens: 1, outTokens: 1 } };
    },
  };
  const svc = await createMemoryService({ memoHome, scope: 'repo:t', llmPort: fakePort });
  for (let i = 0; i < 3; i++) {
    await svc.write({
      text: `第 ${i} 条事实：验证重建会重新调用模型（主题 ${i}）`,
      kind: 'fact', subject: `topic-${i}`, predicate: 'rule', value: `v${i}`,
      title: `原始标题${i}`, source: { agent: 'test' },
    });
  }
  const before = calls;
  const res = await svc.rebuildDerived();
  assert.equal(res.active, 3);
  assert.equal(res.ok, 3);
  assert.ok(calls - before >= 3, `rebuild 必须重新调用模型（实际新增 ${calls - before} 次）`);
  const brief = await svc.brief({ lines: 10 });
  assert.match(String(brief), /派生标题/, 'brief 必须用派生标题');
  await svc.close();
});
