# 在其他專案安裝

目前沒有 npm registry，用 **`.tgz` 檔**安裝。每個版本的檔案在 GitHub Releases：
https://github.com/Peter-1119/WebCamCall/releases

（或自己產：clone 後 `pnpm install && pnpm release:pack`，檔案在 `release/`。）

## 1. 取得四個檔案

```
scanner-core-0.1.0.tgz
scanner-vue-0.1.0.tgz      ← Vue 專案才需要
scanner-ui-0.1.0.tgz       ← 要用 <BarcodeScanner> 才需要
zxing_reader.wasm          ← 一定要，放進 App 的靜態目錄
```

## 2. 放進專案並安裝

建議放在專案的 `vendor/` 目錄（要進 git，其他人 clone 下來才裝得起來）：

```bash
mkdir -p vendor public
cp scanner-*.tgz vendor/
cp zxing_reader.wasm public/          # Vite 專案；其他框架放到會被原樣 serve 的靜態目錄
```

`package.json`：

```json
{
  "dependencies": {
    "@scanner/core": "file:./vendor/scanner-core-0.1.0.tgz",
    "@scanner/vue":  "file:./vendor/scanner-vue-0.1.0.tgz",
    "@scanner/ui":   "file:./vendor/scanner-ui-0.1.0.tgz",
    "vue": "^3.3.0"
  }
}
```

```bash
pnpm install     # npm / yarn 也可以
```

## 3. 使用

```vue
<script setup>
import { BarcodeScanner } from '@scanner/ui'
const onDecoded = (r) => console.log(r.text, r.format)
</script>

<template>
  <div style="width: 100%; aspect-ratio: 3 / 4">
    <BarcodeScanner :formats="['qr_code']" wasm-url="/zxing_reader.wasm" @decoded="onDecoded">
      <template #hint="{ hint }">{{ { align: '對準框內', 'move-closer': '靠近一點', 'hold-steady': '拿穩' }[hint] }}</template>
      <template #error="{ error, retry }"><button @click="retry">{{ error.code }}，重試</button></template>
    </BarcodeScanner>
  </div>
</template>
```

- **`wasm-url` 一定要給**，路徑是 App 部署後 `zxing_reader.wasm` 的 URL。掛在子路徑（例如 `/rms/`）時要寫 `/rms/zxing_reader.wasm`，Vite 專案可用 `` `${import.meta.env.BASE_URL}zxing_reader.wasm` ``。
- `<BarcodeScanner>` 會填滿父容器，父容器要給尺寸。
- 只掃一維條碼：`:formats="LINEAR_FORMATS"`（從 `@scanner/vue` import）。
- 不用 `<BarcodeScanner>`、自己排版：用 `useBarcodeScanner()`，見 README。

## 4. 部署要注意

- **HTTPS**（相機的硬性條件）。
- nginx 的 mime.types 要有 `application/wasm wasm;`（舊版沒有）。
- 不能有 `Permissions-Policy: camera=()`。
- Rocky/RHEL 上 scp 的檔案要 `restorecon`。

細節：`docs/deploy.md`。

## 5. 升級

換掉 `vendor/` 裡的三個 `.tgz`、`public/zxing_reader.wasm`，改 `package.json` 的檔名，`pnpm install`。

## 之後若發到 npm

套件會改名成 `@peter-1119/scanner-core` 等，安裝變成一行 `pnpm add @peter-1119/scanner-ui`，
使用方式不變（只有 import 路徑的套件名改）。
