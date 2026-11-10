#!/bin/bash
# v0.4 架构审核探针：真实 CLI 接线。
# 只操作临时 MEMO_HOME，不碰仓库数据。
set -u
NODE=/Users/yeager/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
cd "$(dirname "$0")/../.." || exit 1
export MEMO_HOME=$(mktemp -d /tmp/sedimem-v04-cli-XXXXXX)
export MEMO_SCOPE=repo:probe
IN=$(mktemp /tmp/sedimem-v04-in-XXXXXX)
printf '记住：明天发布 v0.4\n- 坑：capture list 的 status 不生效\n' > "$IN"

echo "== capture scan =="
"$NODE" src/cli/memo.js capture scan --file "$IN" --json > /tmp/v04-scan.json
cat /tmp/v04-scan.json

echo
echo "== capture list --status pending（accept 前）=="
"$NODE" src/cli/memo.js capture list --status pending

ID=$("$NODE" -e "const j=require('/tmp/v04-scan.json'); console.log(j.added[0].id)")
echo
echo "== capture accept --ids <id>（opts.ids 是字符串，targetIds 只认数组）=="
"$NODE" src/cli/memo.js capture accept --ids "$ID"
echo "exit=$?"

echo
echo "== capture accept --all =="
"$NODE" src/cli/memo.js capture accept --all

echo
echo "== capture list --status pending（accept 后；真实 CLI 未透传 status）=="
"$NODE" src/cli/memo.js capture list --status pending

echo
echo "== capture list（无过滤，对照）=="
"$NODE" src/cli/memo.js capture list
