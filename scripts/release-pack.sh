#!/usr/bin/env bash
# 打包三個套件成 .tgz（給沒有 npm registry 的專案用 `pnpm add ./xxx.tgz` 安裝）。
# 產出：release/scanner-core-<ver>.tgz、scanner-vue-<ver>.tgz、scanner-ui-<ver>.tgz
#      release/zxing_reader.wasm（要放進 App 的靜態目錄）
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
rm -rf release && mkdir -p release
for p in core vue ui; do
  pnpm --filter "@scanner/$p" pack --pack-destination "$PWD/release" > /dev/null
done
cp node_modules/.pnpm/zxing-wasm@*/node_modules/zxing-wasm/dist/reader/zxing_reader.wasm release/ 2>/dev/null \
  || cp packages/core/node_modules/zxing-wasm/dist/reader/zxing_reader.wasm release/
ls -la release
