#!/usr/bin/env bash
# 把 playground build 成靜態檔並上傳到 VM，由 nginx 直接 serve。
#
# 用法（Git Bash / WSL）：
#   ./scripts/deploy-playground.sh
#
# 預設目標是 KSRL-SF-WEB（https://sfserver.flexium.com.tw/scanner/），可用環境變數覆寫：
#   DEPLOY_TARGET=kw60user@10.1.5.119  DEPLOY_PATH=/var/www/scanner  PLAYGROUND_BASE=/scanner/
#
# VM 上一次性準備（讓 kw60user 不用 sudo 就能上傳）：
#   sudo mkdir -p /var/www/scanner && sudo chown kw60user:kw60user /var/www/scanner
set -euo pipefail

: "${DEPLOY_TARGET:=kw60user@10.1.5.119}"
: "${DEPLOY_PATH:=/var/www/scanner}"
export PLAYGROUND_BASE="${PLAYGROUND_BASE:-/scanner/}"

cd "$(dirname "$0")/.."
echo "→ build (base=$PLAYGROUND_BASE)"
pnpm --filter playground build

echo "→ upload to $DEPLOY_TARGET:$DEPLOY_PATH"
ssh "$DEPLOY_TARGET" "mkdir -p '$DEPLOY_PATH' && rm -rf '$DEPLOY_PATH'/assets"
scp -r examples/playground/dist/* "$DEPLOY_TARGET:$DEPLOY_PATH/"

# Rocky/RHEL 的 SELinux：scp 寫入的新檔標籤不是 httpd_sys_content_t，nginx 會 403。
# restorecon 需要 sudo；若 VM 上 kw60user 的 sudo 要密碼，這行會提示輸入。
echo "→ fix SELinux labels"
ssh -t "$DEPLOY_TARGET" "sudo restorecon -R '$DEPLOY_PATH'"
echo "✓ done"
