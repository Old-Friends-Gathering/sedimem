#!/bin/sh
# scripts/strata-run.sh — 按 versions/CURRENT 跑当前版本的 CLI（issue #47）
#
# 为什么需要它：launchd/crontab 里的绝对路径一旦写死版本目录，换大版本（v0.1 → v0.2）就会
# 悄悄跑旧代码——实测有台机器的 nightly 在版本切换后还指着已冻结的 versions/v0.1，
# 门禁扫仓库扫不到，只有查 crontab 才发现。所以入口脚本统一读 CURRENT。
#
# 用法：
#   scripts/strata-run.sh serve [--port 7788]
#   scripts/strata-run.sh nightly [--dry-run]
#   scripts/strata-run.sh --print serve      # 只打印将执行的命令（供测试断言，不执行）
#
# 环境变量：
#   MEMO_NODE   node 可执行文件（缺省用 PATH 里的 node）
#   MEMO_HOME   记忆库目录（传给 CLI）
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CURRENT_FILE="$ROOT/versions/CURRENT"

die() { printf '%s\n' "strata-run: $*" >&2; exit 2; }
usage() {
  printf '%s\n' "用法: $0 <serve|nightly> [参数...]" >&2
  printf '%s\n' "      $0 --print <serve|nightly> [参数...]" >&2
  exit 2
}

PRINT=0
if [ "${1:-}" = "--print" ]; then
  PRINT=1
  shift
fi

CMD=${1:-}
[ -n "$CMD" ] || usage
[ $# -gt 0 ] && shift || true

case "$CMD" in
  serve)   ENTRY="src/cli/memo.js";   ARGS="serve $*" ;;
  nightly) ENTRY="src/cli/nightly.js"; ARGS="$*" ;;
  *) usage ;;
esac

[ -f "$CURRENT_FILE" ] || die "缺少 $CURRENT_FILE（当前版本指针）"
VERSION=$(tr -d '[:space:]' < "$CURRENT_FILE")
[ -n "$VERSION" ] || die "$CURRENT_FILE 为空"
[ -f "$ROOT/versions/$VERSION/$ENTRY" ] || die "找不到 versions/$VERSION/$ENTRY"

NODE=${MEMO_NODE:-}
[ -n "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] || die "找不到 node：请设置 MEMO_NODE 或把 node 放进 PATH"

# 用 set -- 组装，避免数组（POSIX sh 没有数组）与拼接时的词分割问题
if [ $PRINT -eq 1 ]; then
  printf '%s %s/versions/%s/%s %s\n' "$NODE" "$ROOT" "$VERSION" "$ENTRY" "$ARGS"
  exit 0
fi

# shellcheck disable=SC2086  # ARGS 需要按空格拆分（CLI 参数约定本身如此）
exec "$NODE" "$ROOT/versions/$VERSION/$ENTRY" $ARGS
