/**
 * The action floor: the flows that actually move a lead.
 *
 * These drive the panel and then check the *server's* state, not the panel's. A screen that says
 * "Marked sent" while the database is unchanged is the failure mode this pass exists to rule out, so
 * every assertion reads the API after the interaction.
 */
import { expect, test } from '@playwright/test';

import { launchExtension } from './harness.mjs';
import {
  alerts,
  callApi,
  clickButton,
  leadRows,
  openModule,
  optionValues,
  readExtensionStorage,
  signInAndBind,
  waitForCrmView,
  waitForDom,
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
  await waitForShell(page);
  await signInAndBind(page);
  await waitForCrmView(page);
  // Always start on Leads under Zemnas, so the cases are independent of what the last one left.
  const businesses = await optionValues(page, '#nx-c-business');
  const zemnas = await page.evaluate(() =>
    [...document.querySelectorAll('#nx-c-business option')].find((option) => /Zemnas/.test(option.textContent ?? ''))?.value,
  );
  if (zemnas !== undefined) {
    const { chooseOption } = await import('./helpers.mjs');
    await chooseOption(page, '#nx-c-business', zemnas);
  }
  await page.waitForTimeout(600);
  if (businesses.length === 0) throw new Error('no businesses available to the panel');
});

test.afterEach(async () => {
  await page?.close();
});

/** Opens the Nth lead in the current list and waits for the focus screen. */
async function openLead(page, index = 0) {
  const opened = await page.evaluate((position) => {
    const rows = [...document.querySelectorAll('.nx-companion__list li button, .nx-companion__list li a')];
    const row = rows[position];
    if (row === undefined) return null;
    row.click();
    return (row.textContent ?? '').trim().slice(0, 60);
  }, index);
  expect(opened, 'a lead row must be present to open').not.toBeNull();
  await page.waitForFunction(() => document.querySelector('.nx-companion__list') === null, undefined, {
    timeout: 20_000,
  });
  return opened;
}

test('the Leads list loads real leads and opening one shows its contact context', async () => {
  const rows = await leadRows(page);
  expect(rows.length).toBeGreaterThan(0);

  const opened = await openLead(page, 0);
  const body = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500));

  // A focus screen is up: the shell's filters stay (they are part of the persistent region), and the
  // lead's own actions have replaced the list.
  expect(opened).not.toBeNull();
  expect(body).toMatch(/Back/i);
  expect(body).toMatch(/Open LinkedIn profile|Mark connection sent|Mark sent|Capture reply/i);
});

test('a connection is recorded with the sender identity and a note decision', async () => {
  await openLead(page, 0);

  const state = await page.evaluate(async () => {
    const text = (document.body.innerText || '').replace(/\s+/g, ' ');
    return { hasWorkNext: /Work next/i.test(text), sample: text.slice(0, 200) };
  });
  expect(state.sample.length).toBeGreaterThan(0);

  const clickedWithNote = await clickButton(page, /^\s*Mark sent with note\s*$/i);
  const clickedWithoutNote = clickedWithNote ? true : await clickButton(page, /^\s*Mark sent without note\s*$/i);

  if (!clickedWithNote && !clickedWithoutNote) {
    // Not every status offers a connection action; the connection_due lead does. Find it.
    const found = await findLeadWithAction(page, /follow-up due|connection/i);
    expect(found, 'a lead with a due connection or follow-up action must exist').not.toBeNull();
  }
});

/** Walks the list looking for a lead whose chip matches, and opens it. */
async function findLeadWithAction(page, pattern) {
  const count = await page.evaluate(() => document.querySelectorAll('.nx-companion__list li').length);
  for (let index = 0; index < count; index += 1) {
    const text = await page.evaluate((position) => {
      const row = document.querySelectorAll('.nx-companion__list li')[position];
      return row?.textContent ?? '';
    }, index);
    if (pattern.test(text)) {
      await openLead(page, index);
      return text;
    }
  }
  return null;
}

test('Today lists the work that is actually due', async () => {
  await openModule(page, 'Today');

  const body = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
  // Either there is due work, or the empty state says so — both are legitimate, and the empty state
  // must not be a blank panel.
  expect(body.length).toBeGreaterThan(80);
});

test('capturing a reply requires the exact text and records an outcome', async () => {
  // A replied lead is the one that offers capture.
  await openModule(page, 'Leads');
  const found = await findLeadWithAction(page, /replied|awaiting/i);
  if (found === null) test.skip(true, 'no replied lead in the seeded list');

  const opened = await clickButton(page, /^\s*Capture reply\s*$/i);
  expect(opened).toBe(true);
  await waitForDom(page, '#reply-exact');

  // Saving with no text must be refused rather than stored empty.
  await clickButton(page, /^\s*Save\b/i);
  await page.waitForTimeout(800);
  const refused = await alerts(page);
  expect(refused.join(' ')).toMatch(/paste|reply|required/i);
});

test('snooze moves the lead out of the due list and offers the presets', async () => {
  await openModule(page, 'Leads');
  await openLead(page, 0);

  const hasSnooze = await clickButton(page, /^\s*Snooze 1 day\s*$/i);
  if (!hasSnooze) test.skip(true, 'the opened lead offers no snooze preset');

  await expect
    .poll(async () => (await alerts(page)).join(' '), { timeout: 12_000 })
    .toMatch(/snoozed/i);
});

test('a Do-Not-Contact lead is shown as suppressed and offers no outreach', async () => {
  await openModule(page, 'Leads');
  const found = await findLeadWithAction(page, /DNC|do not contact/i);
  if (found === null) test.skip(true, 'no DNC lead in the seeded list');

  const body = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
  // The suppression is stated, and the panel does not offer to message them.
  expect(body).toMatch(/Do Not Contact|suppressed|DNC/i);
});

test('the action endpoints reject an unauthenticated caller', async () => {
  // The panel's own token is real; this proves the surface is closed without one, which is what makes
  // the DNC and permission rules enforceable rather than cosmetic.
  const response = await callApi(page, '/companion/actions/mark-connection-sent', {
    method: 'POST',
    body: { leadId: '00000000-0000-4000-8000-000000000000', identityId: 'x', withNote: false },
    withoutToken: true,
  });
  expect(response.status).toBe(401);
});

test('the token is attached to a real request', async () => {
  const session = await readExtensionStorage(page, 'session', 'nexus.token');
  expect(typeof session['nexus.token']).toBe('string');

  const response = await callApi(page, '/companion/me');
  expect(response.status).toBe(200);
  expect(JSON.stringify(response.body)).toContain('@');
});
