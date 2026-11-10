#!/usr/bin/env bash
# scripts/install-dsh-plugin.sh — D5：一条命令安装 dsh-sedimem 插件（幂等）
# 用法：scripts/install-dsh-plugin.sh [PROFILE=desktop 可用环境变量覆盖]
# 步骤：定位 node/pnpm → pnpm add file:<root>/plugin/dsh-sedimem → 备份并修补 cordis.patch.yml → 打印重启提示。
set -euo pipefail

# ── 0. 从脚本位置推仓库根（scripts/ 的上一级） ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugin/dsh-sedimem"
if [[ ! -f "$PLUGIN_DIR/package.json" ]]; then
  echo "错误: 未找到插件目录 $PLUGIN_DIR（请确认仓库布局）" >&2
  exit 1
fi

PROFILE="${PROFILE:-desktop}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "错误: DSH profile 目录不存在: $PROFILE_DIR（可用 PROFILE=xxx 覆盖）" >&2
  exit 1
fi

# ── 1. 定位 pnpm：优先 $DSH_PNPM，否则扫 dsh-runtimes ──
PNPM_MJS="${DSH_PNPM:-}"
if [[ -z "$PNPM_MJS" ]]; then
  for cand in "$HOME"/.dsh/dsh-runtimes/*/dependencies/pnpm/dist/pnpm.mjs; do
    if [[ -f "$cand" ]]; then PNPM_MJS="$cand"; break; fi
  done
fi
if [[ -z "$PNPM_MJS" || ! -f "$PNPM_MJS" ]]; then
  echo "错误: 找不到 pnpm.mjs（可设 DSH_PNPM 指向 pnpm.mjs 全路径）" >&2
  exit 1
fi

# node 与 pnpm 同目录布局：<deps>/pnpm/dist/pnpm.mjs → <deps>/node/bin/node
NODE_BIN="$(cd "$PNPM_MJS/../../node/bin" 2>/dev/null && pwd)/node"
if [[ ! -x "$NODE_BIN" ]]; then
  echo "错误: 找不到与 pnpm 配套的 node 二进制（期望 $NODE_BIN）" >&2
  exit 1
fi
echo "使用 node: $NODE_BIN"
echo "使用 pnpm: $PNPM_MJS"
echo "目标 profile: $PROFILE_DIR"

# ── 2. 幂等安装插件包 ──
cd "$PROFILE_DIR"
"$NODE_BIN" "$PNPM_MJS" add "file:$PLUGIN_DIR"

# ── 3. 修补 cordis.patch.yml（先备份再改，幂等） ──
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
TS="$(date +%Y%m%d%H%M%S)"
if [[ -f "$PATCH_FILE" ]]; then
  cp "$PATCH_FILE" "$PATCH_FILE.bak.$TS"
  echo "已备份: $PATCH_FILE.bak.$TS"
else
  # 首次安装 profile 尚无 patch 层：按现有 row 的顶层 `- insert:` 数组形状新建
  cat > "$PATCH_FILE" <<EOF
- insert:
    - id: dsh-sedimem
      name: dsh-sedimem
      config:
        observerUrl: http://127.0.0.1:7788
EOF
  echo "已新建: $PATCH_FILE"
fi

# 已有 name: dsh-sedimem 行 → 只确保 observerUrl 指向本地 observer（python3 文本替换，幂等）
if grep -q 'name: dsh-sedimem' "$PATCH_FILE"; then
  python3 - "$PATCH_FILE" <<'PYEOF'
import re, sys
path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    text = f.read()
# 只在 dsh-sedimem 条目范围内把已有 observerUrl 行改指本地 observer；没有 observerUrl 行则在 name 行后补一行
m = re.search(r'(- id: dsh-sedimem\n\s+name: dsh-sedimem\n)((?:[ \t]+.*\n)*?)(?=[-#]|\Z)', text)
if not m:
    sys.exit('错误: 找到 name: dsh-sedimem 但无法解析条目块')
head, body = m.group(1), m.group(2)
if re.search(r'^\s*observerUrl:', body, re.M):
    body = re.sub(r'^(\s*observerUrl:).*$', r'\1 http://127.0.0.1:7788', body, flags=re.M)
else:
    body = body + '        observerUrl: http://127.0.0.1:7788\n'
with open(path, 'w', encoding='utf-8') as f:
    f.write(text[:m.start()] + head + body + text[m.end():])
print('observerUrl 已确保指向 http://127.0.0.1:7788')
PYEOF
else
  # 没有则追加 insert 行（格式照抄现有 row 的形状）
  cat >> "$PATCH_FILE" <<EOF
- insert:
    - id: dsh-sedimem
      name: dsh-sedimem
      config:
        observerUrl: http://127.0.0.1:7788
EOF
  echo "已追加 dsh-sedimem insert 行"
fi

# ── 4. 收尾提示 ──
cat <<EOF

安装完成。请重启 DSH（或该 profile 的宿主进程）以加载插件。

校验（重启后执行）：
  curl -sS http://127.0.0.1:7788/health
EOF
