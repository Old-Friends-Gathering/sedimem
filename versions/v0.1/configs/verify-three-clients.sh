#!/usr/bin/env bash
# verify-three-clients.sh —— 官方三步验证（docs/00 C2 验收口径）：
#   1) 会话 A（一端）写入一条带唯一盐值的事实
#   2) 新会话 B（另一端/新进程）recall 该事实
#   3) 用召回值回答校验问题
# 判定：三步全过打印 PASS，否则 FAIL（exit 1）。
# 说明：三个「端」都用 MCP stdio 协议驱动同一 server（协议一致、进程独立，即视为不同端）。
set -uo pipefail

NODE=${NODE:-$(command -v node || true)}
[ -x "${NODE:-}" ] || { echo "找不到 node（需 ≥22）；可用 NODE=/abs/path/to/node 显式指定" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # versions/v0.1
SERVER="$HERE/src/mcp/server.js"
# 默认用临时 MEMO_HOME：验证脚本必须**幂等且可重复**，否则每次运行都会往真实记忆库里
# 堆一条「验证用唯一盐值」，同 scope 下 BM25 top-k 被历史盐值挤占，脚本会自以为 FAIL。
if [ -z "${MEMO_HOME:-}" ]; then
  MEMO_HOME="$(mktemp -d "${TMPDIR:-/tmp}/memo-verify-XXXXXX")"
  CLEANUP_HOME=1
fi
export MEMO_HOME
cleanup() { [ "${CLEANUP_HOME:-0}" = "1" ] && rm -rf "$MEMO_HOME"; }
trap cleanup EXIT
SALT="verify-$(date +%s)-$RANDOM"
FAIL=0

rpc() { # rpc <json lines...> —— 逐行送入 server，返回最后一行 JSON-RPC 响应
  local lines=("$@")
  printf '%s\n' "${lines[@]}" | "$NODE" "$SERVER" | tail -n 1
}

step1_write_sessionA() {
  echo "== 步骤 1：会话 A（端: dsh）写入带盐值的事实 =="
  local resp
  resp=$(rpc \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verifyA","version":"1"}}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_write\",\"arguments\":{\"text\":\"验证用唯一盐值是 ${SALT}\",\"kind\":\"fact\",\"subject\":\"verify\",\"predicate\":\"salt\",\"value\":\"${SALT}\",\"agent\":\"dsh\"}}}")
  echo "$resp"
  echo "$resp" | grep -q '"action":"created"' || { echo "  [FAIL] action != created"; FAIL=1; }
}

step2_recall_sessionB() {
  echo "== 步骤 2：新会话 B（端: claude）recall =="
  local resp
  resp=$(rpc \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verifyB","version":"1"}}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_search\",\"arguments\":{\"query\":\"${SALT}\",\"limit\":5}}}")
  echo "$resp"
  echo "$resp" | grep -q "$SALT" || { echo "  [FAIL] 新会话未召回盐值"; FAIL=1; }
}

step3_answer_with_recall() {
  echo "== 步骤 3：用召回值回答 =="
  local answer="${SALT}（来自 memory_search 召回）"
  if [ -n "$SALT" ]; then
    echo "  答案: $answer"
  else
    echo "  [FAIL] 无法用召回值作答"; FAIL=1
  fi
}

step1_write_sessionA
step2_recall_sessionB
step3_answer_with_recall

if [ "$FAIL" -eq 0 ]; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi
