#!/usr/bin/env bash
# 把 playground build 成靜態檔並上傳到 VM，由 nginx 直接 serve。
#
# 用法（Git Bash / WSL）：
#   DEPLOY_TARGET=user@vm-host DEPLOY_PATH=/var/www/scanner ./scripts/deploy-playground.sh
#
# 可選：
#   PLAYGROUND_BASE=/scanner/   掛在子路徑時設定（結尾要有斜線），預設 /
set -euo pipefail

: "${DEPLOY_TARGET:?請設定 DEPLOY_TARGET=user@host}"
: "${DEPLOY_PATH:?請設定 DEPLOY_PATH=/var/www/scanner}"
export PLAYGROUND_BASE="${PLAYGROUND_BASE:-/}"

cd "$(dirname "$0")/.."
echo "→ build (base=$PLAYGROUND_BASE)"
pnpm --filter playground build

echo "→ upload to $DEPLOY_TARGET:$DEPLOY_PATH"
ssh "$DEPLOY_TARGET" "mkdir -p '$DEPLOY_PATH'"
scp -r examples/playground/dist/* "$DEPLOY_TARGET:$DEPLOY_PATH/"
echo "✓ done"
