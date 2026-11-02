#!/usr/bin/env bash
# Claude Code 接入 memo MCP server（stdio，换行分隔 JSON-RPC）。
#
# 用法：
#   bash configs/claude-mcp.sh            # 注册（user 域，所有项目可用）
#   bash configs/claude-mcp.sh --local    # 仅注册到当前项目
#   bash configs/claude-mcp.sh --remove   # 移除
#
# 需要：claude CLI + Node ≥ 22。Node 默认取 PATH 里的 node，
# 也可显式指定：MEMO_NODE=/abs/path/to/node bash configs/claude-mcp.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"      # versions/vX.Y
NODE="${MEMO_NODE:-$(command -v node || true)}"
SERVER="$ROOT/src/mcp/server.js"

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "找不到可执行的 node（需 ≥22）。可用 MEMO_NODE=/abs/path/to/node 显式指定。" >&2
  exit 1
fi

echo "node   = $NODE"
echo "server = $SERVER"

case "${1:-}" in
  --remove) claude mcp remove memo ;;
  --local)  claude mcp add --scope local memo --env MEMO_HOME="$HOME/.memo" -- "$NODE" "$SERVER" ;;
  *)        claude mcp add --scope user  memo --env MEMO_HOME="$HOME/.memo" -- "$NODE" "$SERVER" ;;
esac

echo
echo "验证：claude mcp list   （应看到 memo ... ✔ Connected）"
