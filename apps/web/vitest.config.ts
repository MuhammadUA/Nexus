import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Web-app tests.
 *
 * The app's server modules use the `@/` path alias, which the bundler resolves
 * through `tsconfig.json`'s `paths` but a plain test runner does not. Mirroring it
 * here is what lets the tests import the real modules instead of a copy.
 *
 * `server-only` is a marker package that throws outside a React Server Component
 * graph; it is aliased to an empty module so the same code is testable.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'test/stubs/server-only.ts'),
    },
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 240_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    reporters: ['default'],
  },
});
