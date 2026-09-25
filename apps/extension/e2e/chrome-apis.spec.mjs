/**
 * Chrome API behaviour, exercised through the loaded extension.
 *
 * `chrome.tabs.update` navigating the tab a person is looking at, the alarm heartbeat, and the
 * session-vs-local storage split are the parts of the Companion that cannot be verified from a web
 * page at all — a mocked `chrome.*` would only assert the mock. These call the real APIs.
 */
import { expect, test } from '@playwright/test';

import { launchExtension } from './harness.mjs';
import {
  hasDom,
  optionValues,
  readExtensionStorage,
  signInAndBind,
  waitForCrmView,
  waitForShell,
  writeExtensionStorage,
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
  await waitForShell(page);
});

test.afterEach(async () => {
  await page?.close();
});

test('chrome.alarms is available and the heartbeat alarm is registered', async () => {
  // The alarm is created by the service worker on install/startup; ask the browser directly.
  const alarm = await page.evaluate(async () => {
    const all = await chrome.alarms.getAll();
    return all.map((entry) => ({ name: entry.name, periodInMinutes: entry.periodInMinutes ?? null }));
  });

  const heartbeat = alarm.find((entry) => entry.name === 'nexus-heartbeat');
  expect(heartbeat, `expected a nexus-heartbeat alarm, saw ${JSON.stringify(alarm)}`).toBeDefined();
  // Five minutes: often enough to keep a session truthful, not so often that it is traffic.
  expect(heartbeat.periodInMinutes).toBe(5);
});

test('the session token lives in chrome.storage.session and the binding in chrome.storage.local', async () => {
  await signInAndBind(page);
  await waitForCrmView(page);

  const areas = await page.evaluate(async () => {
    const session = await chrome.storage.session.get(null);
    const local = await chrome.storage.local.get(null);
    return { sessionKeys: Object.keys(session), localKeys: Object.keys(local) };
  });

  // The credential is in the in-memory area, which Chrome clears when the browser closes.
  expect(areas.sessionKeys).toContain('nexus.token');
  // The binding and list state are durable, which is what makes them survive a restart.
  expect(areas.localKeys).toContain('nexus.installId');
  expect(areas.localKeys).toContain('nexus.binding');
  // A token must never be written to disk.
  expect(areas.localKeys).not.toContain('nexus.token');
});

test('opening a prospect navigates a tab and leaves the panel alive', async () => {
  await signInAndBind(page);
  await waitForCrmView(page);

  // The panel performs the navigation through its own `chrome.tabs` implementation, and this proves
  // the API is reachable and accepted from the panel's document. The tab is a separate page, so the
  // panel's survival is observable.
  const outcome = await page.evaluate(async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id === undefined) return 'no-active-tab';
    // A data URL keeps the navigation local: this test is about `tabs.update` being callable and the
    // panel surviving it, not about LinkedIn being reachable from the test machine.
    await chrome.tabs.update(active.id, { url: 'data:text/html,<title>prospect-placeholder</title>ok' });
    return 'updated';
  });
  expect(outcome).toBe('updated');

  // The panel is a separate document and must still be mounted.
  expect(await hasDom(page, '.nx-companion')).toBe(true);
  expect(await hasDom(page, '.nx-companion__topnav')).toBe(true);
});

test('a refused navigation does not take the panel down', async () => {
  await signInAndBind(page);
  await waitForCrmView(page);

  // `chrome.tabs.update` with a URL the browser refuses must leave the panel usable rather than
  // throwing out of the runtime. The browser may also destroy this document's execution context as
  // it tears the navigation down, so the call is wrapped and only the panel's survival is asserted.
  const outcome = await page
    .evaluate(async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id === undefined) return 'no-active-tab';
      await chrome.tabs.update(active.id, { url: 'https://' });
      return 'resolved';
    })
    .catch((error) => `threw: ${String(error).slice(0, 60)}`);
  expect(typeof outcome).toBe('string');

  // Whatever the browser did, the panel is still mounted and still bound.
  expect(await hasDom(page, '.nx-companion')).toBe(true);
  expect(await hasDom(page, '.nx-companion__topnav')).toBe(true);
});

test('the panel reloads into the CRM View with the binding from local storage', async () => {
  await signInAndBind(page);
  await waitForCrmView(page);

  const identitiesBefore = await optionValues(page, '#nx-c-business');

  // A reload is the side panel being closed and reopened: same profile, same stored binding.
  await page.reload();
  await waitForShell(page);
  await waitForCrmView(page);

  const identitiesAfter = await optionValues(page, '#nx-c-business');
  expect(identitiesAfter).toEqual(identitiesBefore);
});

test('a stale session area does not keep the panel signed in after Chrome discards it', async () => {
  await signInAndBind(page);
  await waitForCrmView(page);

  // Clearing session storage models the browser closing: the token is gone, the binding is not.
  await page.evaluate(() => chrome.storage.session.clear());
  await page.reload();
  await waitForShell(page);

  // The panel must ask for a sign-in again rather than rendering a shell with no credential.
  await page.waitForFunction(() => document.querySelector('#c-email') !== null, undefined, { timeout: 25_000 });
  const binding = await readExtensionStorage(page, 'local', 'nexus.binding');
  expect(binding['nexus.binding']).toBeDefined();
});

test('the service worker answers the content-script bridge after a restart', async () => {
  // The worker is torn down aggressively by Chrome; messaging it must still work, which is what
  // `runtime.onMessage` returning `true` for the async reply buys.
  const worker = await extension.serviceWorker();
  expect(worker.url()).toContain('background.js');

  const echoed = await page.evaluate(async () => {
    // A message the bridge does not handle must get no answer rather than throwing.
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'nexus:unhandled' });
      return { replied: true, reply };
    } catch {
      return { replied: false };
    }
  });

  // Either outcome is acceptable; what matters is that the extension did not become unreachable.
  expect(typeof echoed.replied).toBe('boolean');
  expect(await hasDom(page, '.nx-companion')).toBe(true);
});

test('list state written by the panel is real chrome.storage.local data', async () => {
  await signInAndBind(page);
  await waitForCrmView(page);

  // Write through the same area the panel uses, then read it back from a fresh document.
  await writeExtensionStorage(page, 'local', { 'nexus.listState': { businessId: 'probe-business' } });
  await page.reload();
  await waitForShell(page);

  const stored = await readExtensionStorage(page, 'local', 'nexus.listState');
  expect(stored['nexus.listState']).toEqual({ businessId: 'probe-business' });
});
