// session/cli-support.js —— session 域里被 CLI 与 MCP 共用的纯常量/纯函数。
// 单向依赖：本模块只依赖 session/* 与 core/*，cli 与 mcp 都可以安全 import；
// 本模块严禁 import cli/* 或 mcp/*（由 tests/unit/arch-boundaries.test.js 断言）。

/** close 时晋升主库的白名单 kind（其余记录随库 tombstone） */
export const PROMOTE_KINDS = new Set(['decision', 'gotcha']);
