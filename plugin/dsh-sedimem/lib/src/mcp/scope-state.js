// mcp/scope-state.js —— 运行期分库（scope）选择（契约：docs/02 §3.6 裁决 28）
//
// 为什么需要它：MCP server 是**常驻进程**，cwd 在启动时固定（DSH 的 MCP 子进程 cwd 通常是
// 宿主目录 `~/.dsh/profiles/desktop`）。而 Claude Code / Codex 每次会话按**项目 cwd** 解析分库。
// 于是同一个项目在 DSH 侧写进 `dir:desktop`、在 CLI 侧读 `dir:<项目>`——三端「共享一个记忆库」
// 这件事被进程生命周期悄悄破坏。修法不是把 scope 写死，而是把「选择分库」变成可运行期变更、
// 可持久化、可被 Agent 一句工具调用对齐的能力。
//
// 优先级（高 → 低）：env MEMO_SCOPE > 持久化覆盖文件 $MEMO_HOME/.scope.json > cwd 解析。
// env 最高优先级是给「CI/一次性会话」钉死分库用的；常驻进程正常走文件。

import fs from 'node:fs';
import path from 'node:path';

/** scope 形状：`repo:名字` / `dir:名字` / `user:名字` / `global:名字`，小写字母数字开头，允许 . _ -，总长 ≤64。 */
export const SCOPE_PATTERN = /^(repo|dir|user|global):[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 覆盖文件按**客户端**隔离：`<memoHome>/.scope.<client>.json`。
 * 为什么不能共用一个文件：覆盖是「常驻进程上次切到哪」，若全局共享，
 * DSH 把 scope 切到项目 A 后，Claude 在项目 B 启动也会读到 A —— 跨项目污染记忆。
 * clientKey 取自 MCP initialize 的 clientInfo.name（claude-code / codex / dsh…），未知则 'default'。
 */
export function clientKey(name) {
  const raw = String(name ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return raw ? raw.slice(0, 32) : 'default';
}

export function scopeFilePath(memoHome, key = 'default') {
  return path.join(memoHome, `.scope.${clientKey(key)}.json`);
}

/** 读持久化覆盖；文件缺失/损坏/形状非法一律返回 undefined（绝不因此让 server 起不来）。 */
export function readScopeOverride(memoHome, key = 'default') {
  try {
    const raw = JSON.parse(fs.readFileSync(scopeFilePath(memoHome, key), 'utf8'));
    if (raw && typeof raw.scope === 'string' && SCOPE_PATTERN.test(raw.scope)) return raw.scope;
  } catch {
    /* 忽略：无文件或已损坏 */
  }
  return undefined;
}

/** 写持久化覆盖（原子性够用：单进程、单文件、内容极小）。 */
export function writeScopeOverride(memoHome, scope, key = 'default') {
  if (!SCOPE_PATTERN.test(scope)) {
    const e = new Error(`非法 scope: ${scope}`);
    e.code = 'E_INVALID_ARG';
    throw e;
  }
  const file = scopeFilePath(memoHome, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ scope, at: new Date().toISOString() }, null, 2) + '\n');
  return file;
}

/**
 * 启动时的分库状态。
 * @param {{memoHome: string, cwd?: string, env?: object, resolveScope: Function}} args
 * @returns {{scope: string, source: 'env'|'file:.scope.json'|'cwd'}}
 */
export function initScopeState({ memoHome, cwd = process.cwd(), env = process.env, resolveScope, client = 'default' }) {
  const fromEnv = env && env.MEMO_SCOPE != null ? String(env.MEMO_SCOPE).trim() : '';
  if (fromEnv) return { scope: fromEnv, source: 'env' };
  const override = readScopeOverride(memoHome, client);
  if (override) return { scope: override, source: `file:.scope.${clientKey(client)}.json` };
  return { scope: resolveScope({ cwd, env: {} }).scope, source: 'cwd' };
}

/**
 * 把 memory_scope({action:'use', ...}) 的参数解析成目标 scope（纯函数，不落盘）。
 * - 显式 `scope`：形状校验后直接用。
 * - `path`：复用与 cwd 自动解析**完全相同**的规则（repo:<git 目录名> / dir:<目录名>）。
 *   显式 `env: {}` 是刻意的：调用方说「按这个路径解析」，就不该被 MEMO_SCOPE 再劫持一次。
 * @returns {string}
 */
export function resolveUseTarget({ scope, path: p, resolveScope }) {
  if (scope != null) {
    if (!SCOPE_PATTERN.test(scope)) {
      const e = new Error(`scope 需形如 repo:名字 / dir:名字（小写字母数字 . _ -，≤64），收到: ${scope}`);
      e.code = 'E_INVALID_ARG';
      throw e;
    }
    return scope;
  }
  if (p != null) {
    if (!path.isAbsolute(p)) {
      const e = new Error(`path 需为绝对路径，收到: ${p}`);
      e.code = 'E_INVALID_ARG';
      throw e;
    }
    return resolveScope({ cwd: p, env: {} }).scope;
  }
  const e = new Error('use 需要 path（项目根目录）或 scope 之一');
  e.code = 'E_INVALID_ARG';
  throw e;
}
