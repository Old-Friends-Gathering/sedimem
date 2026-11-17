// config/paths.js — 派生层路径与命名的单一来源（契约：docs/02 §3.11 裁决 39）
// 为什么单独一个模块：metrics 文件名规则原先在 nightly.js（写侧 3 处）与 web/handlers.js（读侧 1 处）
// 各写一遍正则，改名漂移会让趋势图静默缺数。这里把「scope → scopeKey → 文件名」收敛到一处。
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

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

// —— B3：memoHome 解析的唯一入口（docs/02 I-10）——
// 之前 CLI 直接拼 `process.env.MEMO_HOME || ~/.memo`，profiles 概念无处落地。
// 现在所有入口（CLI/service/测试脚本）都必须走这里，命名 profile 才可能互不可见。

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function profileError(message) {
  const err = new Error(message);
  err.code = 'E_PROFILE_UNAVAILABLE';
  return err;
}

/** 默认 base：MEMO_HOME 优先（测试/多实例），否则 ~/.memo（契约不变） */
export function memoBaseHome(env = process.env) {
  const raw = env?.MEMO_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return nodePath.resolve(raw.trim());
  return nodePath.join(os.homedir(), '.memo');
}

/**
 * 读 `$MEMO_HOME/profiles.json`（指针文件）。缺失/损坏一律 fail-closed：
 * 宁可报错，也不能让一个声称命名 profile 的进程静默读写默认库（数据串库比崩溃更糟）。
 * 指针格式：{ version:1, profiles:{ "work": { "path": "/abs/or/relative" } } }
 */
function readProfilePointer(base, name) {
  const file = nodePath.join(base, 'profiles.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw profileError(`profile: ${file} not found（命名 profile 必须显式注册，缺失指针 fail-closed）`);
    throw profileError(`profile: cannot read ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw profileError(`profile: ${file} is not valid JSON: ${e.message}`);
  }
  const entry = parsed?.profiles?.[name];
  if (entry === undefined) throw profileError(`profile: ${name} is not registered in ${file}`);
  const target = typeof entry === 'string' ? entry : entry?.path;
  if (typeof target !== 'string' || target.trim() === '') {
    throw profileError(`profile: ${name} has no usable path in ${file}`);
  }
  const resolved = nodePath.resolve(base, target.trim());
  // 命名 profile 目录必须在 <base>/profiles/ 之下；否则一个被篡改的指针能把进程
  // 指到任意目录（包括 ~/.memo 本身或系统目录）。
  const profilesRoot = nodePath.join(base, 'profiles');
  const rel = nodePath.relative(profilesRoot, resolved);
  if (rel === '' || rel.startsWith('..') || nodePath.isAbsolute(rel)) {
    throw profileError(`profile: ${name} path ${resolved} escapes ${profilesRoot}`);
  }
  return resolved;
}

/**
 * 解析 memoHome（唯一入口）。
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [cwd] 仅为契约保留（相对路径基准是 base，不是 cwd）
 * @param {string} [profilePointer] 显式 profile 名；缺省读 env.MEMO_PROFILE
 * @returns {string} 绝对路径
 */
export function resolveMemoHome(env = process.env, cwd = process.cwd(), profilePointer) {
  const base = memoBaseHome(env);
  const name = String(profilePointer ?? env?.MEMO_PROFILE ?? '').trim();
  if (name === '') return base; // 默认 profile：~/.memo（或 MEMO_HOME）路径完全不变
  if (!PROFILE_NAME.test(name)) throw profileError(`profile: invalid name ${JSON.stringify(name)}`);
  return readProfilePointer(base, name);
}
