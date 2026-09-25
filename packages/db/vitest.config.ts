import { defineConfig } from 'vitest/config';

/**
 * PGlite boots a WASM Postgres and the migration set is applied per test file,
 * so timeouts are generous and files run one at a time (each file owns its own
 * database instance).
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 180_000,
    teardownTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    reporters: ['default'],
  },
});
