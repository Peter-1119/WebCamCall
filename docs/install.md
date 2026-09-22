# 在其他專案安裝

套件在公開 npm：
- https://www.npmjs.com/package/@cclemon/scanner-core
- https://www.npmjs.com/package/@cclemon/scanner-vue
- https://www.npmjs.com/package/@cclemon/scanner-ui

## 1. 安裝

```bash
pnpm add @cclemon/scanner-ui @cclemon/scanner-vue @cclemon/scanner-core
# npm i / yarn add 也可以
```

只用 composable 不用預設 UI：裝 `scanner-vue` + `scanner-core`。純 JS / 其他框架：只裝 `scanner-core`。

## 2. wasm 檔

解碼用的 `zxing_reader.wasm`（953 KB）**已包在 `@cclemon/scanner-core` 裡**，有兩種取法：

### Vite 專案（推薦，零複製）

```js
import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'
```

Vite 會把它當靜態資源打包進 `dist/assets/`，`wasmUrl` 就是部署後的正確 URL（子路徑也自動處理）。

### 其他 bundler / 想自己控制位置

把 `node_modules/@cclemon/scanner-core/dist/zxing_reader.wasm` 複製到靜態目錄（例如 `public/`），
URL 依部署路徑填（掛在 `/rms/` 底下就是 `/rms/zxing_reader.wasm`）。

> 不設 `wasmUrl` 時會從 jsDelivr CDN 下載，**內網環境會失敗**（`decoder-init-failed`）。

## 3. 使用

```vue
<script setup>
import { BarcodeScanner } from '@cclemon/scanner-ui'
import wasmUrl from '@cclemon/scanner-core/zxing_reader.wasm?url'

const onDecoded = (r) => console.log(r.text, r.format)
</script>

<template>
  <div style="width: 100%; aspect-ratio: 3 / 4">
    <BarcodeScanner :formats="['qr_code']" :wasm-url="wasmUrl" @decoded="onDecoded">
      <template #hint="{ hint }">{{ { align: '對準框內', 'move-closer': '靠近一點', 'hold-steady': '拿穩' }[hint] }}</template>
      <template #error="{ error, retry }"><button @click="retry">{{ error.code }}，重試</button></template>
    </BarcodeScanner>
  </div>
</template>
```

- `<BarcodeScanner>` 會填滿父容器，父容器要給尺寸。
- 只掃一維條碼：`:formats="LINEAR_FORMATS"`（從 `@cclemon/scanner-vue` import）。
- 自己排版：用 `useBarcodeScanner()`，見 README。

## 4. 部署要注意

- **HTTPS**（相機的硬性條件）。
- nginx 的 mime.types 要有 `application/wasm wasm;`（舊版沒有）。
- 不能有 `Permissions-Policy: camera=()`。
- Rocky/RHEL 上 scp 的檔案要 `restorecon`。

細節：`docs/deploy.md`。

## 5. 升級

**要指名版本**。0.x 階段 `^0.1.4` 這種範圍不會跨 minor，`npm install` / `npm update` 都拿不到 0.2.0：

```bash
npm i @cclemon/scanner-core@0.2.0          # pnpm add / yarn add 同理
npm ls @cclemon/scanner-core               # 只能有一份，vue / ui 底下顯示 deduped
```

然後 **一定要讓 Vite 重新預打包**，否則 dev server 會繼續跑 `node_modules/.vite/deps/` 裡的舊版
（畫面上印的版本號來自 package.json，不代表瀏覽器真正在跑的程式碼——2026-09-22 就這樣踩過一次）：

```bash
npx vite --force        # 或刪掉 node_modules/.vite 再 npm run dev
```

production build（`vite build`）不吃這份快取，不受影響。commit `package.json` + lockfile 後，其他人 `git pull && npm install` 就會拿到同一版。

## 沒有外網的專案（備援）

GitHub Releases 附 `.tgz`：https://github.com/Peter-1119/WebCamCall/releases
放進專案 `vendor/`，`package.json` 用 `"@cclemon/scanner-core": "file:./vendor/cclemon-scanner-core-0.1.2.tgz"`。
