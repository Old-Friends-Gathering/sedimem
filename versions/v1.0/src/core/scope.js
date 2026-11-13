// core/scope.js — scope 解析（契约：env.MEMO_SCOPE 优先 → 向上找 .git 取目录名 → 目录名兜底）

import path from 'node:path';
import fs from 'node:fs';

/**
 * @param {{cwd?: string, env?: object}} args
 * @returns {{scope: string, root: string}} scope 形如 'repo:x' | 'dir:y'
 */
export function resolveScope({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.MEMO_SCOPE && String(env.MEMO_SCOPE).trim()) {
    return { scope: String(env.MEMO_SCOPE).trim(), root: path.resolve(cwd) };
  }
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return { scope: `repo:${path.basename(dir)}`, root: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const abs = path.resolve(cwd);
  return { scope: `dir:${path.basename(abs)}`, root: abs };
}
