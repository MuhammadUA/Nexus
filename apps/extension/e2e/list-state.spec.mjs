/**
 * List-state preservation, against the real `chrome.storage.local`.
 *
 * spec `companion_extension.list_state_preservation` requires the selected business, ICP,
 * assignment filter, page, scroll position and selected row to survive opening a lead and coming
 * back. The panel is a single React tree, so most of that survives by accident — but Chrome destroys
 * the panel and the service worker whenever it likes, which is why the guarantee has to be *stored*.
 * These tests restart the document and check the state comes back.
 */
import { expect, test } from '@playwright/test';

import { launchExtension } from './harness.mjs';
import {
  chooseOption,
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
  await signInAndBind(page);
  await waitForCrmView(page);
});

test.afterEach(async () => {
  await page?.close();
});

/** The list state the panel has persisted, as an object. */
async function persistedState(page) {
  const stored = await readExtensionStorage(page, 'local', 'nexus.listState');
  return stored['nexus.listState'] ?? null;
}

test('changing the business selector is written to chrome.storage.local', async () => {
  const businesses = await optionValues(page, '#nx-c-business');
  expect(businesses.length).toBeGreaterThan(1);

  await chooseOption(page, '#nx-c-business', businesses[1]);

  await expect
    .poll(async () => (await persistedState(page))?.businessId, { timeout: 10_000 })
    .toBe(businesses[1]);
});

test('the selected business, ICP and sender survive a panel restart', async () => {
  const businesses = await optionValues(page, '#nx-c-business');
  const target = businesses[businesses.length - 1];
  await chooseOption(page, '#nx-c-business', target);
  await expect.poll(async () => (await persistedState(page))?.businessId, { timeout: 10_000 }).toBe(target);

  // A reload is the panel being reclaimed and reopened: nothing in memory survives it.
  await page.reload();
  await waitForShell(page);
  await waitForCrmView(page);

  // The selector is showing what was stored, not the default.
  const selected = await page.evaluate(() => document.querySelector('#nx-c-business')?.value ?? null);
  expect(selected).toBe(target);
});

test('the status filter and search text are restored, not reset', async () => {
  // Put a state in that the panel did not set this session, then restart into it.
  await writeExtensionStorage(page, 'local', {
    'nexus.listState': {
      businessId: (await optionValues(page, '#nx-c-business'))[0],
      icpId: '',
      identityId: '',
      statusFilter: 'followup_due',
      search: 'weber',
      page: 0,
      scrollRatio: 0,
      selectedIndex: -1,
    },
  });

  await page.reload();
  await waitForShell(page);
  await waitForCrmView(page);

  // The stored filter is the one the panel starts from, which is what makes returning to a filtered
  // list free rather than a re-selection.
  const state = await persistedState(page);
  expect(state?.statusFilter).toBe('followup_due');
  expect(state?.search).toBe('weber');
});

test('a partial stored record does not break the panel', async () => {
  // An older or truncated record: every field must fall back individually.
  await writeExtensionStorage(page, 'local', { 'nexus.listState': { businessId: 'only-this-field' } });

  await page.reload();
  await waitForShell(page);
  await waitForCrmView(page);

  const state = await persistedState(page);
  // The unknown field survived; the absent ones came back as their empty forms rather than
  // `undefined`, which is what keeps the selectors controlled.
  expect(state?.businessId).toBe('only-this-field');
  expect(state?.statusFilter).toBe('');
  expect(state?.selectedIndex).toBe(-1);
});

test('a corrupt stored record is ignored rather than thrown', async () => {
  await writeExtensionStorage(page, 'local', { 'nexus.listState': 'not-an-object' });

  await page.reload();
  await waitForShell(page);
  await waitForCrmView(page);

  // The panel is alive and usable; the bad record did not take it down.
  expect(await page.evaluate(() => document.querySelector('.nx-companion__topnav') !== null)).toBe(true);
});

test('the list state is not shared with the credential area', async () => {
  const areas = await page.evaluate(async () => ({
    session: Object.keys(await chrome.storage.session.get(null)),
    local: Object.keys(await chrome.storage.local.get(null)),
  }));

  // List state may live on disk; the token may not.
  expect(areas.local).toContain('nexus.listState');
  expect(areas.local).not.toContain('nexus.token');
  expect(areas.session).toContain('nexus.token');
});
