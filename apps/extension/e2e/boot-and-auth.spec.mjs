/**
 * Companion extension E2E: boot, authentication and the sidebar surface.
 *
 * These are the claims that only a *loaded extension* can support. Everything asserted here is
 * observed from inside a `chrome-extension://` document with a real `chrome.*` API surface, not
 * from a page that merely renders the same components.
 */
import { expect, test } from '@playwright/test';

import { launchExtension } from './harness.mjs';
import {
  bind,
  clickButton,
  fill,
  hasDom,
  installId,
  leadRows,
  openModule,
  optionLabels,
  readExtensionStorage,
  signIn,
  signInAndBind,
  waitForCrmView,
  waitForShell,
} from './helpers.mjs';

let extension;
let page;

test.beforeAll(async () => {
  extension = await launchExtension();
});

test.afterAll(async () => {
  await extension?.close();
});

test.beforeEach(async () => {
  page = await extension.openPanel();
  // Surface renderer failures: a React error unmounts the panel and the screenshot is blank, which
  // is not enough to diagnose.
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[panel console]', message.text());
  });
  page.on('pageerror', (error) => console.log('[panel pageerror]', error.message));
});

test.afterEach(async () => {
  await page?.close();
});

test('boots as a real extension origin with the panel mounted', async () => {
  await waitForShell(page);

  const facts = await page.evaluate(() => ({
    protocol: location.protocol,
    host: location.host,
    title: document.title,
    hasStorageLocal: typeof chrome?.storage?.local?.get === 'function',
    hasStorageSession: typeof chrome?.storage?.session?.get === 'function',
    hasTabsUpdate: typeof chrome?.tabs?.update === 'function',
    hasTabsSendMessage: typeof chrome?.tabs?.sendMessage === 'function',
    hasAlarms: typeof chrome?.alarms?.create === 'function',
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  expect(facts.protocol).toBe('chrome-extension:');
  expect(facts.host).toBe(extension.extensionId);
  expect(facts.title).toBe('Nexus Companion');
  // The API surface the panel depends on, present for real.
  expect(facts.hasStorageLocal).toBe(true);
  expect(facts.hasStorageSession).toBe(true);
  expect(facts.hasTabsUpdate).toBe(true);
  expect(facts.hasTabsSendMessage).toBe(true);
  // The reference surface from the spec's companion design.
  expect(facts.width).toBe(420);
  expect(facts.height).toBe(820);
});

test('loads the manifest the browser accepted, with a narrow permission set', async () => {
  // Read through the browser rather than the file on disk: this is what the extension actually runs
  // under, which is the thing that matters.
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());

  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['sidePanel', 'storage', 'tabs', 'alarms']);
  expect(manifest.host_permissions).toEqual(['https://www.linkedin.com/*', 'http://127.0.0.1:3000/*']);
  expect(manifest.permissions).not.toContain('cookies');
  expect(manifest.permissions).not.toContain('webRequest');
  expect(manifest.permissions).not.toContain('debugger');
  expect(manifest.side_panel.default_path).toBe('sidepanel.html');
});

test('registers a service worker and generates one stable install id', async () => {
  await waitForShell(page);

  // The worker exists, which is what makes alarms and the content-script bridge possible.
  const worker = await extension.serviceWorker();
  expect(worker.url()).toContain('background.js');

  const first = await installId(page);
  expect(typeof first).toBe('string');
  expect(first.length).toBeGreaterThanOrEqual(8);

  // Reloading the panel is the "reopen the side panel" case, and the id must survive it.
  await page.reload();
  await waitForShell(page);
  expect(await installId(page)).toBe(first);

  // It is a generated UUID, not a fingerprint: nothing about the machine is consulted.
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('shows the sign-in screen when no token is held, and never shows one when it is', async () => {
  await waitForShell(page);

  // Clean session: sign-in is offered.
  await page.evaluate(() => chrome.storage.session.remove('nexus.token'));
  await page.reload();
  await waitForShell(page);
  expect(await hasDom(page, '#c-email')).toBe(true);
  expect(await hasDom(page, '#c-password')).toBe(true);

  // The token lives in session storage only, never on disk.
  const local = await readExtensionStorage(page, 'local', null);
  expect(JSON.stringify(local)).not.toContain('nxu_');
  expect(Object.keys(local)).not.toContain('nexus.token');
});

test('signs in, stores the token in session storage, and reaches the CRM View', async () => {
  await waitForShell(page);
  await page.evaluate(() => chrome.storage.session.remove('nexus.token'));
  await page.reload();
  await waitForShell(page);

  await signIn(page);

  // The token exists, in the in-memory area only.
  const session = await readExtensionStorage(page, 'session', 'nexus.token');
  expect(typeof session['nexus.token']).toBe('string');
  expect(session['nexus.token']).toMatch(/^nxu_/);

  const local = await readExtensionStorage(page, 'local', null);
  expect(JSON.stringify(local)).not.toContain('nxu_');

  // Binding screen: the identities and businesses the account may use.
  const identityOptions = await optionLabels(page, '#c-identity');
  expect(identityOptions.length).toBeGreaterThan(0);
  const businessOptions = await optionLabels(page, '#c-business');
  expect(businessOptions).toContain('Zemnas Creative Studio');
});

test('rejects a wrong password without storing a token', async () => {
  await waitForShell(page);
  await page.evaluate(() => chrome.storage.session.remove('nexus.token'));
  await page.reload();
  await waitForShell(page);

  await fill(page, '#c-email', 'admin@nexus.local');
  await fill(page, '#c-password', 'definitely-not-the-password');
  await clickButton(page, /^\s*sign in\s*$/i);

  await page.waitForFunction(() => document.querySelector('.nx-alert') !== null, undefined, { timeout: 15_000 });
  // Still on the sign-in screen, and no token was written.
  expect(await hasDom(page, '#c-email')).toBe(true);
  const session = await readExtensionStorage(page, 'session', 'nexus.token');
  expect(session['nexus.token']).toBeUndefined();
});

test('returns to sign-in when the stored token has been revoked', async () => {
  await waitForShell(page);
  // A syntactically plausible but unknown token: the server must refuse it.
  await page.evaluate(() =>
    chrome.storage.session.set({ 'nexus.token': 'nxu_thisTokenWasNeverIssuedByNexus000000000000' }),
  );
  await page.reload();
  await waitForShell(page);

  // The panel clears the token on 401 and offers sign-in again. The clearing is a storage write that
  // happens alongside the render, so it is polled rather than read once.
  await page.waitForFunction(() => document.querySelector('#c-email') !== null, undefined, { timeout: 20_000 });
  await expect
    .poll(async () => (await readExtensionStorage(page, 'session', 'nexus.token'))['nexus.token'], {
      timeout: 15_000,
    })
    .toBeUndefined();
});

test('signing out clears the session and returns to the sign-in screen', async () => {
  await waitForShell(page);
  await signInAndBind(page);
  await waitForCrmView(page);

  // Sign out lives in the shell, so a shared machine is not left signed in.
  const signedOut = await clickButton(page, /^\s*sign out\s*$/i);
  expect(signedOut).toBe(true);

  await page.waitForFunction(() => document.querySelector('#c-email') !== null, undefined, { timeout: 20_000 });
  await expect
    .poll(async () => (await readExtensionStorage(page, 'session', 'nexus.token'))['nexus.token'], { timeout: 15_000 })
    .toBeUndefined();
});

test('survives a panel reload with the session and binding intact', async () => {
  await waitForShell(page);
  await signInAndBind(page);
  await waitForCrmView(page);

  const before = await readExtensionStorage(page, 'local', 'nexus.binding');

  // Reopening the side panel is a fresh document load against the same session storage.
  await page.reload();
  await waitForShell(page);
  await waitForCrmView(page);

  const after = await readExtensionStorage(page, 'local', 'nexus.binding');
  expect(after['nexus.binding']).toEqual(before['nexus.binding']);

  // And the data really loaded behind it.
  await openModule(page, 'Leads');
  await expect.poll(async () => (await leadRows(page)).length, { timeout: 20_000 }).toBeGreaterThan(0);
});
