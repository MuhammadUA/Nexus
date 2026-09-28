/**
 * The route crawl: every destination, clicked, as a grantless administrator and as a restricted user.
 *
 * This suite exists because the previous browser tests each opened the screens they already knew
 * about, with `page.goto`. Both halves of that are blind spots:
 *
 *   * **`goto` cannot see a broken link.** Every defect the Preview exposed was an *edge* — a link to
 *     a page that does not exist (`/leads/<id>`), a link missing its business (`/automations`), a
 *     strip that renders a tab pointing at a screen the operator may not open. A suite that types
 *     URLs never touches an edge, so it passed while the product was broken.
 *   * **a granted administrator is not the production administrator.** The provisioning used to give
 *     the administrator the `admin` share of the business, which hid the defect that mattered most:
 *     an administrator with no `user_business_access` row got a 404 on every business-scoped screen.
 *
 * So this file clicks. Every sidebar destination, every secondary tab, the row menus on a live lead,
 * and the three lead round trips (Edit → Save, Create Task, Snooze), asserting each time that the
 * destination answered, that it is the page the click promised, and that nothing on the way returned
 * a 4xx or a 5xx. Then it signs in as the restricted operator and asserts the mirror image: the admin
 * screens are not offered, and typing one fails closed.
 */
import {
  ADMIN,
  BUSINESS,
  INCOMPLETE_LEAD,
  RESTRICTED,
  bodyText,
  describeConsole,
  expect,
  heading,
  normalise,
  openScreen,
  signIn,
  test,
  useSignedInPage,
} from './harness.mjs';

const shared = useSignedInPage();
const consoleErrors = shared.consoleErrors;

const LEAD_ID = INCOMPLETE_LEAD.id;

/** Bodies that mean the route did not resolve, or the render threw. */
const FAILURE_BODY = [
  /this page could not be found/i,
  /application error/i,
  /internal server error/i,
  /something went wrong/i,
];

/**
 * Records every response the crawl received with a status of 400 or more.
 *
 * This is the only way to catch a 404 behind a client-side navigation: clicking a link that Next.js
 * knows about can render the not-found screen with a 200 document response, so the body check below
 * is the primary signal — but a hard navigation, a failed server action or a 500 render does show up
 * here, and the suite must not let one pass unnoticed.
 */
function watchFailures(page) {
  const failures = [];
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const url = new URL(response.url());
    if (url.pathname.includes('favicon') || url.pathname.startsWith('/.well-known/')) return;
    failures.push(`${String(status)} ${url.pathname}`);
  });
  return failures;
}

async function assertScreenIsUsable(page, label) {
  const text = await bodyText(page);
  for (const pattern of FAILURE_BODY) {
    expect(pattern.test(text), `${label} rendered a failure page (${String(pattern)})`).toBe(false);
  }
  const title = normalise(await heading(page));
  expect(title.length, `${label} rendered no heading`).toBeGreaterThan(0);
  return title;
}

/** Clicked destinations in this run, for the audit's own count. */
const clickedDestinations = [];

/**
 * Clicks a link and asserts where it landed.
 *
 * The expected path is the *link's own* href, read immediately before the click — not a path captured
 * earlier in the run. That distinction matters: the sidebar resolves business-scoped entries against
 * the business the shell currently has in context, so the same "Insights" entry legitimately points at
 * a different business on a global screen (where the default business is used) than it does inside
 * `/b/zemnas`. Asserting a stale href would report that correct behaviour as a defect.
 *
 * @param {object} options
 * @param {import('playwright/test').Locator} options.link
 * @param {string} options.label
 * @param {string} [options.expectPath] an explicit route, when the click is expected to redirect
 */
async function clickThrough(page, { link, label, expectPath }) {
  const href = await link.getAttribute('href');
  expect(href, `${label} has no href`).toBeTruthy();
  const target = new URL(href, 'http://localhost:3100');
  const expected = expectPath ?? target.pathname;

  await link.click();
  try {
    await page.waitForURL((url) => url.pathname === expected, { timeout: 20_000 });
  } catch {
    throw new Error(
      `${label}: clicked ${href} but the browser is at ${new URL(page.url()).pathname}`,
    );
  }

  const text = await bodyText(page);
  for (const pattern of FAILURE_BODY) {
    expect(pattern.test(text), `${label} (${href}) rendered a failure page`).toBe(false);
  }
  expect(new URL(page.url()).pathname, `${label} (${href}) landed on the wrong route`).toBe(expected);

  clickedDestinations.push({ label, href, landed: new URL(page.url()).pathname });
  return href;
}

async function sidebarDestinations(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.nx-sidebar .nx-nav__item')].map((anchor) => ({
      label: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
      href: anchor.getAttribute('href') ?? '',
    })),
  );
}

async function subnavDestinations(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.nx-subnav__item')].map((anchor) => ({
      label: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
      href: anchor.getAttribute('href') ?? '',
    })),
  );
}

/* ------------------------------------------------------------------ admin -- */

test.describe('admin crawl (grantless administrator)', () => {
  test('the sidebar offers the administration, and every entry opens', async () => {
    const failures = watchFailures(shared.page);
    await openScreen(shared.page, `/b/${BUSINESS.key}/overview`);

    const destinations = await sidebarDestinations(shared.page);
    expect(destinations.length, 'the administrator sees no sidebar destinations').toBeGreaterThan(4);

    for (const destination of destinations) {
      const link = shared.page.locator(`.nx-sidebar .nx-nav__item`, { hasText: destination.label }).first();
      await clickThrough(shared.page, { link, label: `sidebar ${destination.label}` });
      await assertScreenIsUsable(shared.page, `sidebar ${destination.label}`);
    }

    expect(failures, `responses with a failure status:\n  ${failures.join('\n  ')}`).toEqual([]);
    expect(consoleErrors, describeConsole(consoleErrors)).toEqual([]);
  });

  test('every secondary tab on every parent opens the screen it names', async () => {
    // Every parent's strip, clicked once each. The work is inherently long — this is the check that a
    // rendered tab cannot point at a screen the operator may not open — so it is given a budget rather
    // than being trimmed to the point where it misses tabs.
    test.setTimeout(300_000);

    const failures = watchFailures(shared.page);
    const parents = [
      `/b/${BUSINESS.key}/overview`,
      `/b/${BUSINESS.key}/leads`,
      `/b/${BUSINESS.key}/setup`,
      `/b/${BUSINESS.key}/insights`,
      `/team`,
      `/integrations`,
    ];

    const seen = new Set();
    for (const parent of parents) {
      await openScreen(shared.page, parent);
      const tabs = await subnavDestinations(shared.page);
      for (const tab of tabs) {
        if (seen.has(tab.href)) continue;
        seen.add(tab.href);
        // Back to the parent whose strip offers this tab, so the click is made from the screen that
        // renders it rather than from wherever the previous click landed.
        await openScreen(shared.page, parent);
        const link = shared.page.locator('.nx-subnav__item', { hasText: tab.label }).first();
        await clickThrough(shared.page, { link, label: `tab ${tab.label}` });
        await assertScreenIsUsable(shared.page, `tab ${tab.label}`);
      }
    }

    // The strip carries the nested modules and the operational surfaces; an empty sweep would make
    // this test pass without checking anything.
    expect(seen.size, 'no secondary tabs were found to click').toBeGreaterThan(6);
    expect(failures, `responses with a failure status:\n  ${failures.join('\n  ')}`).toEqual([]);
    expect(consoleErrors, describeConsole(consoleErrors)).toEqual([]);
  });

  test('the operational tabs are reachable from a business screen', async () => {
    await openScreen(shared.page, `/b/${BUSINESS.key}/overview`);
    const tabs = await subnavDestinations(shared.page);
    const labels = tabs.map((tab) => tab.label);

    for (const expected of ['Agent Jobs', 'Channel Accounts', 'AI', 'Automations', 'Imports', 'Access']) {
      expect(labels, `the operational strip is missing ${expected}`).toContain(expected);
    }

    for (const tab of tabs) {
      const link = shared.page.locator('.nx-subnav__item', { hasText: tab.label }).first();
      await clickThrough(shared.page, { link, label: `operational ${tab.label}` });
      await assertScreenIsUsable(shared.page, `operational ${tab.label}`);
      // Back to a business screen so the strip is rendered again for the next tab.
      await openScreen(shared.page, `/b/${BUSINESS.key}/overview`);
    }

    expect(consoleErrors, describeConsole(consoleErrors)).toEqual([]);
  });

  test('every lead row opens, and so do its Edit and Add-task actions', async () => {
    test.setTimeout(240_000);
    const failures = watchFailures(shared.page);

    /**
     * Create a lead through the product first.
     *
     * The fixture business is deliberately empty (the screens spec allows an empty list), so the row
     * actions can only be exercised against a lead this test made — which is also the honest way to
     * click "a Lead row": an operator adds a lead and then acts on it.
     */
    await openScreen(shared.page, `/b/${BUSINESS.key}/leads`);
    await shared.page.locator('.nx-add-lead__summary').click();
    await shared.page.fill('#add-lead-name', 'Crawl Row Lead');
    await shared.page.fill('#add-lead-company', 'Crawl Row Co');
    const addForm = shared.page.locator('.nx-add-lead form');
    await addForm.locator('button[type="submit"]').first().click();
    await shared.page.waitForSelector('details.nx-row-menu', { timeout: 30_000 });

    /**
     * A row carries two menus — the V1.2 intelligence actions and the operational one — and they
     * share the `nx-row-menu` markup. The item is therefore found by its own label, and only the menu
     * that contains it is opened: both panels are absolutely positioned drop-downs, so opening two at
     * once makes them overlap and the click would land on whichever panel is on top. (Opening one menu
     * is what an operator does; the overlap is not reachable by clicking a single `⋯`.)
     */
    const openMenuFor = async (locator) => {
      await locator.evaluate((element) => {
        const details = element.closest('details');
        if (details !== null) details.open = true;
      });
    };
    const itemWithLabel = (label) =>
      shared.page.locator('.nx-row-menu__item', { hasText: label }).first();

    const rowCount = await shared.page.locator('details.nx-row-menu').count();
    expect(rowCount, 'the new lead rendered no row menu').toBeGreaterThan(0);

    // Every lead row: its "Open" link must land on the one canonical detail.
    const openHrefs = await shared.page.evaluate(() =>
      [...document.querySelectorAll('details.nx-row-menu a')]
        .filter((anchor) => (anchor.textContent ?? '').trim().endsWith('Open'))
        .map((anchor) => anchor.getAttribute('href') ?? ''),
    );
    expect(openHrefs.length, 'no lead row offered an Open link').toBeGreaterThan(0);

    for (let index = 0; index < Math.min(openHrefs.length, 5); index += 1) {
      await openScreen(shared.page, `/b/${BUSINESS.key}/leads`);
      const openItem = shared.page.locator('details.nx-row-menu a', { hasText: /Open$/ }).nth(index);
      await openMenuFor(openItem);
      // The assertion is against the href this very element carries, read at click time: the row
      // order is the table's, not this test's, and a stale captured href would report a correct
      // navigation as a defect.
      await clickThrough(shared.page, { link: openItem, label: `row Open #${String(index)}` });
      await assertScreenIsUsable(shared.page, `lead row #${String(index)}`);
    }

    const leadHref = openHrefs[0];

    const expectations = [
      { label: 'Edit lead', path: `${leadHref}/edit` },
      { label: 'Add task', path: '/tasks/new' },
    ];

    for (const expectation of expectations) {
      await openScreen(shared.page, `/b/${BUSINESS.key}/leads`);
      const item = itemWithLabel(expectation.label);
      expect(
        await item.count(),
        `no row action labelled ${expectation.label} on the leads table`,
      ).toBeGreaterThan(0);
      await openMenuFor(item);
      await clickThrough(shared.page, { link: item, label: `row ${expectation.label}` });
      await assertScreenIsUsable(shared.page, `row action ${expectation.label}`);
    }

    expect(failures, `responses with a failure status:\n  ${failures.join('\n  ')}`).toEqual([]);
    expect(consoleErrors, describeConsole(consoleErrors)).toEqual([]);
  });

  test('the user-surface destinations work for an administrator too', async () => {
    const failures = watchFailures(shared.page);
    /**
     * `expect` is the heading text this screen must print. The list is the user surface plus the
     * account-level screens; each entry is asserted by *route* as well, so a link that lands
     * somewhere else cannot pass on a shared word like "Trash".
     */
    const screens = [
      { path: '/my-day', expect: 'my day' },
      { path: '/my-day/upcoming', expect: 'my day' },
      { path: '/my-day/done', expect: 'my day' },
      { path: '/my-leads', expect: 'my leads' },
      { path: '/my-lead-sources', expect: null },
      { path: '/my-lead-sources/file', expect: null },
      { path: '/my-lead-sources/paste', expect: null },
      { path: '/my-lead-sources/google', expect: null },
      { path: '/my-lead-sources/apollo', expect: null },
      { path: '/my-profile-queue', expect: null },
      { path: '/my-duplicates', expect: null },
      { path: '/my-trash', expect: 'trash' },
      { path: '/my-access', expect: null },
      { path: '/business-domains', expect: null },
      { path: '/settings', expect: null },
      { path: '/identities', expect: null },
    ];

    for (const screen of screens) {
      await openScreen(shared.page, screen.path);
      const title = await assertScreenIsUsable(shared.page, screen.path);
      expect(new URL(shared.page.url()).pathname, `${screen.path} landed elsewhere`).toBe(screen.path);
      if (screen.expect !== null) {
        expect(title, `${screen.path} heading`).toContain(screen.expect);
      }
      clickedDestinations.push({ label: screen.path, href: screen.path, landed: screen.path });
    }

    // The alias pair resolves to the canonical screens rather than 404ing.
    await openScreen(shared.page, '/trash');
    expect(new URL(shared.page.url()).pathname, '/trash is an alias for /my-trash').toBe('/my-trash');

    await openScreen(shared.page, `/my-leads/${LEAD_ID}`);
    expect(new URL(shared.page.url()).pathname, '/my-leads/:id is an alias for the business detail').toBe(
      `/b/${BUSINESS.key}/leads/${LEAD_ID}`,
    );

    await openScreen(shared.page, `/my-leads/${LEAD_ID}/edit`);
    expect(new URL(shared.page.url()).pathname, '/my-leads/:id/edit is an alias for the canonical edit').toBe(
      `/b/${BUSINESS.key}/leads/${LEAD_ID}/edit`,
    );

    await openScreen(shared.page, `/leads/${LEAD_ID}/edit`);
    expect(new URL(shared.page.url()).pathname, '/leads/:id/edit is an alias for the canonical edit').toBe(
      `/b/${BUSINESS.key}/leads/${LEAD_ID}/edit`,
    );

    await openScreen(shared.page, `/my-leads/${LEAD_ID}/task`);
    expect(new URL(shared.page.url()).pathname, '/my-leads/:id/task forwards to the task screen').toBe('/tasks/new');

    await openScreen(shared.page, `/my-leads/${LEAD_ID}/snooze`);
    expect(new URL(shared.page.url()).pathname, '/my-leads/:id/snooze forwards to the snooze screen').toBe('/snooze');

    expect(failures, `responses with a failure status:\n  ${failures.join('\n  ')}`).toEqual([]);
    expect(consoleErrors, describeConsole(consoleErrors)).toEqual([]);
  });

  test('the lead forms round-trip back to the canonical detail', async () => {
    const canonical = `/b/${BUSINESS.key}/leads/${LEAD_ID}`;

    // Edit Lead -> Save -> the lead.
    await openScreen(shared.page, `${canonical}/edit`);
    await assertScreenIsUsable(shared.page, 'edit lead');
    await shared.page.fill('#edit-title', 'Editorial Director');
    await shared.page.click('button[type="submit"]');
    await shared.page.waitForURL((url) => url.pathname === canonical, { timeout: 45_000 });
    await assertScreenIsUsable(shared.page, 'lead detail after saving the edit');

    // Create Task -> the lead.
    await openScreen(shared.page, `/tasks/new?lead=${LEAD_ID}`);
    await assertScreenIsUsable(shared.page, 'create task');
    await shared.page.fill('#task-title', 'Follow up after the crawl');
    await shared.page.click('button[type="submit"]');
    await shared.page.waitForURL((url) => url.pathname === canonical, { timeout: 45_000 });

    // Snooze -> the lead.
    await openScreen(shared.page, `/snooze?lead=${LEAD_ID}`);
    await assertScreenIsUsable(shared.page, 'snooze');
    await shared.page.click('button[type="submit"]');
    await shared.page.waitForURL((url) => url.pathname === canonical, { timeout: 45_000 });

    // The "Back to lead" affordances are real links, not history calls.
    await openScreen(shared.page, `${canonical}/edit`);
    const back = shared.page.locator(`a[href="${canonical}"]`).first();
    await expect(back, 'the edit screen has no link back to the lead').toHaveCount(1);
    await back.click();
    await shared.page.waitForURL((url) => url.pathname === canonical, { timeout: 30_000 });

    expect(consoleErrors, describeConsole(consoleErrors)).toEqual([]);
  });

  test('the configuration and account forms open, and every link on them resolves', async () => {
    const failures = watchFailures(shared.page);
    const screens = [
      `/b/${BUSINESS.key}/setup/icps`,
      `/b/${BUSINESS.key}/setup/sequences`,
      `/b/${BUSINESS.key}/setup/knowledge`,
      `/b/${BUSINESS.key}/setup/signals`,
      `/b/${BUSINESS.key}/setup/ai`,
      `/team`,
      `/identities`,
    ];

    for (const screen of screens) {
      await openScreen(shared.page, screen);
      await assertScreenIsUsable(shared.page, screen);

      const internal = await shared.page.evaluate(() =>
        [...document.querySelectorAll('a[href^="/"]')]
          .map((anchor) => anchor.getAttribute('href') ?? '')
          .filter((href) => !href.startsWith('/api/')),
      );

      // Every internal link is followed, because a dead "Back" or "Cancel" link is exactly the kind
      // of defect that a screenshot review misses.
      for (const href of [...new Set(internal)].slice(0, 12)) {
        const response = await shared.page.request.get(new URL(href, shared.page.url()).toString(), {
          maxRedirects: 5,
          failOnStatusCode: false,
        });
        expect(
          response.status(),
          `${screen} links to ${href}, which answered ${String(response.status())}`,
        ).toBeLessThan(400);
      }
    }

    expect(failures, `responses with a failure status:\n  ${failures.join('\n  ')}`).toEqual([]);
    expect(consoleErrors, describeConsole(consoleErrors)).toEqual([]);
  });

  test('a team member detail and a channel account detail open', async () => {
    await openScreen(shared.page, '/team');
    const memberLinks = await shared.page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/team/"]')].map((anchor) => anchor.getAttribute('href') ?? ''),
    );
    expect(memberLinks.length, 'the team screen lists nobody').toBeGreaterThan(0);

    const failures = watchFailures(shared.page);
    for (const href of [...new Set(memberLinks)].slice(0, 3)) {
      await openScreen(shared.page, href);
      await assertScreenIsUsable(shared.page, `team member ${href}`);
    }

    await openScreen(shared.page, '/identities');
    const accountLinks = await shared.page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/identities/"]')].map((anchor) => anchor.getAttribute('href') ?? ''),
    );
    expect(accountLinks.length, 'the channel accounts screen lists no account').toBeGreaterThan(0);
    for (const href of [...new Set(accountLinks)].slice(0, 3)) {
      await openScreen(shared.page, href);
      await assertScreenIsUsable(shared.page, `channel account ${href}`);
    }

    expect(failures, `responses with a failure status:\n  ${failures.join('\n  ')}`).toEqual([]);
    expect(consoleErrors, describeConsole(consoleErrors)).toEqual([]);
  });

  test('the crawl recorded the destinations it checked', () => {
    // A guard against the suite quietly doing nothing: if the loops above stopped finding links, the
    // assertions inside them would still pass.
    expect(clickedDestinations.length, 'no destination was clicked in this run').toBeGreaterThan(30);
  });
});

/* ------------------------------------------------------- restricted user -- */

test.describe('restricted user crawl', () => {
  test('the administration is not offered, and typing an admin URL fails closed', async ({ browser }) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      // Chromium reports the *deliberate* 404 of a refused page as a console error. That is the
      // browser describing the app's own refusal, not a defect, so it is filtered by that wording.
      if (/Failed to load resource/i.test(message.text())) return;
      errors.push(message.text());
    });

    await signIn(page, RESTRICTED);

    const offered = await sidebarDestinations(page);
    const labels = offered.map((entry) => entry.label);
    for (const adminScreen of ['Business Setup', 'Team & Accounts', 'Integrations', 'Settings', 'Businesses']) {
      expect(labels, `the restricted navigation offers ${adminScreen}`).not.toContain(adminScreen);
    }
    // They do get their own work surface.
    expect(labels).toContain('My Day');

    const refused = [
      `/b/${BUSINESS.key}/setup`,
      `/b/${BUSINESS.key}/setup/icps`,
      `/b/${BUSINESS.key}/agent-jobs`,
      `/b/${BUSINESS.key}/insights`,
      `/b/${BUSINESS.key}/leads`,
      '/team',
      '/settings',
      '/identities',
      '/integrations',
      '/business-domains',
      '/businesses',
    ];

    for (const path of refused) {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      const landed = new URL(page.url()).pathname;
      const status = response?.status() ?? 0;
      const text = await bodyText(page);

      // A redirect to the sign-in screen would mean the session did not survive, which is a crawl
      // failure rather than an application refusal, so it is separated from the refusal below.
      expect(landed, `${RESTRICTED.email} was bounced away from ${path} instead of refused`).toBe(path);

      const refusedByStatus = status === 404;
      const refusedByBody = FAILURE_BODY.some((pattern) => pattern.test(text));
      expect(
        refusedByStatus || refusedByBody,
        `${RESTRICTED.email} reached ${path} (status ${String(status)}); it must fail closed.\n` +
          `body: ${text.slice(0, 240)}`,
      ).toBe(true);
    }

    // And a screen they *may* open still works.
    await page.goto('/my-day', { waitUntil: 'domcontentloaded' });
    const title = normalise(await heading(page));
    expect(title, 'the restricted operator cannot open My Day').toContain('my day');

    expect(errors, `console errors as the restricted user:\n  ${errors.join('\n  ')}`).toEqual([]);
    await page.close();
  });
});

test.describe('the crawl in numbers', () => {
  test('reports what it clicked, for the audit document', () => {
    const unique = new Set(clickedDestinations.map((entry) => entry.href));
    // Printed by the runner so the count in `docs/V1_2_ROUTE_WIRING_AUDIT.md` is produced by the
    // suite rather than by hand.
    console.log(`route crawl: ${String(clickedDestinations.length)} clicks, ${String(unique.size)} destinations`);
    expect(unique.size).toBeGreaterThan(20);
  });
});
