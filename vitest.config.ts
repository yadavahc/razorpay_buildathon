import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Test configuration.
 *
 * The core package is aliased to its TypeScript source rather than a build artifact, so
 * tests run against exactly the code the application runs — no build step in between and
 * no chance of testing a stale bundle.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@reclaim/core/presentation': resolve(__dirname, 'packages/core/src/presentation.ts'),
      '@reclaim/core/node': resolve(__dirname, 'packages/core/src/node/index.ts'),
      '@reclaim/core/seed': resolve(__dirname, 'packages/core/src/seed/index.ts'),
      '@reclaim/core/ml': resolve(__dirname, 'packages/core/src/ml/index.ts'),
      '@reclaim/core': resolve(__dirname, 'packages/core/src/index.ts'),
    },
    // The core package uses NodeNext resolution, so its internal imports carry explicit
    // `.js` extensions. Vite needs to know those may resolve to `.ts` files.
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/**/index.ts', 'packages/core/src/seed/catalog.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
