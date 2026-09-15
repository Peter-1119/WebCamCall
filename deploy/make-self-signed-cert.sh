#!/usr/bin/env bash
# 只有在 VM 的 nginx 還沒有 HTTPS 憑證時才需要。在 VM 上執行。
# 產生含 SAN 的自簽憑證：iOS Safari 沒有 SAN 會直接拒絕，連「仍要前往」都不給。
#
# 用法：./make-self-signed-cert.sh <VM 的 IP 或主機名>
set -euo pipefail
HOST="${1:?用法: $0 <ip-or-hostname>}"
OUT=/etc/nginx/ssl
sudo mkdir -p "$OUT"

if [[ "$HOST" =~ ^[0-9.]+$ ]]; then SAN="IP:$HOST"; else SAN="DNS:$HOST"; fi

sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$OUT/scanner.key" -out "$OUT/scanner.crt" \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=$SAN" \
  -addext "basicConstraints=CA:FALSE" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"

echo "已產生："
echo "  ssl_certificate     $OUT/scanner.crt;"
echo "  ssl_certificate_key $OUT/scanner.key;"
echo "把這兩行放進 nginx 的 server { listen 443 ssl; ... } 區塊，然後 sudo nginx -t && sudo systemctl reload nginx"
