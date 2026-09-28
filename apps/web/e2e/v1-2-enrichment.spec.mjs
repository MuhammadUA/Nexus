/**
 * V1.2 human-assisted enrichment — the workflow, its temporary-raw rule, and the
 * provider-not-configured refusal.
 *
 * This spec is the end-to-end form of three guarantees that only hold together:
 *
 *   1. **The workspace is the deterministic half.** Generated Google queries, a LinkedIn URL field and
 *      an "Enrich with AI" submit — all built in code from stored facts, and none of it a model call.
 *   2. **The paste is temporary.** The textarea is a client-side, one-attempt buffer: it is empty on
 *      load (nothing from the server is ever bound to it), and the raw body it holds is deleted by the
 *      pipeline once a validated structured commit exists. Re-displaying it — from a server render, an
 *      action result or a cached payload — would resurrect evidence the database has already destroyed.
 *   3. **A deployment with no provider key is a supported state, not a failure.** The typed
 *      `provider_not_configured` refusal must render an operator-safe sentence, and must never be a 500,
 *      a stack trace or an upstream error body.
 *
 * **No real model call is made and no API key is set anywhere.** The suite runs against the state every
 * fresh checkout is in, which is exactly the state that exercises guarantee 3.
 *
 * The lead under test is a seeded one deliberately: `Lisa Weber` is `needs_profile` with no committed
 * LinkedIn URL, so the workspace is the *incomplete* state the acceptance document describes. The
 * minimal-lead form is exercised in its own test, so a form that has not landed cannot mask the
 * workspace assertions.
 */
import {
  BUSINESS,
  INCOMPLETE_LEAD,
  bodyText,
  collectConsoleInto,
  controlInventory,
  describeConsole,
  expect,
  fieldValues,
  links,
  normalise,
  openScreen,
  pageHtml,
  signIn,
  test,
} from './harness.mjs';

/** One signed-in page for the file. Signing in is the expensive step and every test navigates anyway. */
let page;

/**
 * The console buffer for the file.
 *
 * Filled by the harness's own collector so this spec and the screens spec cannot drift on what counts as
 * a console error. Cleared before each test because the page — and therefore the buffer — is shared.
 */
const consoleErrors = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  // Attached before the first navigation, so a hydration error on the first screen is caught.
  collectConsoleInto(consoleErrors, page);
  await signIn(page);
});

test.afterAll(async () => {
  await page?.close();
});

test.beforeEach(() => {
  consoleErrors.length = 0;
});

/** The lead detail route for the seeded incomplete lead. */
const LEAD_ROUTE = `/b/${BUSINESS.key}/leads/${INCOMPLETE_LEAD.id}`;

/**
 * A canary that cannot collide with anything the app renders.
 *
 * Deliberately long and unusual: the assertion is "this exact string must not appear anywhere in the
 * rendered document", and a realistic profile body would contain words ("Producer", "Berlin") the screen
 * legitimately prints for other reasons, which would make the test fail on a false positive.
 */
const RAW_CANARY = 'NEXUS-E2E-CANARY-9f4c1b7e-this-text-was-pasted-once-and-must-not-come-back';

/**
 * Puts text into the paste box the way a paste does.
 *
 * The component is controlled and listens on the DOM `input` event, so setting `.value` through the
 * native setter and dispatching that event is what a real paste produces. A bare assignment would leave
 * React's state holding the empty string, the submit button disabled, and the test would be measuring a
 * form that no operator could have driven either.
 */
async function pasteIntoBox(value = RAW_CANARY) {
  await page.evaluate((canary) => {
    const box = document.querySelector('textarea');
    if (box === null) throw new Error('the paste textarea is not on the page');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(box, canary);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/**
 * Waits for the extraction attempt to settle.
 *
 * Two signals are accepted, in either order, because the attempt may succeed or fail:
 *
 *   * the paste box no longer holds what was typed (the success path clears it); or
 *   * a `role="alert"` / `role="status"` region appeared (the refusal path renders one).
 *
 * `waitForLoadState('networkidle')` would be wrong here: the action round trip is a client-side fetch
 * that leaves the document loaded throughout, so the load state never changes and the wait would return
 * immediately, before the response arrived.
 */
async function waitForExtractionOutcome() {
  await page
    .waitForFunction(
      (canary) => {
        const box = document.querySelector('textarea');
        const cleared = box === null || !box.value.includes(canary);
        const announced = document.querySelector('[role="alert"], [role="status"]') !== null;
        return cleared || announced;
      },
      RAW_CANARY,
      { timeout: 60_000 },
    )
    .catch(() => undefined);
}

/** The generated-query panel's own section title, used as the workspace's stable marker. */
const WORKSPACE_TITLE = 'Enrichment workspace';

test.describe('Enrichment workspace', () => {
  test('is present on an incomplete lead, with generated queries, a URL field, a paste box and an Enrich button', async () => {
    await openScreen(page, LEAD_ROUTE);

    /**
     * The stable marker: the workspace's own section title.
     *
     * If the lead screen has not landed yet, `openScreen` throws first with the route and the HTTP
     * status, so this line is only reached on a screen that genuinely rendered.
     */
    await expect(
      page.locator(`text=${WORKSPACE_TITLE}`).first(),
      'the lead detail screen must render the enrichment workspace (spec §31.1 item 4)',
    ).toBeVisible({ timeout: 30_000 });

    const inventory = await controlInventory(page);
    const anchors = await links(page);

    /**
     * The generated Google queries, each with an "Open Google Search" action.
     *
     * Asserted as a pair on the *same element*: a control labelled "Open Google Search" whose `href` is
     * not a Google search URL is not the deterministic affordance the document requires.
     */
    const googleActions = anchors.filter((anchor) => normalise(anchor.label) === 'open google search');
    expect(
      googleActions.length,
      `each generated query must carry an "Open Google Search" action; link labels were ${JSON.stringify(
        anchors.map((anchor) => anchor.label).filter((label) => label.length > 0),
      )}`,
    ).toBeGreaterThan(0);
    for (const action of googleActions) {
      expect(action.href, 'an "Open Google Search" action must open the Google search endpoint').toMatch(
        /^https:\/\/www\.google\.com\/search\?q=/,
      );
    }

    // The visible query text, so "the queries are generated" is asserted and not only the buttons that
    // open them.
    expect(
      /site:linkedin\.com\/in/.test(await pageHtml(page)),
      'the generated queries must be rendered, including the find-LinkedIn query',
    ).toBe(true);

    /**
     * The LinkedIn URL input and the raw-paste textarea.
     *
     * Field ids are read rather than guessed: the component derives them from the lead id
     * (`enrich-url-<id>`, `enrich-paste-<id>`), so matching on the id's meaning keeps the check about the
     * field's role instead of about one exact string.
     */
    const fields = await fieldValues(page);
    expect(
      Object.keys(fields).some((id) => /url/i.test(id)) || inventory.inputs.some((name) => /url|linkedin/i.test(name)),
      `the workspace must offer a LinkedIn URL input; inputs were ${JSON.stringify(inventory.inputs)}`,
    ).toBe(true);
    expect(
      inventory.textareas.length,
      `the workspace must offer a raw-paste textarea; textareas were ${JSON.stringify(inventory.textareas)}`,
    ).toBeGreaterThan(0);

    // The submit control, matched case-insensitively because the button's own casing is not the contract.
    expect(
      inventory.buttons.some((label) => normalise(label) === 'enrich with ai'),
      `the workspace must offer an "Enrich with AI" button; buttons were ${JSON.stringify(inventory.buttons)}`,
    ).toBe(true);

    expect(consoleErrors, `console errors on ${LEAD_ROUTE}:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });

  test('the raw-paste textarea is empty on load', async () => {
    await openScreen(page, LEAD_ROUTE);
    await page.waitForSelector('textarea', { timeout: 30_000 });

    /**
     * Checked on the *rendered HTML*, not only on the live `value`.
     *
     * Both matter, and the HTML one is stronger: an empty live value with a populated `defaultValue` would
     * mean the server sent the text and React merely cleared it, which is exactly the re-display the rule
     * forbids. The regex reads every `<textarea …>…</textarea>` element's content, so a server-rendered
     * paste cannot hide in an element this test did not think to look at.
     */
    const html = await pageHtml(page);
    const textareaContents = [...html.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi)].map(
      (match) => match[1],
    );
    expect(textareaContents.length, 'the workspace must render the paste textarea').toBeGreaterThan(0);
    for (const content of textareaContents) {
      expect(
        content.replace(/&nbsp;/g, ' ').trim(),
        'the raw-paste textarea must be empty on load: nothing from the server may be bound to it',
      ).toBe('');
    }

    // And the live value, which is what an operator sees before typing.
    const live = await page.evaluate(() => [...document.querySelectorAll('textarea')].map((el) => el.value));
    for (const value of live) expect(value, 'the paste box must be empty on load').toBe('');

    expect(consoleErrors, `console errors on ${LEAD_ROUTE}:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });
});

test.describe('Never re-display discarded raw text', () => {
  test('an extract attempt does not echo the pasted text back into the document', async () => {
    await openScreen(page, LEAD_ROUTE);
    await page.waitForSelector('textarea', { timeout: 30_000 });

    await pasteIntoBox();

    const submit = page.locator('button:has-text("Enrich with AI")').first();
    await expect(submit, 'the "Enrich with AI" button must be usable once text is pasted').toBeEnabled({
      timeout: 15_000,
    });
    await submit.click();
    await waitForExtractionOutcome();

    // The URL must not carry the paste. A GET-style echo would survive a bookmark, a log and a share.
    expect(page.url(), 'the pasted text must not be echoed into the URL').not.toContain(RAW_CANARY);

    /**
     * The paste must not be *re-rendered by the server*.
     *
     * Read from the document's HTML rather than from `innerText`, because the textarea still holds the
     * operator's own text in client state — that is the component's documented behaviour on a failure
     * (the staged row survives its retention window, so the paste need not be repeated), and it is not a
     * server echo. What must never happen is the *response* carrying the pasted body back: a
     * `?pastelog=`-style query echo, an action result rendered into an alert, or a textarea whose content
     * the server supplied.
     *
     * The next test is the same guarantee under the strictest condition available — a reload, after which
     * nothing but server output can be on screen.
     */
    const html = await pageHtml(page);

    /**
     * What must not happen is the *server* putting the paste back on screen: a
     * `?pastelog=`-style query echo, an action result rendered into an alert, or a textarea whose
     * content the server supplied. The textarea legitimately still holds the operator's own typing —
     * a controlled textarea's value becomes its child text — so the document as a whole is the wrong
     * test; the server's own output is the right one.
     *
     * The next test is the same guarantee under the strictest condition available — a reload, after
     * which nothing but server output can be on screen.
     */
    const serverPayload = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)]
      .map((match) => match[1])
      .join('\n');
    expect(serverPayload, 'the server payload must not carry the pasted body').not.toContain(RAW_CANARY);

    const renderedAlerts = await page.evaluate(() =>
      [...document.querySelectorAll('.nx-alert, [role="alert"]')].map((el) =>
        (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    );
    expect(
      renderedAlerts.join(' '),
      'a refusal message must never quote the pasted body',
    ).not.toContain(RAW_CANARY);

    expect(consoleErrors, `console errors after a submit attempt:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });

  test('a reload after the attempt shows neither the raw text nor a fabricated result', async () => {
    /**
     * The reload is the strongest available proof of the rule: it removes every client-state trace, so
     * anything on screen afterwards came from the database or from the server's own render. If the
     * pipeline deleted the staged body — which is what it does once the attempt has finished — the text
     * cannot reappear.
     */
    await openScreen(page, LEAD_ROUTE);
    await page.waitForSelector('textarea', { timeout: 30_000 });

    expect(await pageHtml(page), 'the pasted text must not survive a reload').not.toContain(RAW_CANARY);

    const text = await bodyText(page);
    expect(text, 'the pasted text must not appear anywhere on screen after a reload').not.toContain(RAW_CANARY);
    expect(text, 'the reloaded screen must not render a fabricated extraction result').not.toContain('Applied:');

    expect(consoleErrors, `console errors after a reload:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });
});

test.describe('Provider not configured', () => {
  test('the AI settings tab confirms no provider is configured before the refusal is asserted', async () => {
    /**
     * The precondition, asserted rather than assumed.
     *
     * The whole point of the refusal test below is that this deployment has no `DEEPSEEK_API_KEY`, so the
     * suite must know that is true. The server is started with the variable explicitly empty, and the
     * screen that reports provider state is the place the server's own answer is visible — which makes
     * this an assertion about the running server rather than about an environment variable the test
     * process happens to hold.
     */
    await openScreen(page, `/b/${BUSINESS.key}/setup/ai`);
    const text = normalise(await bodyText(page));

    expect(
      /not configured|no provider key|no ai provider key/.test(text),
      `the AI settings tab must report that no provider is configured, so the refusal test below is exercising the unconfigured path; it rendered: ${text.slice(0, 400)}`,
    ).toBe(true);

    expect(consoleErrors, `console errors on the AI tab:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });

  test('a missing API key renders an operator-safe message and never echoes the paste', async () => {
    await openScreen(page, LEAD_ROUTE);
    await page.waitForSelector('textarea', { timeout: 30_000 });

    await pasteIntoBox();

    const submit = page.locator('button:has-text("Enrich with AI")').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();
    await waitForExtractionOutcome();

    const html = await pageHtml(page);
    const text = normalise(await bodyText(page));

    /**
     * An operator-safe message.
     *
     * The typed failure is `provider_not_configured`, whose notice says the deployment has no provider
     * key and that this is a supported state. Either that notice or the screen's own "not configured"
     * wording satisfies this; what is asserted is that *something* names the cause in operator language,
     * because a silent no-op and a 500 both fail here.
     */
    expect(
      /not configured|no provider key|no ai provider key/.test(text),
      'a deployment without a provider key must say so in operator language',
    ).toBe(true);

    /**
     * Nothing raw, nothing internal — asserted against the parts a *server* can put on screen.
     *
     * The textarea legitimately still holds the operator's own typing (the staged row survives its
     * retention window, so the paste need not be repeated), and setting a controlled textarea's value
     * updates its child text, so the whole document is the wrong thing to test: it would fail no matter
     * what the server did. What must never carry the pasted body is the server's own output — the
     * rendered message, the URL, and the React payload the server sent. The reload case, which removes
     * every client-state trace, is asserted separately.
     */
    const serverPayload = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)]
      .map((match) => match[1])
      .join('\n');
    expect(serverPayload, 'the server payload must not carry the pasted body').not.toContain(RAW_CANARY);
    expect(page.url(), 'the pasted text must not be echoed into the URL').not.toContain(RAW_CANARY);
    expect(text, 'the refusal must not quote the pasted body').not.toContain(RAW_CANARY);
    expect(html, 'no key-shaped value may be rendered').not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(text, 'a refusal must not render a stack trace').not.toMatch(/at [a-z]+ \(.*:\d+:\d+\)/);

    expect(consoleErrors, `console errors on a refusal:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });
});

test.describe('Creating a lead through the UI', () => {
  test('the Leads screen offers the §2 minimal-lead form and it opens', async () => {
    await openScreen(page, `/b/${BUSINESS.key}/leads`);

    const inventory = await controlInventory(page);

    /**
     * The minimal-lead path (§2): a name is enough.
     *
     * Asserted strictly. The acceptance document puts this form on the Leads screen, so its absence is a
     * contract gap and must be reported as one rather than skipped — the failure message lists the
     * controls that *are* present, which is what makes the gap actionable.
     */
    const hasAddControl =
      inventory.buttons.some((label) => normalise(label) === 'add lead') ||
      (await page.evaluate(() => document.querySelector('.nx-add-lead__summary') !== null));

    expect(
      hasAddControl,
      `the Leads screen must offer the §2 minimal-lead form ("Add lead"); buttons were ${JSON.stringify(
        inventory.buttons,
      )} and inputs were ${JSON.stringify(inventory.inputs)}`,
    ).toBe(true);

    // The form is a collapsed disclosure on purpose (it is an occasional action, not the
    // screen's purpose), so the spec opens it the way an operator does and *then* asserts
    // the field is reachable — which is what "proven to open" means.
    await page.evaluate(() => {
      const summary = document.querySelector('.nx-add-lead__summary');
      if (summary !== null) summary.click();
    });

    // The form's own name field, so the affordance is proven to open rather than merely to exist.
    await expect(
      page.locator('#add-lead-name'),
      'the minimal-lead form must offer a Full name field',
    ).toBeVisible({ timeout: 15_000 });

    expect(consoleErrors, `console errors on the Leads screen:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });
});
