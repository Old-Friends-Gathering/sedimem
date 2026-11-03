// config/policy.js — config/policy.json 的唯一加载点（裁决 20：策略单一来源）
// 其余模块一律 `import { defaultPolicy } from '../config/policy.js'`（或按需 loadPolicy(overrides)），
// 禁止再各自 readFileSync config/policy.json。

import { readFileSync } from 'node:fs';

/** 深合并：plain object 递归合并，数组与标量整体覆盖（overrides 优先）。 */
function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    const bv = base?.[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)
      && bv && typeof bv === 'object' && !Array.isArray(bv))
      ? deepMerge(bv, v)
      : v;
  }
  return out;
}

/** 递归冻结（含嵌套对象；数组按元素冻结）。 */
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return Object.freeze(obj);
}

/**
 * 加载 config/policy.json 并深合并 overrides，返回冻结对象。
 * 文件缺失/坏 JSON → fail-loud（err.code='E_POLICY'）。
 * @param {object} [overrides] 覆盖片段（构造参数覆盖用）
 * @returns {Readonly<object>}
 */
export function loadPolicy(overrides) {
  let base;
  try {
    const url = new URL('../../config/policy.json', import.meta.url);
    base = JSON.parse(readFileSync(url, 'utf8'));
  } catch (cause) {
    const err = new Error(`policy: cannot load config/policy.json (${cause.message})`);
    err.code = 'E_POLICY';
    err.cause = cause;
    throw err;
  }
  return deepFreeze(deepMerge(base, overrides));
}

/** 生产默认策略（模块加载时读一次，冻结）。 */
export const defaultPolicy = loadPolicy();

export default defaultPolicy;
