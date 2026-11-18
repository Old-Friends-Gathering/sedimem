#!/usr/bin/env bash
# 把 versions/<CURRENT> 的 src/ 与 ui/ config/ 同步进插件内嵌目录。
# 插件必须自包含（npm 发布后不能引用仓库其它路径），所以用拷贝而不是软链；
# test/host.test.js 里有哈希一致性断言，漂移会红。
# issue #241 教训：快照源不能钉死在老版本（v0.3）——内嵌兜底一旦被宿主进程驻留，
# 就会用老 UI 盖住新版常驻观察台。现在跟随 versions/CURRENT 指针。
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
current="$(cat "$root/versions/CURRENT" | tr -d '[:space:]')"
src="$root/versions/$current"
dst="$(cd "$(dirname "$0")/.." && pwd)/lib"
if [ ! -d "$src" ]; then
  echo "versions/$current 不存在（CURRENT 指针坏了？）" >&2
  exit 1
fi
rm -rf "$dst/src" "$dst/ui" "$dst/config"
cp -R "$src/src" "$dst/src"
cp -R "$src/ui" "$dst/ui"
cp -R "$src/config" "$dst/config"
find "$dst/src" "$dst/ui" "$dst/config" -name '*.js' -exec chmod 644 {} +
echo "synced versions/$current → $(dirname "$dst")/lib"
