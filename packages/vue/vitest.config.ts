import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'vue', environment: 'happy-dom', include: ['src/**/*.test.ts'] },
})
