import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      '@shopee/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@shopee/persistence': fileURLToPath(
        new URL('./packages/persistence/src/index.ts', import.meta.url),
      ),
      '@shopee/gateway': fileURLToPath(new URL('./packages/shopee/src/index.ts', import.meta.url)),
      '@shopee/agent-runtime': fileURLToPath(
        new URL('./packages/agent-runtime/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
