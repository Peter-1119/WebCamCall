#!/usr/bin/env bash
# 發布後驗證：比對 registry 上的 tarball shasum 與本機 release/ 的是否一致。
# npm publish 的訊息很會誤導（成功印 404、舊版本已存在才說 403），只有這個檢查準。
cd "$(dirname "$0")/.."
for f in release/cclemon-scanner-*.tgz; do
  name=$(tar -xzf "$f" -O package/package.json | python -c "import json,sys; d=json.load(sys.stdin); print(d['name']+'@'+d['version'])")
  reg=$(npm view "$name" dist.shasum 2>/dev/null | tail -1)
  loc=$(sha1sum "$f" | cut -c1-40)
  if [ -z "$reg" ]; then echo "✗ $name  not on registry"; elif [ "$reg" = "$loc" ]; then echo "✓ $name  registry matches local"; else echo "✗ $name  registry has a DIFFERENT build (registry $reg, local $loc) → bump version and republish"; fi
done
