// config/perms.js — 私有目录/文件权限（P0b B4，契约：docs/02 §3.24、docs/08 §7）
//
// 为什么单独一层：`src/web/*` 不许 import `src/storage/*`（裁决 34 / Q9），而 Web、MCP、CLI
// 三处都要「建私有目录 + 启动时自查权限」，所以放在都能 import 的 config 层。
//
// 取舍（WARN 不 BLOCK）：已经存在的 `~/.memo` 普遍是 0755 / 文件 0644（本机实测如此）。
// 启动时直接阻断会把所有老用户挡在门外；P0b 选「只告警 + 新写入一律收紧到 0700/0600」，
// 这样既有数据不会被锁死，新数据不会继续泄漏。要不要强制，留给后续版本单独决策。
//
// 平台：POSIX（macOS/Linux）用 mode 位；Windows 的 chmod 不表达 ACL，**明确不承诺**，
// 直接返回 skipped（文档 docs/02 §3.24 登记了这一点）。

import fsp from 'node:fs/promises';
import path from 'node:path';

/** 私有目录 mode：仅 owner 可读写进入（0700）。 */
export const MEMO_DIR_MODE = 0o700;
/** 私有文件 mode：仅 owner 可读写（0600）。 */
export const MEMO_FILE_MODE = 0o600;

/** 判「不是私有」只看 group/other 位：owner 位（读/写/执行）不影响别的用户能否读到。 */
export function isModePrivate(mode) {
  return ((Number(mode) & 0o077) === 0);
}

const oct = (mode) => `0${(Number(mode) & 0o777).toString(8).padStart(3, '0')}`;

/**
 * 确保 memoHome 存在且是 0700。已存在的目录**不改权限**（见文件头的 WARN 取舍）：
 * 只保证新建的那一层是 0700，老目录的宽权限交给 inspectMemoPerms 告警。
 */
export async function ensureMemoDir(memoHome) {
  await fsp.mkdir(memoHome, { recursive: true, mode: MEMO_DIR_MODE });
}

/**
 * 启动时自查：memoHome 目录 + 已知的隐私文件是否只剩 owner 可读。
 * 只读、不修权限（修权限是用户显式动作，避免服务静默改用户的文件系统）。
 *
 * @param {string} memoHome
 * @param {{platform?: string}} [opts] 测试可注入 platform，模拟 Windows 分支
 * @returns {Promise<{ok: boolean, platform: string, skipped: boolean,
 *   issues: Array<{path: string, kind: 'dir'|'file', mode: number, expected: number}>}>}
 */
export async function inspectMemoPerms(memoHome, { platform = process.platform } = {}) {
  const issues = [];
  if (platform === 'win32') return { ok: true, platform, skipped: true, issues };

  const stat = await fsp.stat(memoHome).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return { ok: false, platform, skipped: false, issues: [{ path: memoHome, kind: 'dir', mode: null, expected: MEMO_DIR_MODE }] };
  }
  if (!isModePrivate(stat.mode)) {
    issues.push({ path: memoHome, kind: 'dir', mode: stat.mode, expected: MEMO_DIR_MODE });
  }

  const files = [path.join(memoHome, 'web-token'), path.join(memoHome, 'events.jsonl')];
  // 分库覆盖文件（.scope.<client>.json）也属于「配置」：只该本用户可读。
  const homeEntries = await fsp.readdir(memoHome, { withFileTypes: true }).catch(() => []);
  for (const ent of homeEntries) {
    if (ent.isFile() && /^\.scope\..*\.json$/.test(ent.name)) files.push(path.join(memoHome, ent.name));
  }
  const itemsDir = path.join(memoHome, 'items');
  const entries = await fsp.readdir(itemsDir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith('.jsonl')) files.push(path.join(itemsDir, ent.name));
  }
  for (const file of files) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (!isModePrivate(st.mode)) {
      issues.push({ path: file, kind: 'file', mode: st.mode, expected: MEMO_FILE_MODE });
    }
  }
  return { ok: issues.length === 0, platform, skipped: false, issues };
}

/**
 * 把自查结果变成人话告警（每项一行，不含换行符）；调用方决定写 stderr 还是日志。
 * 只描述与建议，不声称已经修复。
 */
export function describePermIssues(report) {
  if (!report || report.ok || report.skipped) return [];
  return report.issues.map((issue) => {
    const expected = oct(issue.expected);
    const actual = issue.mode === null ? '不存在' : oct(issue.mode);
    const what = issue.kind === 'dir' ? '目录' : '文件';
    return `[memo] 权限过宽：${what} ${issue.path} 当前 ${actual}，建议 ${expected}`;
  });
}
