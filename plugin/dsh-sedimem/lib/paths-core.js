// ⚠️ 自动生成：由 versions/v1.0/src/config/paths.js 复制而来，勿手改（改权威实现后重跑 scripts/sync-plugin.sh）。
// config/paths.js — 派生层路径与命名的单一来源（契约：docs/02 §3.11 裁决 39）
// 为什么单独一个模块：metrics 文件名规则原先在 nightly.js（写侧 3 处）与 web/handlers.js（读侧 1 处）
// 各写一遍正则，改名漂移会让趋势图静默缺数。这里把「scope → scopeKey → 文件名」收敛到一处。

/**
 * scope 归一化成文件名安全片段：`repo:sedimem` → `repo-sedimem`。
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

const IS_WINDOWS = process.platform === 'win32';

/**
 * scope → 文件名安全片段。
 * POSIX 原样返回（`repo:x` → `repo:x`，契约不变）；
 * Windows 把 `:` 换成 `+`：`:` 在 NTFS 上是**备用数据流**分隔符，`items/repo:x.jsonl`
 * 会写成文件 `repo` 的一个数据流——按路径读写看似正常，但 readdir 看不见它，
 * 于是分库列表/统计/图谱全失真，copyFile/rename（compact、备份轮转）直接 EINVAL，
 * 且备份与拷贝会静默丢掉真相层。`+` 不在 SCOPE_PATTERN 的名字字符集内，反解无歧义。
 * @param {string} scope
 * @returns {string}
 */
function scopeFileNamePart(scope) {
  const s = String(scope ?? '');
  return IS_WINDOWS ? s.replace(/:/g, '+') : s;
}

/** 真相层文件名：`items/<此名>`（契约：docs/02 §3.11） */
export function itemsFileName(scope) {
  return `${scopeFileNamePart(scope)}.jsonl`;
}

/** brief 快照文件名：`brief/<此名>` */
export function briefFileName(scope) {
  return `${scopeFileNamePart(scope)}.md`;
}

/**
 * 文件名 → scope（items 目录枚举用；不匹配则 null）。
 * @param {string} name 目录项名字
 * @returns {string|null}
 */
export function scopeFromItemsFileName(name) {
  const n = String(name ?? '');
  if (!n.endsWith('.jsonl')) return null;
  const stem = n.slice(0, -'.jsonl'.length);
  return IS_WINDOWS ? stem.replace(/\+/g, ':') : stem;
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
