import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  treeshake: true,
  // vue 是 peerDependency，不可打進 bundle；core 也留給 App 端 bundler 去 dedupe
  external: ['vue', '@scanner/core'],
})
