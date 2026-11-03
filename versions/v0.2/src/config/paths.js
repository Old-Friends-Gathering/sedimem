// config/paths.js — 派生层路径与命名的单一来源（契约：docs/02 §3.11 裁决 39）
// 为什么单独一个模块：metrics 文件名规则原先在 nightly.js（写侧 3 处）与 web/handlers.js（读侧 1 处）
// 各写一遍正则，改名漂移会让趋势图静默缺数。这里把「scope → scopeKey → 文件名」收敛到一处。

/**
 * scope 归一化成文件名安全片段：`repo:strata` → `repo-strata`。
 * 规则：非 [a-z0-9._-] 的连续字符折叠成单个 `-`（大小写统一小写）。
 * @param {string} scope
 * @returns {string}
 */
export function scopeKeyOf(scope) {
  const raw = String(scope ?? '').trim();
  if (raw === '') return 'default';
  const key = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return key === '' ? 'default' : key;
}

/**
 * metrics 快照文件名（写侧用；读侧用 readMetricsSnapshot 而不是自己拼）。
 * @param {string} date YYYY-MM-DD
 * @param {string} scope
 * @returns {string}
 */
export function metricsFileName(date, scope) {
  return `${date}.${scopeKeyOf(scope)}.json`;
}

/**
 * 旧命名（0.1.2 之前，只有日期）——仅用于读侧兼容回退，写侧永不使用。
 * @param {string} date
 */
export function legacyMetricsFileName(date) {
  return `${date}.json`;
}
