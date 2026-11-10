#!/usr/bin/env bash
# 把 versions/v0.3 的 src/ 与 ui/ 同步进插件内嵌目录。
# 插件必须自包含（npm 发布后不能引用仓库其它路径），所以用拷贝而不是软链；
# test/host.test.js 里有哈希一致性断言，漂移会红。
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
src="$root/versions/v0.3"
dst="$(cd "$(dirname "$0")/.." && pwd)/lib"
rm -rf "$dst/src" "$dst/ui" "$dst/config"
cp -R "$src/src" "$dst/src"
cp -R "$src/ui" "$dst/ui"
cp -R "$src/config" "$dst/config"
find "$dst/src" "$dst/ui" -name '*.js' -exec chmod 644 {} +
echo "synced versions/v0.3 → $(dirname "$dst")/lib"
