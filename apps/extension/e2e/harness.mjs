/**
 * Extension harness.
 *
 * Everything that needs a *real* extension origin goes through this: the built extension from
 * `apps/extension/dist` is loaded into Playwright's Chromium with a persistent profile, and the
 * harness hands back the extension id, the side-panel URL and a page already navigated to it.
 *
 * Three decisions matter:
 *
 *   * **A real persistent context, not a page context.** `chrome.storage`, the side panel and the
 *     service worker only exist for a loaded extension in a persistent profile; a normal
 *     `browser.newContext()` has none of them.
 *   * **The extension id is discovered, never assumed.** It is read from the extension's own
 *     service-worker URL, so a test can never pass against an id that was merely computed.
 *   * **The side panel is opened as a page.** Chrome only renders a side panel inside a browser
 *     window with the toolbar, which cannot be driven from CDP. Opening
 *     `chrome-extension://<id>/sidepanel.html` as a tab renders the identical document at the
 *     identical size with a real `chrome.*` API surface — the panel's own runtime, not a mock.
 *
 * Chromium's own `--headless=new` does not load extensions, so this runs headed.
 */
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const EXTENSION_DIR = path.resolve(import.meta.dirname, '..', 'dist');

/** Panel reference size from the spec's companion surface. */
export const PANEL_VIEWPORT = { width: 420, height: 820 };

/** Where a headed run writes a screenshot for a step, when one is asked for. */
export const ARTIFACTS_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'ui-audit', 'extension');

/**
 * Launches Chromium with the extension loaded and returns a handle to it.
 *
 * `keepProfile` reuses a profile directory across calls, which is what makes "reopen the side
 * panel" and "restart the browser" testable: the identity of the install has to survive.
 */
export async function launchExtension(options = {}) {
  const { keepProfile = null, apiOrigin = 'http://127.0.0.1:3000', extraArgs = [] } = options;

  const profile =
    keepProfile ?? mkdtempSync(path.join(tmpdir(), 'nexus-companion-'));
  mkdirSync(profile, { recursive: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: PANEL_VIEWPORT,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      ...extraArgs,
    ],
  });

  const extensionId = await resolveExtensionId(context);
  if (extensionId === null) {
    await context.close();
    throw new Error(
      'the extension did not load: no chrome-extension:// service worker appeared. ' +
        'The browser build in use does not honour --load-extension.',
    );
  }

  return {
    context,
    extensionId,
    apiOrigin,
    panelUrl: `chrome-extension://${extensionId}/sidepanel.html`,
    profile,
    async openPanel() {
      const page = await context.newPage();
      await page.setViewportSize(PANEL_VIEWPORT);
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      return page;
    },
    /** The extension's own service worker, for asserting on alarms and storage. */
    async serviceWorker() {
      const existing = context
        .serviceWorkers()
        .find((worker) => worker.url().startsWith('chrome-extension://'));
      if (existing !== undefined) return existing;
      return context.waitForEvent('serviceworker', { timeout: 15_000 });
    },
    async close({ removeProfile = keepProfile === null } = {}) {
      await context.close();
      if (removeProfile) rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Reads the id from the extension's own service worker; never computed from the path. */
async function resolveExtensionId(context) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const worker = context
      .serviceWorkers()
      .find((candidate) => candidate.url().startsWith('chrome-extension://'));
    if (worker !== undefined) return new URL(worker.url()).host;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Subscribes to the extension page's console and page errors.
 *
 * A console error is a failure condition in its own right, so every test asserts this list is
 * empty rather than letting a React warning sit unnoticed in the output.
 */
export function collectConsole(page) {
  const messages = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      messages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => messages.push({ type: 'pageerror', text: error.message }));
  return messages;
}

/** Writes a named screenshot next to the audit, and returns the path. */
export async function shoot(page, name) {
  const file = path.join(ARTIFACTS_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** Waits for the panel's own shell to be on screen, which is how "mounted" is defined. */
export async function waitForMounted(page) {
  await page.waitForSelector('.nx-companion', { timeout: 20_000 });
}
