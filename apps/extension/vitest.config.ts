/**
 * Vitest configuration for the extension's unit tests.
 *
 * The E2E specs live in `e2e/` and are Playwright's, not Vitest's: they need a loaded extension and a
 * running Nexus, and Vitest would try to import `@playwright/test` as a test file and fail the whole
 * run. The two suites are invoked separately — `pnpm test` for the unit tests, `pnpm e2e` for the
 * extension E2E — so each keeps its own runner.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'dist/**', 'node_modules/**'],
  },
});
