# 部署與廠內環境注意事項

## 一句話版

```bash
./scripts/deploy-playground.sh
```

build → scp 到 `kw60user@10.1.5.119:/var/www/scanner` → `sudo restorecon`。
對外網址 `https://sfserver.flexium.com.tw/scanner/`，TLS 由 IT 反向代理終結，VM 的 nginx 只吃 HTTP:3000。

## 必知的坑（每一條都踩過）

### 1. `wasmUrl` 一定要設

zxing-wasm 預設從 jsDelivr CDN 下載 `.wasm`。廠內沒有外網 → `decoder-init-failed`。

```js
createScanner(video, { wasm: { wasmUrl: '/scanner/zxing_reader.wasm' } })
```

檔案來源：`node_modules/zxing-wasm/dist/reader/zxing_reader.wasm`（953 KB）。
playground 的 `scripts/copy-wasm.mjs` 會在 build 前自動複製到 `public/`。

### 2. nginx 要有 `application/wasm` MIME

舊版 nginx 的 `mime.types` 沒有 wasm，瀏覽器會拒絕 streaming compile。`deploy/nginx-scanner.conf` 已補。

### 3. SELinux（Rocky / RHEL）

scp 上去的檔案標籤不對，nginx 讀取 403（`Permission denied`，但 `ls -l` 看起來權限正常）。

```bash
sudo restorecon -Rv /var/www/scanner
```

deploy 腳本已包含；手動上傳時別忘了。

### 4. Windows Git Bash 的路徑轉換

`PLAYGROUND_BASE=/scanner/` 會被 MSYS 轉成 `C:/Program Files/Git/scanner/`。
deploy 腳本已設 `MSYS_NO_PATHCONV=1`；自己跑 build 時要記得：

```bash
MSYS_NO_PATHCONV=1 PLAYGROUND_BASE=/scanner/ pnpm --filter playground build
```

### 5. Permissions-Policy

若上層反代或 nginx 有 `Permissions-Policy: camera=()`，相機會被靜默擋掉（不跳權限詢問、直接 `permission-denied`）。
`deploy/nginx-scanner.conf` 在 location 內覆寫為 `camera=(self)`。

### 6. HTTPS 是硬性條件

`navigator.mediaDevices` 在非安全上下文不存在。`http://localhost` 例外（桌機開發用 `PLAYGROUND_HTTP=1`）。
手機用自簽憑證時，iOS 要求憑證有 SAN，否則連「仍要前往」都不給。

### 7. 版本確認

頁首 `build <git hash> <時間>`。手機看到舊 hash 代表快取，關掉分頁重開或加 `?v=`。
nginx 已對 `/scanner/` 設 `Cache-Control: no-store`。

## nginx 區塊

見 `deploy/nginx-scanner.conf`，貼進 `/etc/nginx/conf.d/main_gateway.conf` 的 `listen 3000` server 區塊。

## 一次性準備（VM）

```bash
sudo mkdir -p /var/www/scanner && sudo chown kw60user:kw60user /var/www/scanner
```

## 免密碼部署（選用）

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
ssh-copy-id kw60user@10.1.5.119
```
