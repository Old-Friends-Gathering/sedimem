// web/scopes.js — 分库发现（契约：docs/08-web-ui.md §13、issue #23）
// 数据来源就是磁盘事实：$MEMO_HOME/items/<scope>.jsonl。不读额外索引、不建状态文件。
// scope 名直接来自文件名，因此**只承认符合 SCOPE_PATTERN 的名字**（防把任意文件名当成 scope）。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { SCOPE_PATTERN } from '../core/scope-state.js';
import { scopeFromItemsFileName } from '../config/paths.js';

/**
 * 列出所有分库。
 * @param {string} memoHome
 * @param {string} [currentScope] 启动时解析出的分库（标记为 current，即使还没有文件也列出）
 * @returns {Promise<{scopes: {scope: string, records: number, bytes: number, mtime: string, current: boolean}[]}>}
 */
export async function listScopes(memoHome, currentScope) {
  const dir = path.join(memoHome, 'items');
  const out = [];
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    names = [];
  }
  for (const name of names) {
    const scope = scopeFromItemsFileName(name);
    if (scope === null) continue;
    if (!SCOPE_PATTERN.test(scope)) continue; // 不是分库文件（或名字不合法）→ 不列
    const full = path.join(dir, name);
    let stat;
    let text;
    try {
      // 只读一次：先 stat 再 read 会构成 TOCTOU（CodeQL js/file-system-race）
      text = await fsp.readFile(full, 'utf8');
      stat = await fsp.stat(full).catch(() => null);
    } catch {
      continue;
    }
    const records = text.split('\n').filter((l) => l.trim().length > 0).length;
    out.push({
      scope,
      records,
      bytes: Buffer.byteLength(text, 'utf8'),
      mtime: (stat?.mtime ?? new Date(0)).toISOString(),
      current: scope === currentScope,
    });
  }
  // 当前分库即使还没有文件，也要出现在列表里（否则 UI 下拉会在空库时消失）
  if (currentScope && !out.some((s) => s.scope === currentScope)) {
    out.push({ scope: currentScope, records: 0, bytes: 0, mtime: new Date(0).toISOString(), current: true });
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.scope.localeCompare(b.scope)));
  return { scopes: out };
}
