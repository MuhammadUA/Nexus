/**
 * V1.2 screens — browser acceptance for the six screens `docs/V1_2_UI_ACCEPTANCE.md` describes.
 *
 * Every test here follows the same four steps, because a screen is only "present" in the sense the
 * acceptance document means when all four hold:
 *
 *   1. navigate to the documented route;
 *   2. wait for a stable marker (the screen's own heading, or a section title) rather than a timeout;
 *   3. assert the content the document requires actually exists;
 *   4. assert the page produced no console error.
 *
 * Two rules govern the assertions, and both exist because the database is fresh and truthful:
 *
 *   * **Never assert a number.** The seed leaves some series empty on purpose and the acceptance
 *     criteria require an empty series to show a truthful empty state rather than a `0`. Pinning a
 *     count would make this suite fail the day a fixture grows, which teaches nothing.
 *   * **Never assert an absence that a legitimate state could fill.** "No control labelled complete"
 *     is asserted; "no rows" is never asserted, and the empty case is asserted *as* an empty state.
 *
 * A screen that has not landed yet fails with the route and the HTTP status, not with a locator
 * timeout — see `openScreen` in `harness.mjs`.
 */
import {
  BUSINESS,
  bodyText,
  describeConsole,
  expect,
  heading,
  links,
  normalise,
  openScreen,
  pageHtml,
  statLabels,
  tableHeaders,
  test,
  useSignedInPage,
} from './harness.mjs';

/**
 * One signed-in page and one console buffer for the whole file.
 *
 * File-level rather than per-describe on purpose: signing in is the expensive part, and a per-block page
 * would pay for it six times. The harness clears the console buffer before each test, so sharing the
 * page does not share failures.
 */
const shared = useSignedInPage();
const consoleErrors = shared.consoleErrors;

/** Route table, so a spec name and the route it drives cannot drift apart. */
const ROUTES = Object.freeze({
  overview: `/b/${BUSINESS.key}/overview`,
  leads: `/b/${BUSINESS.key}/leads`,
  agentJobs: `/b/${BUSINESS.key}/agent-jobs`,
  setupAi: `/b/${BUSINESS.key}/setup/ai`,
  setup: `/b/${BUSINESS.key}/setup`,
  channelAccounts: '/identities',
  team: '/team',
});

/* ---------------------------------------------------------------- 1. Overview -- */

test.describe('Overview V1.2', () => {
  test('shows the eight metrics, the enrichment funnel and agent activity, with no console errors', async () => {
    await openScreen(shared.page, ROUTES.overview);

    // The stable marker: the screen's own heading. `PageHead` renders it before any data is read, so
    // its presence proves the route resolved rather than that a query happened to return rows.
    expect(normalise(await heading(shared.page))).toContain('overview');

    /**
     * The eight required metrics, matched case-insensitively against the design system's own stat
     * labels (`.nx-stat__label`) — not against the page text, where "Agent jobs open" appearing in a
     * footnote would satisfy the assertion without a metric being rendered.
     */
    const labels = (await statLabels(shared.page)).map(normalise);
    for (const required of [
      'active leads',
      'needs enrichment',
      'agent jobs open',
      'waiting ai',
      'ready for outreach',
      'replies today',
      'ai usage today',
      'failed enrichments',
    ]) {
      expect(
        labels.some((label) => label.includes(required)),
        `the Overview must render a metric labelled "${required}"; it rendered ${JSON.stringify(labels)}`,
      ).toBe(true);
    }

    // The two sections the acceptance document names, plus the recent-series sections beside them.
    const text = normalise(await bodyText(shared.page));
    for (const section of ['enrichment funnel', 'agent activity', 'recent signals', 'recent activity']) {
      expect(text, `the Overview must render the ${section} section`).toContain(section);
    }

    /**
     * Zero and real data must both pass.
     *
     * Nothing above pins a number: a metric rendering `0`, `—` or an empty-state sentence all satisfy
     * it. This last check asserts that every rendered metric value is either a number or an explicit
     * "no measurement" marker, because a fabricated figure is the failure mode the acceptance document
     * names — a `0` presented as a measurement where the truth is "no rows".
     */
    const values = await shared.page.evaluate(() =>
      [...document.querySelectorAll('.nx-stat__value')].map((el) => (el.textContent ?? '').trim()),
    );
    expect(values.length, 'the Overview must render metric values, not only labels').toBeGreaterThan(0);
    for (const value of values) {
      expect(value, `a metric value must be a number or an explicit empty marker, found "${value}"`).toMatch(
        /^(\d[\d,]*%?|—|-|–)$/,
      );
    }

    expect(
      consoleErrors,
      `console errors on ${ROUTES.overview}:\n  ${describeConsole(consoleErrors)}`,
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------- 2. Leads -- */

test.describe('Leads V1.2', () => {
  test('shows the V1.2 columns, a real deterministic Find LinkedIn link, and no console errors', async () => {
    await openScreen(shared.page, ROUTES.leads);
    expect(normalise(await heading(shared.page))).toContain('lead');

    const headers = (await tableHeaders(shared.page)).map(normalise);

    /**
     * The V1.2 column set (spec §30).
     *
     * Each entry lists acceptable spellings rather than one exact string, because the document names the
     * *concept* ("AI-context readiness") and a column header is free to abbreviate it. Requiring an exact
     * label would fail on wording while the required information was on screen.
     */
    const requiredColumns = [
      ['person', 'name'],
      ['company'],
      ['enrichment'],
      ['completeness', 'intelligence'],
      ['source'],
      ['icp'],
      ['channel'],
      ['owner'],
      ['next action', 'next step'],
      ['ai context', 'ai-context', 'context'],
    ];
    for (const spellings of requiredColumns) {
      expect(
        headers.some((header) => spellings.some((spelling) => header.includes(spelling))),
        `the Leads table must have a column matching ${JSON.stringify(spellings)}; it has ${JSON.stringify(headers)}`,
      ).toBe(true);
    }

    /**
     * The deterministic search link, asserted as a *pair*: a control whose label names LinkedIn and
     * whose `href` starts with the Google search endpoint.
     *
     * This is the assertion that proves the zero-token claim. `searchLinks()` in `@nexus/core` is the
     * only thing that builds these URLs and it is a pure string function, so an href that resolves to
     * `https://www.google.com/search?q=` cannot have cost a model call.
     */
    const anchors = await links(shared.page);
    const findLinkedIn = anchors.filter((anchor) => normalise(anchor.label).includes('linkedin'));
    expect(
      findLinkedIn.length,
      `the Leads screen must offer a "Find LinkedIn" affordance; anchors were ${JSON.stringify(anchors.map((a) => a.label))}`,
    ).toBeGreaterThan(0);
    expect(
      findLinkedIn.some((anchor) => anchor.href.startsWith('https://www.google.com/search?q=')),
      `a Find LinkedIn link must open the deterministic Google query; its hrefs were ${JSON.stringify(findLinkedIn.map((a) => a.href))}`,
    ).toBe(true);

    /**
     * The list may legitimately be empty, so the empty case is asserted *as* an empty state.
     *
     * Exactly one of the two states must hold — rows, or the documented empty state. Never neither,
     * which is what a blank screen looks like, and never a fabricated row.
     */
    const leadRows = await shared.page.evaluate(() => document.querySelectorAll('.nx-table tbody tr').length);
    const hasEmptyState = await shared.page.evaluate(() => document.querySelector('.nx-empty') !== null);
    expect(
      leadRows > 0 || hasEmptyState,
      'the Leads screen must show either lead rows or the documented empty state, not a blank list',
    ).toBe(true);

    expect(consoleErrors, `console errors on ${ROUTES.leads}:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });
});

/* -------------------------------------------------------------- 3. Agent Jobs -- */

test.describe('Agent Jobs', () => {
  test('shows the summary counts and table columns, and offers no manual complete action', async () => {
    await openScreen(shared.page, ROUTES.agentJobs);
    expect(normalise(await heading(shared.page))).toContain('agent job');

    const text = normalise(await bodyText(shared.page));

    // Summary counts (spec §33), in the document's own vocabulary.
    for (const count of ['open', 'running', 'waiting ai', 'failed', 'done today']) {
      expect(text, `the Agent Jobs summary must show a "${count}" count`).toContain(count);
    }

    // Per-job columns. `lease` is asserted because the explicit *expired* lease state is only reachable
    // through it, and an absent lease column is how that state silently disappears.
    //
    // The fixture graph contains no agent jobs, so this screen legitimately renders its documented
    // empty state instead of an empty table — asserting header cells unconditionally would fail on a
    // fresh database and teach nothing. What is asserted either way is that the screen states the
    // queue's own vocabulary and the two ways a job comes into existence, so an operator reading the
    // empty state knows what the table will hold.
    const requiredColumns = [
      ['priority'],
      ['type'],
      ['entity'],
      ['status'],
      ['agent'],
      ['lease'],
      ['attempt'],
      ['created'],
      ['updated'],
    ];
    const headers = (await tableHeaders(shared.page)).map(normalise);
    if (headers.length > 0) {
      for (const spellings of requiredColumns) {
        expect(
          headers.some((header) => spellings.some((spelling) => header.includes(spelling))),
          `the Agent Jobs table must have a column matching ${JSON.stringify(spellings)}; it has ${JSON.stringify(headers)}`,
        ).toBe(true);
      }
    } else {
      expect(text, 'an empty queue must say so rather than rendering a blank table').toMatch(
        /no agent jobs|no jobs match|no stale leases/,
      );
      expect(
        text,
        'the empty state must name how a job is created, so the screen is still actionable',
      ).toMatch(/create_agent_job|created automatically|by hand/);
    }

    /**
     * **No manual complete action.**
     *
     * A job reaches a terminal state only because the extraction pipeline committed verified facts, so
     * a "complete" control on this screen would be a way to mark work done that never happened. The
     * check is case-insensitive and covers `button`, `a`, `[role="button"]`, `input[type=submit]` and
     * `summary`, because an affordance is a control whatever element it is built from — a
     * `<button>`-only search would miss a link.
     *
     * Note what is *not* asserted: the word "complete" may legitimately appear as data (a `COMPLETE`
     * status chip in a row). This asserts there is no control whose label offers the action.
     */
    const completeControls = await shared.page.evaluate(() =>
      [...document.querySelectorAll('button, a, [role="button"], input[type="submit"], summary')]
        .map((el) => {
          const label = el.tagName === 'INPUT' ? el.getAttribute('value') ?? '' : el.textContent ?? '';
          return label.replace(/\s+/g, ' ').trim();
        })
        .filter((label) => /complete/i.test(label)),
    );
    expect(
      completeControls,
      `a manual complete action is forbidden on Agent Jobs; found ${JSON.stringify(completeControls)}`,
    ).toEqual([]);

    expect(consoleErrors, `console errors on ${ROUTES.agentJobs}:\n  ${describeConsole(consoleErrors)}`).toEqual(
      [],
    );
  });
});

/* ------------------------------------------------------------- 4. AI settings -- */

test.describe('Business Setup — AI tab', () => {
  /** The twelve prompt keys, spec §21.4 / `PROMPT_KEYS` in `@nexus/core`. */
  const PROMPT_KEYS = [
    'profile_extract',
    'company_extract',
    'signal_extract',
    'icp_qualify',
    'context_build',
    'linkedin_initial',
    'linkedin_followup',
    'email_initial',
    'email_followup',
    'instagram_dm',
    'upwork_proposal',
    'reply_classify',
  ];

  test('lists all twelve prompt keys with a version and model, and renders no key-shaped secret', async () => {
    await openScreen(shared.page, ROUTES.setupAi);
    expect(normalise(await heading(shared.page))).toContain('ai');

    const html = await pageHtml(shared.page);
    const text = normalise(await bodyText(shared.page));

    for (const key of PROMPT_KEYS) {
      expect(
        html.includes(key),
        `the AI tab must list the prompt key "${key}"; it rendered ${
          String(PROMPT_KEYS.filter((candidate) => html.includes(candidate)).length)
        } of ${String(PROMPT_KEYS.length)}`,
      ).toBe(true);
    }

    // A version and a model per prompt key. The *labels* are asserted; the values are not pinned,
    // because a business may legitimately carry an override version and any deployment may pin any model.
    for (const label of ['version', 'model']) {
      expect(text, `each prompt key must be shown with its ${label}`).toContain(label);
    }

    /**
     * Provider state: configured or not configured.
     *
     * The suite never sets `DEEPSEEK_API_KEY`, so the rendering here is expected to be "not
     * configured" — but the assertion is that the screen *states which it is*, because the acceptance
     * requirement is that the state is visible rather than that it has one particular value.
     */
    expect(/configured/.test(text), 'the AI tab must state whether the provider is configured or not').toBe(true);

    /**
     * **No API key, not even truncated.**
     *
     * A DeepSeek key is `sk-` followed by a long token. Asserting on the shape rather than on the
     * literal variable name is what makes this meaningful: the variable *name* appearing in operator copy
     * is legitimate (the AI drafting notice names it deliberately), whereas a key-shaped value is a
     * leak. The trailing length guard means a word such as "risk-management" cannot trip it.
     */
    expect(html, 'no API key may be rendered, not even truncated').not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);

    expect(consoleErrors, `console errors on ${ROUTES.setupAi}:\n  ${describeConsole(consoleErrors)}`).toEqual(
      [],
    );
  });

  test('is reachable as a tab of Business Setup', async () => {
    await openScreen(shared.page, ROUTES.setup);

    // The AI tab must be a real link from its parent section, not a URL only a developer knows.
    const anchors = await links(shared.page);
    expect(
      anchors.some((anchor) => anchor.href.endsWith('/setup/ai') || normalise(anchor.label) === 'ai'),
      `Business Setup must link to its AI tab; anchors were ${JSON.stringify(anchors.map((a) => a.label))}`,
    ).toBe(true);
  });
});

/* --------------------------------------------------------- 5. Channel Accounts -- */

test.describe('Channel Accounts', () => {
  test('uses the Channel Accounts vocabulary and shows the four channels', async () => {
    await openScreen(shared.page, ROUTES.channelAccounts);

    const text = normalise(await bodyText(shared.page));

    /**
     * The screen is the V1.1 "Outreach Identities" surface, re-vocabularised. The V1.2 noun is asserted
     * on the page itself; the legacy noun may still appear as secondary history (the acceptance document
     * says so explicitly), so this does not require the old wording to be gone.
     */
    expect(text, 'the screen must use the Channel Accounts vocabulary').toContain('channel account');

    /**
     * The channel of a listed account, read from the structured values rather than from prose.
     *
     * The seeded channel accounts are LinkedIn accounts, so at least one must render its channel as a
     * `linkedin` value — an option or a chip. This is the assertion that proves the channel is a
     * first-class field of an account rather than a sentence above the table.
     */
    const channelValues = await shared.page.evaluate(() => {
      const options = [...document.querySelectorAll('option')].map((el) => el.textContent ?? '');
      const chips = [...document.querySelectorAll('.nx-chip')].map((el) => el.textContent ?? '');
      return [...options, ...chips].map((value) => value.replace(/\s+/g, ' ').trim().toLowerCase());
    });
    expect(
      channelValues.some((value) => value.includes('linkedin')),
      `a channel account must render its channel as a structured value; values were ${JSON.stringify(channelValues)}`,
    ).toBe(true);

    /**
     * The four channels are first-class (spec §10).
     *
     * Matched on the rendered page rather than on options alone, because a channel with no account yet
     * is legitimately presented as an available value in a form control *or* named in the screen's own
     * explanation — and both are evidence the vocabulary is four-wide. A word-boundary match is used so
     * a substring inside another word cannot satisfy it.
     */
    for (const channel of ['email', 'instagram', 'upwork']) {
      expect(
        new RegExp(`\\b${channel}\\b`).test(text),
        `Channel Accounts must present "${channel}" as a first-class channel`,
      ).toBe(true);
    }

    expect(
      consoleErrors,
      `console errors on ${ROUTES.channelAccounts}:\n  ${describeConsole(consoleErrors)}`,
    ).toEqual([]);
  });
});

/* ------------------------------------------------------- 6. Secondary navigation -- */

test.describe('Secondary navigation', () => {
  test('the V1.1 concatenation defect is gone', async () => {
    // Asserted on the screens that render a tab strip: Team & Accounts is where the defect was reported,
    // and Leads and Business Setup render strips of their own.
    for (const route of [ROUTES.team, ROUTES.leads, ROUTES.setup]) {
      await openScreen(shared.page, route);
      const text = await bodyText(shared.page);
      expect(
        text,
        `the V1.1 defect where two links rendered as one string must be gone on ${route}`,
      ).not.toContain('Outreach IdentitiesMy Access');
      // The defect was *one text run*: two links with no separator between them, so a
      // reader sees a single label. Two separate links that happen to sit next to each
      // other in the tab strip are correct — the body text extraction joins them with
      // whitespace — so the assertion is that no run joins them without one.
      expect(text, `the two tabs must render as separate labels on ${route}`).not.toMatch(
        /Outreach Identities(?:\s*<[^>]*>\s*)?My Access/,
      );
      expect(text, `no label may be concatenated without a separator on ${route}`).not.toMatch(
        /[a-z]My Access/,
      );
    }

    expect(consoleErrors, `console errors while checking tabs:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });

  test('Agent Jobs, Channel Accounts and AI are individually clickable tabs with an active state', async () => {
    /**
     * Each entry names the tab and the screen whose strip must carry it, plus the route it must point at.
     *
     * The parent matters: the secondary navigation is rendered by the business section a route belongs
     * to, so a tab is only reachable from a business screen. Channel Accounts is one of those entries
     * whose destination is outside the business layout (`/identities` is a global screen with its own
     * channel filter, and it renders no secondary strip), so it is asserted where it is offered — on the
     * business strip — and then followed to prove it navigates.
     */
    const tabs = [
      { name: 'Agent Jobs', parent: ROUTES.agentJobs, href: ROUTES.agentJobs },
      { name: 'Channel Accounts', parent: ROUTES.agentJobs, href: ROUTES.channelAccounts },
      { name: 'AI', parent: ROUTES.setupAi, href: ROUTES.setupAi },
    ];

    for (const tab of tabs) {
      await openScreen(shared.page, tab.parent);

      /**
       * The tab exists, is a link (so it is keyboard focusable and middle-clickable), points at the
       * screen it names, and — when the strip is the one for its own destination — carries an active
       * state. `aria-current="page"` is what the shell emits for a tab rendered as a link; an
       * `aria-selected` on `role="tab"` would be accepted too, because either is a real state the
       * assistive stack can read.
       */
      const state = await shared.page.evaluate((wanted) => {
        const candidates = [...document.querySelectorAll('a, button, [role="tab"]')].filter(
          (el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === wanted.toLowerCase(),
        );
        return candidates.map((el) => ({
          tag: el.tagName,
          href: el.getAttribute('href'),
          ariaSelected: el.getAttribute('aria-selected'),
          ariaCurrent: el.getAttribute('aria-current'),
        }));
      }, tab.name);

      const seen = await shared.page.evaluate(() =>
        [...document.querySelectorAll('a, button, [role="tab"]')].map((el) =>
          (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        ),
      );

      expect(
        state.length,
        `the ${tab.name} tab must exist on ${tab.parent} as its own control; controls found: ${JSON.stringify(seen)}`,
      ).toBeGreaterThan(0);

      expect(
        state.some((entry) => entry.tag === 'A' && (entry.href ?? '').length > 0),
        `the ${tab.name} tab must be a real link so it is keyboard focusable and navigable by URL`,
      ).toBe(true);

      expect(
        state.some((entry) => (entry.href ?? '').startsWith(tab.href)),
        `the ${tab.name} tab must point at ${tab.href}; it had ${JSON.stringify(state)}`,
      ).toBe(true);

      if (tab.href === tab.parent) {
        expect(
          state.some((entry) => entry.ariaSelected === 'true' || entry.ariaCurrent === 'page'),
          `the ${tab.name} tab must carry a visible active state on its own screen; it had ${JSON.stringify(state)}`,
        ).toBe(true);
      }
    }

    // The strip is a working navigation, not decoration: following the Channel Accounts tab lands on
    // the Channel Accounts screen.
    const channelTab = shared.page.locator(`a:has-text("Channel Accounts")`).first();
    await channelTab.click();
    await shared.page.waitForURL((url) => url.pathname === ROUTES.channelAccounts, { timeout: 20_000 });

    expect(consoleErrors, `console errors while checking tabs:\n  ${describeConsole(consoleErrors)}`).toEqual([]);
  });
});