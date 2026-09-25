/**
 * Playwright configuration for the Companion extension E2E suite.
 *
 * Deliberately separate from Vitest. Vitest covers the policy and the repository against a real
 * PostgreSQL engine; this covers the *loaded extension* talking to a running Nexus. The split is
 * the point: a mocked `chrome.*` surface can prove a React component renders, but it cannot prove
 * that Chrome loads the manifest, that the side panel document has a real `chrome.storage.session`,
 * or that `chrome.tabs.update` navigates the tab a person is looking at.
 *
 * Not headless. Chromium's headless shell does not load extensions, so a headless run would either
 * fail outright or quietly test a page with no `chrome.*` at all.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  // Extension state (chrome.storage, the service worker, the binding) is process-wide, so specs run
  // one at a time. Parallel workers would share a browser profile and invalidate each other.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    // The panel's reference size. Chrome owns the real side-panel dimensions, and the panel is
    // designed to exactly this box.
    viewport: { width: 420, height: 820 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
