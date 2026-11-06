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
 * 校验 policy.kinds 段（issue #33：kind 注册表数据化后的契约防线）。
 * 为什么在 loadPolicy 里做：让坏配置在加载期就 fail-loud，而不是等到衰减/排序算出 NaN 才暴露。
 * @param {object} policy 已深合并的策略对象
 */
function validateKinds(policy) {
  const kinds = policy?.kinds;
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds) || Object.keys(kinds).length === 0) {
    const err = new Error('policy: kinds must be a non-empty object');
    err.code = 'E_POLICY';
    throw err;
  }
  // 颜色必须是 #rrggbb（六位十六进制），canvas 与 CSS 都能直接吃这个形状
  const colorRe = /^#[0-9a-fA-F]{6}$/;
  for (const [kind, meta] of Object.entries(kinds)) {
    if (!meta || typeof meta !== 'object'
      || !(meta.halfLifeMs > 0) || !(meta.weight > 0) || !colorRe.test(String(meta.color))) {
      const err = new Error(`policy: kinds.${kind} must be {halfLifeMs>0, weight>0, color:#rrggbb}, got ${JSON.stringify(meta)}`);
      err.code = 'E_POLICY';
      throw err;
    }
  }
}

/**
 * 加载 config/policy.json 并深合并 overrides，返回冻结对象。
 * 文件缺失/坏 JSON/kinds 段非法 → fail-loud（err.code='E_POLICY'）。
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
  const policy = deepFreeze(deepMerge(base, overrides));
  // 注意依赖方向：这里只校验数据形状，绝不 import record.js（record 反向依赖本模块，
  // 引入会成环）；kind 合法性判断由 record.js 用 kindNames() 的结果自己做。
  validateKinds(policy);
  return policy;
}

/** kind 未登记时的兜底色（与 ui/layout.js 的 KIND_COLORS.state 同值；不 import ui，
 *  避免 src → ui 的反向依赖——ui 才是末端展示层）。 */
export const FALLBACK_KIND_COLOR = '#94a3b8';

/**
 * 返回策略里登记的全部 kind 名（顺序即 policy.kinds 的键序，报错文案用它拼可选列表）。
 * @param {object} policy
 * @returns {string[]}
 */
export function kindNames(policy) {
  return Object.keys(policy?.kinds ?? {});
}

/**
 * 取单个 kind 的三类元数据（issue #33：唯一真相在 policy.kinds）。
 * 优先读 kinds 段；kinds 缺该 kind 时回落旧的 halfLifeMs/kindWeight 两段（向后兼容，
 * 覆盖只改旧段、未迁移 kinds 的自定义 policy），color 无旧段可回落，取 undefined。
 * @param {object} policy
 * @param {string} kind
 * @returns {{halfLifeMs:number, weight:number, color:string}|{halfLifeMs:number, weight:number}|null}
 */
export function kindMeta(policy, kind) {
  const entry = policy?.kinds?.[kind];
  if (entry) return { halfLifeMs: entry.halfLifeMs, weight: entry.weight, color: entry.color };
  const halfLifeMs = policy?.halfLifeMs?.[kind];
  const weight = policy?.kindWeight?.[kind];
  if (halfLifeMs !== undefined || weight !== undefined) return { halfLifeMs, weight };
  return null;
}

/**
 * 取单个 kind 的展示色；未登记/缺色时返回兜底色（保证图谱永远画得出节点）。
 * @param {object} policy
 * @param {string} kind
 * @returns {string}
 */
export function kindColor(policy, kind) {
  const c = policy?.kinds?.[kind]?.color;
  return typeof c === 'string' && c ? c : FALLBACK_KIND_COLOR;
}

/** 生产默认策略（模块加载时读一次，冻结）。 */
export const defaultPolicy = loadPolicy();

export default defaultPolicy;
