// P1a 冻结决策 3/6/7 的可执行契约守卫（纯函数，无 IO）
// 决策 #3：双时间轴守卫——业务断言时间（assertedValid*）与系统时间（valid*）互斥，
//           且 asOf 不得早于业务时间起点（防"去年开始"穿越到更早 asOf 泄漏）。
//           规格：docs/design/v2.0/01-candidate-schema.md §5
// 决策 #6：tokenizer 计数快照——托管 GLM API 无离线公开 tokenizer（adr-101），
//           P1a 采用确定性估算 + 生成模型声明；本估算口径非精确模型计数。
//           规格：docs/design/v2.0/adr-101-tokenizer.md
// 决策 #7：成本闸门——无配置拒绝出站、超上限显式停机。
//           规格：docs/design/v2.0/adr-102-cost-quota.md

/**
 * 决策 #3：双时间守卫。
 * 纯函数：不改输入、无 IO。
 * @param {object} candidate 候选记录（兼容顶层 / assertion.validFrom / time.assertedValidFrom 字段名）
 * @param {{asOf?: string|Date}} [opts] 查询时刻
 * @returns {{ok: boolean, issues: Array<{code: string, field?: string, detail?: string}>}}
 */
export function checkDoubleTime(candidate, { asOf } = {}) {
  const issues = [];
  const c = candidate ?? {};

  // 业务时间字段名兼容：顶层 assertedValidFrom > assertion.validFrom > time.assertedValidFrom
  const pick = (...paths) => {
    for (const p of paths) {
      const v = p.reduce((o, k) => (o == null ? undefined : o[k]), c);
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };
  const assertedFrom = pick(['assertedValidFrom'], ['assertion', 'validFrom'], ['time', 'assertedValidFrom']);
  const assertedTo = pick(['assertedValidTo'], ['assertion', 'validTo'], ['time', 'assertedValidTo']);
  const sysFrom = c.validFrom ?? null;
  const sysTo = c.validTo ?? null;

  // 互斥：业务时间被写进系统区间字段 → asserted-used-as-system
  if (assertedFrom !== null && sysFrom !== null && String(assertedFrom) === String(sysFrom)) {
    issues.push({ code: 'asserted-used-as-system', field: 'validFrom' });
  }
  if (assertedTo !== null && sysTo !== null && String(assertedTo) === String(sysTo)) {
    issues.push({ code: 'asserted-used-as-system', field: 'validTo' });
  }

  // asOf 穿越反例：asOf 早于业务时间起点 → 候选不应在该 asOf 可见
  if (assertedFrom !== null && asOf !== undefined && asOf !== null) {
    const a = asOf instanceof Date ? asOf : new Date(asOf);
    const f = assertedFrom instanceof Date ? assertedFrom : new Date(assertedFrom);
    if (!Number.isNaN(a.getTime()) && !Number.isNaN(f.getTime()) && f.getTime() > a.getTime()) {
      issues.push({
        code: 'time-travel-leak',
        detail: `assertedValidFrom(${assertedFrom}) > asOf(${typeof asOf === 'string' ? asOf : a.toISOString()})：候选在业务时间开始前不可见`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * 决策 #6：确定性 token 估算。
 * 口径（估算，非精确模型计数；adr-101：托管 GLM API 无离线公开 tokenizer）：
 *   - 中文（CJK 统一表意文字等）每字 1 token
 *   - 其余单词按每 4 字符 1 token 向上取整（以空白分词）
 *   - 空串 / 非字符串 → 0
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let tokens = 0;
  const cjkRe = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[\u3000-\u303F\uFF00-\uFFEF]/u;
  const words = text.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const chars = [...w];
    const zh = chars.filter((ch) => cjkRe.test(ch));
    const rest = chars.length - zh.length;
    tokens += zh.length + Math.ceil(rest / 4);
  }
  return tokens;
}

/** 决策 #6：生成模型声明（与估算口径一起构成 tokenizer 计数快照） */
export const TOKENIZER_DECLARATION = Object.freeze({
  counting: 'estimate(zh:1/char, else:ceil(len/4))',
  generationModel: 'glm-5.3 (zai-coding-cn)',
  exactModelTokenizer: 'unavailable (hosted API)',
  adr: 'adr-101',
});

/**
 * 决策 #7：成本闸门。
 * - 无配置拒绝出站（adr-102 决策 1：缺失即拒绝发起并显式停机，无默认预算）
 * - 超上限显式停机（adr-102 决策 4）
 * - 边界口径：adr-102 只写"超每日上限"，未定义"等于上限"；本文取严格大于（>）才拦截，
 *   等于上限仍放行——"超"按字面即 strictly exceeded，且无默认预算的精神指向显式上限内可用。
 * @param {{policy?: {llm?: object}, usage?: {dailyCny?: number, dailyTokens?: number}}} input
 * @returns {{allowed: boolean, reason?: string, stop?: boolean}}
 */
export function checkCostGate({ policy, usage } = {}) {
  // 无配置（policy 缺失 / llm 为空 / 无 apiKey 且无 provider）→ 拒绝发起并显式停机
  const llm = policy && policy.llm;
  const hasConfig = !!llm && (llm.apiKey || llm.provider);
  if (!hasConfig) {
    return { allowed: false, reason: 'E_COST_CONFIG_MISSING', stop: true };
  }
  const u = usage ?? {};
  if (u.dailyCny !== undefined && u.dailyCny > llm.dailyLimitCny) {
    return { allowed: false, reason: 'E_COST_LIMIT_EXCEEDED', stop: true };
  }
  if (llm.dailyTokenLimit !== undefined && u.dailyTokens !== undefined && u.dailyTokens > llm.dailyTokenLimit) {
    return { allowed: false, reason: 'E_COST_LIMIT_EXCEEDED', stop: true };
  }
  return { allowed: true };
}
