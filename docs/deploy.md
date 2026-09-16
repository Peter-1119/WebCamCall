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

舊版 nginx 的 `mime.types` 沒有 wasm。MIME 不對時 Emscripten 會從 `instantiateStreaming` 退回 ArrayBuffer 編譯，
**能跑但慢一點**，所以是加分項不是必要條件。

**正確做法：改全域檔**，所有 location 一起受益：

```bash
# 沒有的話，在 application/zip 那行後面插一行
grep -q wasm /etc/nginx/mime.types || sudo sed -i '/application\/zip/a\    application/wasm                      wasm;' /etc/nginx/mime.types
grep wasm /etc/nginx/mime.types && sudo nginx -t && sudo systemctl reload nginx
```

**陷阱**：`types {}` 放在 location 裡是**整份取代**不是追加。單獨寫 `types { application/wasm wasm; }` 會讓該 location 的
JS/CSS 全部變成 `text/plain`。`deploy/nginx-scanner.conf` 之所以能用，是因為它先 `include /etc/nginx/mime.types;`
再補 `types { ... }`（同一個 block 內的多個 `types` 會累加）——若照它抄，兩行都要。

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

### 7. 版本確認與快取

頁首 `build <git hash> <時間>`。手機看到舊 hash 代表快取，關掉分頁重開或加 `?v=`。

playground 的 `/scanner/` 整個 location 設 `no-store`（測試站，方便）。**正式 App 不要這樣做**——
953 KB 的 wasm 每次都會重載。assets 都帶 hash 可以長快取，只對 `index.html` 關快取：

```nginx
location = /your-app/index.html {
    alias /var/www/your-app/index.html;
    add_header Cache-Control "no-store";
}
```

`/your-app/` 會經 `index` 指令內部轉到 `/your-app/index.html`，正好命中。

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
