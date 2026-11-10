#!/usr/bin/env bash
# 把权威实现同步到插件副本（插件独立运行时用；规则只有一处真相）。
# 复制两份：src/render/inject.js → lib/inject-core.js，src/config/paths.js → lib/paths-core.js，
# 并把 inject-core 里对 ../config/paths.js 的 import 改指同目录的 ./paths-core.js。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V="versions/$(cat "$ROOT/versions/CURRENT")"
LIB="$ROOT/plugin/dsh-sedimem/lib"

{
  echo "// ⚠️ 自动生成：由 ${V}/src/config/paths.js 复制而来，勿手改（改权威实现后重跑 scripts/sync-plugin.sh）。"
  cat "$ROOT/$V/src/config/paths.js"
} > "$LIB/paths-core.js"

{
  echo "// ⚠️ 自动生成：由 ${V}/src/render/inject.js 复制而来，勿手改（改权威实现后重跑 scripts/sync-plugin.sh）。"
  sed "s#from '../config/paths.js'#from './paths-core.js'#" "$ROOT/$V/src/render/inject.js"
} > "$LIB/inject-core.js"

echo "synced: $V/src/{render/inject,config/paths}.js → plugin/dsh-sedimem/lib/{inject-core,paths-core}.js"
