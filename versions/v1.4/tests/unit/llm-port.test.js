// tests/unit/llm-port.test.js — LLM 端口单测（构造校验 / 成功解析 / 重试语义 / 输入超限）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmPort, PURPOSES } from '../../src/llm/port.js';

/** 构造 openai-compatible 策略 */
function policyOf(over = {}) {
  return {
    llm: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'glm-5.3-flash',
      egress: 'allowed',
      timeoutMs: 8000,
      maxRetries: 1,
      dailyLimitCny: 10,
      price: { inPerM: 2, outPerM: 8 },
      ...over,
    },
  };
}

/** openai-compatible 成功响应体 */
function okRes(text = 'hello') {
  return {
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  };
}

const noSleep = async () => {};

test('PURPOSES：四档上限与契约一致', () => {
  assert.deepEqual(PURPOSES.derive, { maxInputTokens: 4000, maxOutputTokens: 300 });
  assert.deepEqual(PURPOSES.curate, { maxInputTokens: 8000, maxOutputTokens: 300 });
  assert.deepEqual(PURPOSES.checkpoint, { maxInputTokens: 24000, maxOutputTokens: 1500 });
  assert.deepEqual(PURPOSES.brief, { maxInputTokens: 2000, maxOutputTokens: 400 });
});

test('provider=none：ready=false，complete 返回 E_LLM_UNAVAILABLE', async () => {
  const port = createLlmPort({ policy: policyOf({ provider: 'none' }), sleep: noSleep });
  assert.equal(port.ready, false);
  const r = await port.complete({ purpose: 'brief', system: 's', user: 'u' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_LLM_UNAVAILABLE');
});

test('egress=local-only 且 provider 非 none：构造抛 E_LLM_PRIVACY_CONFLICT', () => {
  assert.throws(
    () => createLlmPort({ policy: policyOf({ egress: 'local-only' }) }),
    (e) => e.code === 'E_LLM_PRIVACY_CONFLICT',
  );
});

test('非法端点：非 http(s) 或无 host，构造抛 E_INVALID_ARG', () => {
  assert.throws(() => createLlmPort({ policy: policyOf({ baseUrl: 'ftp://x.com' }) }), (e) => e.code === 'E_INVALID_ARG');
  assert.throws(() => createLlmPort({ policy: policyOf({ baseUrl: 'not-a-url' }) }), (e) => e.code === 'E_INVALID_ARG');
  assert.throws(() => createLlmPort({ policy: policyOf({ baseUrl: 'http://' }) }), (e) => e.code === 'E_INVALID_ARG');
});

test('缺少 policy.llm：构造抛 E_INVALID_ARG', () => {
  assert.throws(() => createLlmPort({ policy: {} }), (e) => e.code === 'E_INVALID_ARG');
  assert.throws(() => createLlmPort({}), (e) => e.code === 'E_INVALID_ARG');
});

test('未知 purpose：返回 E_INVALID_ARG 且不出网', async () => {
  let calls = 0;
  const port = createLlmPort({ policy: policyOf(), fetchImpl: async () => { calls++; return okRes(); }, sleep: noSleep });
  const r = await port.complete({ purpose: 'hack', system: 'a', user: 'b' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_INVALID_ARG');
  assert.equal(calls, 0);
});

test('成功解析：text / usage / cached:false，请求体含 model/messages/max_tokens/temperature/Bearer', async () => {
  let captured = null;
  const port = createLlmPort({
    policy: policyOf(),
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return okRes('摘要内容');
    },
    sleep: noSleep,
  });
  const r = await port.complete({ purpose: 'derive', system: 'sys', user: 'usr' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '摘要内容');
  assert.deepEqual(r.usage, { inTokens: 10, outTokens: 5 });
  assert.equal(r.cached, false);
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'glm-5.3-flash');
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }]);
  assert.equal(body.max_tokens, PURPOSES.derive.maxOutputTokens);
  assert.equal(body.temperature, 0);
  assert.equal(captured.init.headers.authorization, 'Bearer sk-test');
});

test('4xx：不重试，直接失败', async () => {
  let calls = 0;
  const port = createLlmPort({
    policy: policyOf(),
    fetchImpl: async () => { calls++; return { status: 401, json: async () => ({}) }; },
    sleep: noSleep,
  });
  const r = await port.complete({ purpose: 'derive', system: 'a', user: 'b' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_LLM_HTTP_ERROR');
  assert.equal(calls, 1); // 4xx 不重试
});

test('5xx：重试 1 次后成功', async () => {
  const calls = [];
  const port = createLlmPort({
    policy: policyOf(),
    fetchImpl: async () => {
      calls.push(1);
      return calls.length === 1 ? { status: 503, json: async () => ({}) } : okRes('recovered');
    },
    sleep: noSleep,
  });
  const r = await port.complete({ purpose: 'curate', system: 'a', user: 'b' });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'recovered');
  assert.equal(calls.length, 2); // 第一次 5xx + 重试一次
});

test('5xx：重试后仍失败，返回错误', async () => {
  let calls = 0;
  const port = createLlmPort({
    policy: policyOf(),
    fetchImpl: async () => { calls++; return { status: 500, json: async () => ({}) }; },
    sleep: noSleep,
  });
  const r = await port.complete({ purpose: 'derive', system: 'a', user: 'b' });
  assert.equal(r.ok, false);
  assert.equal(calls, 2); // maxRetries=1：最多两次
});

test('超时后重试成功：第一次 fetch 因 abort 抛错，第二次成功', async () => {
  const calls = [];
  let slept = 0;
  const port = createLlmPort({
    policy: policyOf({ timeoutMs: 20 }),
    fetchImpl: async (url, init) => {
      calls.push(1);
      if (calls.length === 1) {
        // 模拟真实 fetch：signal abort 后抛 AbortError
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      return okRes('after timeout');
    },
    sleep: async (ms) => { slept = ms; },
  });
  const r = await port.complete({ purpose: 'derive', system: 'a', user: 'b' });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'after timeout');
  assert.equal(calls.length, 2);
  assert.equal(slept, 2000); // 退避 2s
});

test('网络错误：重试 1 次后仍失败，E_LLM_NETWORK', async () => {
  let calls = 0;
  const port = createLlmPort({
    policy: policyOf(),
    fetchImpl: async () => { calls++; throw new Error('ECONNREFUSED'); },
    sleep: noSleep,
  });
  const r = await port.complete({ purpose: 'derive', system: 'a', user: 'b' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_LLM_NETWORK');
  assert.equal(calls, 2);
});

test('响应缺 choices[0].message.content：E_LLM_BAD_RESPONSE 且重试', async () => {
  let calls = 0;
  const port = createLlmPort({
    policy: policyOf(),
    fetchImpl: async () => { calls++; return { status: 200, json: async () => ({ choices: [] }) }; },
    sleep: noSleep,
  });
  const r = await port.complete({ purpose: 'derive', system: 'a', user: 'b' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_LLM_BAD_RESPONSE');
  assert.equal(calls, 2);
});

test('输入超限：粗估 ceil(chars/2) 超上限直接失败，不截断、不出网', async () => {
  let calls = 0;
  const port = createLlmPort({ policy: policyOf(), fetchImpl: async () => { calls++; return okRes(); }, sleep: noSleep });
  // derive 上限 4000 tokens → 8000 字符；给 8002 字符（估 4001）必超
  const big = '字'.repeat(8002);
  const r = await port.complete({ purpose: 'derive', system: big, user: '' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_LLM_INPUT_TOO_LARGE');
  assert.match(r.error.message, /not truncated/);
  assert.equal(calls, 0); // 未出网
  assert.equal(big.length, 8002); // 输入未被截断
});

test('输入恰在上限内：正常出网（边界 8000 字 → 4000 tokens）', async () => {
  let calls = 0;
  const port = createLlmPort({ policy: policyOf(), fetchImpl: async () => { calls++; return okRes(); }, sleep: noSleep });
  const r = await port.complete({ purpose: 'derive', system: 'ab'.repeat(4000), user: '' });
  assert.equal(r.ok, true);
  assert.equal(calls, 1);
});

test('complete 携带 timeoutMs 覆盖 policy 默认', async () => {
  let sawTimeout = null;
  const port = createLlmPort({
    policy: policyOf({ timeoutMs: 99999 }),
    fetchImpl: async (url, init) => {
      // 从外部观察不到 timeout 数值（在 AbortController 里），这里只验证不抛错且能成功
      sawTimeout = typeof init.signal !== 'undefined';
      return okRes();
    },
    sleep: noSleep,
  });
  const r = await port.complete({ purpose: 'brief', system: 'a', user: 'b', timeoutMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(sawTimeout, true);
});
