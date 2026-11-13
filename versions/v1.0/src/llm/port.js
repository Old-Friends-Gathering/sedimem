// llm/port.js — LLM 端口（契约：docs/plans/v1.0.0-refactor.md §2.1）
//
// 零依赖、openai-compatible 协议。所有副作用（fetch、时钟、退避 sleep）都可注入，测试不联网。
// 失败语义：complete 永不抛异常（构造期校验除外），失败一律返回 { ok:false, error:{code,message} }；
// 上层派生据此标 deriveStatus，写入永不因 LLM 失败而拒绝。

const DEFAULT_TIMEOUT_MS = 8000;
const RETRY_BACKOFF_MS = 2000;

/**
 * 四个用途与各自 token 上限（审核 C1 修复：按用途分档，全局上限不存在）。
 * maxInputTokens 用于调用前的粗估校验；maxOutputTokens 直接进请求体 max_tokens。
 */
export const PURPOSES = {
  derive: { maxInputTokens: 4000, maxOutputTokens: 300 },
  curate: { maxInputTokens: 8000, maxOutputTokens: 300 },
  checkpoint: { maxInputTokens: 24000, maxOutputTokens: 1500 },
  brief: { maxInputTokens: 2000, maxOutputTokens: 400 },
};

/**
 * 构造 LLM 端口。
 * @param {object} opts
 * @param {object} opts.policy  配置对象，llm 形状：
 *   { provider, baseUrl, apiKey, model, egress, timeoutMs, maxRetries, dailyLimitCny, price:{inPerM,outPerM} }
 * @param {string} [opts.memoHome]  $MEMO_HOME（端口本身不落盘，签名保留以便上层统一注入）
 * @param {() => number} [opts.clock]  时钟注入（返回 ms 时间戳），测试不依赖真实时间
 * @param {(url: string, init: object) => Promise<any>} [opts.fetchImpl]  fetch 注入，默认 globalThis.fetch
 * @param {(ms: number) => Promise<void>} [opts.sleep]  重试退避 sleep 注入，默认真实 setTimeout
 */
export function createLlmPort({ policy, memoHome, clock = () => Date.now(), fetchImpl, sleep } = {}) {
  const llm = policy && policy.llm;
  if (!llm || typeof llm !== 'object') {
    const err = new Error('createLlmPort: policy.llm required');
    err.code = 'E_INVALID_ARG';
    throw err;
  }

  const provider = llm.provider || 'none';
  const egress = llm.egress || 'local-only';
  const doFetch = fetchImpl || globalThis.fetch;
  const doSleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // 隐私互斥显式化：local-only 强制 provider:none；local-only 却配了真实 provider 即冲突
  if (egress === 'local-only' && provider !== 'none') {
    const err = new Error(`createLlmPort: egress=local-only conflicts with provider=${provider}`);
    err.code = 'E_LLM_PRIVACY_CONFLICT';
    throw err;
  }

  const isNone = provider === 'none';
  let baseUrl = null;

  // 端点校验：只接受 http(s) 且必须有 host（构造期 fail-fast，避免运行期才炸）
  if (!isNone) {
    baseUrl = llm.baseUrl;
    let parsed = null;
    try { parsed = new URL(baseUrl); } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
      const err = new Error(`createLlmPort: invalid baseUrl ${JSON.stringify(baseUrl)}`);
      err.code = 'E_INVALID_ARG';
      throw err;
    }
  }

  return {
    name: 'llm-port',
    model: llm.model || '',
    ready: !isNone,
    reason: isNone ? 'provider none' : 'ok',

    /**
     * 执行一次补全。永不抛异常（除 purpose 非法等参数错误返回失败对象）。
     * @param {{purpose: string, system: string, user: string, timeoutMs?: number}} args
     * @returns {Promise<{ok:true, text:string, usage:{inTokens:number,outTokens:number}, cached:false}
     *                  |{ok:false, error:{code:string, message:string}}>}
     */
    async complete({ purpose, system, user, timeoutMs }) {
      const limit = PURPOSES[purpose];
      if (!limit) {
        return fail('E_INVALID_ARG', `complete: unknown purpose ${JSON.stringify(purpose)}`);
      }
      if (isNone || !doFetch) {
        return fail('E_LLM_UNAVAILABLE', `llm provider is none, purpose=${purpose} unavailable`);
      }

      // 输入粗估：Math.ceil(chars/2)；超该 purpose 上限直接失败，不截断、不出网
      const inputChars = (system || '').length + (user || '').length;
      const estTokens = Math.ceil(inputChars / 2);
      if (estTokens > limit.maxInputTokens) {
        return fail('E_LLM_INPUT_TOO_LARGE',
          `estimated input tokens ${estTokens} > ${limit.maxInputTokens} for purpose=${purpose} (not truncated)`);
      }

      const url = `${baseUrl}/chat/completions`; // openai-compatible 端点拼接
      const body = JSON.stringify({
        model: llm.model || '',
        messages: [
          { role: 'system', content: system || '' },
          { role: 'user', content: user || '' },
        ],
        max_tokens: limit.maxOutputTokens,
        temperature: 0,
      });
      const headers = {
        'content-type': 'application/json',
        ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
      };

      const maxRetries = typeof llm.maxRetries === 'number' ? llm.maxRetries : 1;
      let lastError = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await doSleep(RETRY_BACKOFF_MS); // 退避后重试（超时/5xx/网络错误）
        const result = await attemptOnce({ url, body, headers, timeoutMs: timeoutMs || llm.timeoutMs || DEFAULT_TIMEOUT_MS, doFetch, clock });
        if (result.ok) return result;
        lastError = result.error;
        if (!result.retryable) break; // 4xx 等不可重试错误直接失败
      }
      return { ok: false, error: lastError };
    },
  };
}

/** 单次请求尝试：返回成功结果，或 { ok:false, retryable, error } */
async function attemptOnce({ url, body, headers, timeoutMs, doFetch, clock }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timedOut = false;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (res.status >= 400 && res.status < 500) {
      // 4xx：请求本身有问题（鉴权/参数），重试没有意义
      return { ok: false, retryable: false, error: fail('E_LLM_HTTP_ERROR', `HTTP ${res.status} (client error, no retry)`).error };
    }
    if (res.status >= 500) {
      return { ok: false, retryable: true, error: fail('E_LLM_HTTP_ERROR', `HTTP ${res.status} (server error, retryable)`).error };
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string') {
      return { ok: false, retryable: true, error: fail('E_LLM_BAD_RESPONSE', 'missing choices[0].message.content').error };
    }
    const usage = (data && data.usage) || {};
    return {
      ok: true,
      text,
      usage: {
        inTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        outTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      },
      cached: false,
    };
  } catch (e) {
    // fetch 抛错：网络错误，或超时导致 signal abort（clock 仅用于错误信息可读性）
    if (controller.signal.aborted) timedOut = true;
    return {
      ok: false,
      retryable: true,
      error: fail(timedOut || e.name === 'AbortError' ? 'E_LLM_TIMEOUT' : 'E_LLM_NETWORK',
        `${e.name === 'AbortError' || timedOut ? 'timeout' : 'network error'}: ${e.message} at ${clock()}`).error,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 构造标准失败对象 */
function fail(code, message) {
  return { ok: false, error: { code, message } };
}
