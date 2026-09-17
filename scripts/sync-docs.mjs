// 把 docs/ 的文件同步進各套件，讓 npm tarball 帶著走（npm 會自動收 README.md 並顯示在套件頁）。
// docs/GUIDE.md 是唯一來源；不要直接改 packages/*/README.md。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const guide = readFileSync(resolve(root, 'docs/GUIDE.md'), 'utf8')
const quick = readFileSync(resolve(root, 'docs/QUICKSTART.md'), 'utf8')

const banner = (pkg) => `<!-- 此檔由 scripts/sync-docs.mjs 從 docs/ 產生，請改 docs/ 再重跑 build -->\n\n`

writeFileSync(resolve(root, 'packages/core/README.md'), banner('core') + guide)
writeFileSync(
  resolve(root, 'packages/vue/README.md'),
  banner('vue') +
    `# @cclemon/scanner-vue\n\n\`useBarcodeScanner()\` composable（Vue 3）。完整手冊在 \`@cclemon/scanner-core\` 的 README（同一份 GUIDE.md）。\n\n` +
    quick,
)
writeFileSync(
  resolve(root, 'packages/ui/README.md'),
  banner('ui') +
    `# @cclemon/scanner-ui\n\n\`<BarcodeScanner>\` 全包元件與 \`<ScannerOverlay>\`（零文案）。完整手冊在 \`@cclemon/scanner-core\` 的 README（同一份 GUIDE.md）。\n\n` +
    quick,
)
console.log('synced docs → packages/*/README.md')
