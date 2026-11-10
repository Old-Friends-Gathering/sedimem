// index/embedder.js — EmbedderPort（契约：docs/plans/v0.4-competitive-gaps.md D1）
// 语义道是可插拔 Port 而非硬依赖：kind='none'（默认）返回 ready:false 的空实现；
// kind='http' 走 OpenAI 兼容 POST {model, input:[...]} → {data:[{embedding:[...]}]}。
// 失败语义（D1）：超时/网络错误/非 2xx 一律 E_EMBED_UNAVAILABLE，**不重试、不阻塞**——
// 调用方（hybrid 检索）负责降级为纯词法并打 degraded 标记，绝不静默假装有语义。
// 维度一致性：首次调用记住 dim，后续批次维度漂移 → E_EMBED_DIM_MISMATCH（拒绝混合维度写入）。

/**
 * @param {string} msg
 * @param {string} code
 */
function embedErr(msg, code) {
  const err = new Error(msg);
  err.code = code;
  return err;
}

/**
 * 创建 EmbedderPort。策略全部来自 opts（不读 policy.json）。
 * @param {{policy?: object, memoHome?: string}} [args]
 *   policy.search.embedder = {kind:'none'|'http', url, model, timeoutMs, minScore}
 * @returns {{name: string, dim: number|null, ready: boolean,
 *            embed(texts: string[]): Promise<number[][]>, close(): Promise<void>}}
 */
export function createEmbedder({ policy, memoHome } = {}) {
  // memoHome 保留在签名里（未来本地模型缓存可放 $MEMO_HOME），当前实现不使用
  void memoHome;
  const cfg = policy?.search?.embedder ?? {};
  const kind = cfg.kind ?? 'none';
  if (kind === 'none') return nullEmbedder();
  if (kind !== 'http') {
    throw embedErr(
      `createEmbedder: unknown search.embedder.kind ${JSON.stringify(kind)} (expected 'none' | 'http')`,
      'E_INVALID_ARG',
    );
  }
  return httpEmbedder(cfg);
}

/** kind='none'：ready:false，embed 一律 E_EMBED_UNAVAILABLE（语义道关闭，调用方走纯词法） */
function nullEmbedder() {
  return {
    name: 'none',
    dim: 0,
    ready: false,
    async embed() {
      throw embedErr('embedder unavailable: search.embedder.kind is "none"', 'E_EMBED_UNAVAILABLE');
    },
    async close() {},
  };
}

/**
 * kind='http'：OpenAI 兼容接口。fetch + AbortController 实现超时；
 * 返回顺序必须与输入一致（按 data[].index 归位，缺 index 按数组顺序）。
 * @param {{url?: string, model?: string, timeoutMs?: number, minScore?: number}} cfg
 */
function httpEmbedder(cfg) {
  const url = cfg.url ?? '';
  const model = cfg.model ?? '';
  const timeoutMs = Number(cfg.timeoutMs ?? 3000);
  if (!url || !model) {
    throw embedErr(
      'createEmbedder: search.embedder.kind="http" requires url and model',
      'E_INVALID_ARG',
    );
  }
  /** @type {number|null} 首次成功调用后锁定，防止混维度写入向量库 */
  let dim = null;

  return {
    name: `http:${model}`,
    get dim() { return dim; },
    ready: true,

    async embed(texts) {
      const list = Array.isArray(texts) ? texts : [texts];
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: list }),
          signal: ac.signal,
        });
      } catch (cause) {
        // 不重试（D1）：网络错误/超时统一 E_EMBED_UNAVAILABLE
        throw unavailable(`embedder request failed: ${cause?.message ?? cause}`, cause);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw unavailable(`embedder HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
      }
      let payload;
      try {
        payload = await res.json();
      } catch (cause) {
        throw unavailable(`embedder response is not JSON: ${cause?.message ?? cause}`, cause);
      }
      const rows = payload?.data;
      if (!Array.isArray(rows) || rows.length !== list.length) {
        throw unavailable(
          `embedder response shape mismatch: expected data[${list.length}], got ${
            Array.isArray(rows) ? rows.length : typeof rows
          }`,
        );
      }
      // 按 index 归位（OpenAI 兼容语义）；无 index 字段则信任服务端保序
      const out = new Array(list.length);
      rows.forEach((row, i) => {
        const v = row?.embedding;
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'number')) {
          throw unavailable(`embedder embedding[${row?.index ?? i}] is not a number[]`);
        }
        if (dim === null) dim = v.length;
        else if (v.length !== dim) {
          throw embedErr(
            `embedder dim mismatch: expected ${dim}, got ${v.length} at item ${row?.index ?? i}`,
            'E_EMBED_DIM_MISMATCH',
          );
        }
        out[typeof row.index === 'number' ? row.index : i] = v;
      });
      for (let i = 0; i < out.length; i++) {
        if (out[i] === undefined) throw unavailable(`embedder response missing item ${i}`);
      }
      return out;
    },

    async close() {},
  };
}

function unavailable(msg, cause) {
  const err = embedErr(msg, 'E_EMBED_UNAVAILABLE');
  if (cause) err.cause = cause;
  return err;
}
