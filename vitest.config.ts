import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 每個 package 自己的 vitest.config.ts 決定環境（core 用 happy-dom）
    projects: ['packages/*'],
    passWithNoTests: true,
  },
})
