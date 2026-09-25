/**
 * Panel-driving helpers shared by the extension E2E specs.
 *
 * Everything here talks to the panel the way an operator does — filling the real inputs and
 * dispatching the events a keystroke dispatches — because the design system listens on `input`
 * rather than `change`, and a test that sets a value without that event would be testing a
 * component that does not exist.
 */
import { expect } from '@playwright/test';

export const ADMIN_EMAIL = 'admin@nexus.local';
export const ADMIN_PASSWORD = 'vXbSm5c4ujtayWGR4ICuXny4';

/** Waits for the panel's shell, which is the definition of "mounted". */
export async function waitForShell(page) {
  await page.waitForFunction(() => document.querySelector('.nx-companion') !== null, undefined, {
    timeout: 25_000,
  });
}

/**
 * Fills a controlled input the way React sees a keystroke.
 *
 * `fill()` alone sets the value through the native setter and fires `input`, which is exactly what
 * the design system listens for — so this is a thin wrapper whose value is the assertion that the
 * field exists at all.
 */
export async function fill(page, selector, value) {
  const applied = await page.evaluate(
    ([target, wanted]) => {
      const element = document.querySelector(target);
      if (element === null) return 'missing';
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter === undefined) return 'no setter';
      setter.call(element, wanted);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return element.value;
    },
    [selector, value],
  );
  if (applied === 'missing') throw new Error(`fill: no element matches ${selector}`);
  if (applied !== value) throw new Error(`fill: ${selector} holds ${String(applied)}, expected ${value}`);
}

/**
 * Chooses an option in a controlled design-system `Select`.
 *
 * `selectOption` alone is not enough here. The design system listens on the DOM `input` event, and
 * a programmatic selection through the native setter does not produce one on every path — so the
 * value is set through the prototype setter and the event is dispatched explicitly, which is the
 * same thing a keystroke does. Without this the panel keeps its previous selection and reports
 * "Choose the identity this browser profile uses."
 */
export async function chooseOption(page, selector, value) {
  const applied = await page.evaluate(
    ([target, wanted]) => {
      const element = document.querySelector(target);
      if (element === null) return 'missing';
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter === undefined) return 'no setter';
      setter.call(element, wanted);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.value === wanted ? 'ok' : `value=${element.value}`;
    },
    [selector, value],
  );
  expect(applied, `selecting ${value} in ${selector}`).toBe('ok');
}

/** Signs in from the panel's own form and waits for the binding screen or the shell. */
export async function signIn(page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  // The first screen is sign-in; if a session is already held there is no form to fill.
  const hasForm = await page.evaluate(() => document.querySelector('#c-email') !== null);
  if (hasForm) {
    await fill(page, '#c-email', email);
    await fill(page, '#c-password', password);
    const clicked = await clickButton(page, /^\s*sign in\s*$/i);
    if (!clicked) throw new Error('signIn: the sign-in form was shown but had no Sign in button');
  }

  // Either the binding screen or the bound shell is acceptable next.
  await page.waitForFunction(
    () =>
      document.querySelector('#c-identity') !== null || document.querySelector('.nx-companion__topnav') !== null,
    undefined,
    { timeout: 25_000 },
  );
}

/**
 * Clicks the first button whose text matches, and reports whether one was found.
 *
 * The search and the click both run in the panel's DOM. A disabled button is waited for rather than
 * clicked: the design system disables a control while its own request is in flight, and a click on a
 * disabled button is a silent no-op — which looks exactly like a broken screen.
 */
export async function clickButton(page, pattern) {
  const source = pattern.source;
  const flags = pattern.flags;

  await page
    .waitForFunction(
      ([src, fl]) => {
        const matcher = new RegExp(src, fl);
        return [...document.querySelectorAll('button, a')].some(
          (el) => matcher.test((el.textContent ?? '').trim()) && !el.disabled,
        );
      },
      [source, flags],
      { timeout: 20_000 },
    )
    .catch(() => undefined);

  return page.evaluate(
    ([src, fl]) => {
      const matcher = new RegExp(src, fl);
      const target = [...document.querySelectorAll('button, a')].find(
        (el) => matcher.test((el.textContent ?? '').trim()) && !el.disabled,
      );
      if (target === undefined) return false;
      target.click();
      return true;
    },
    [source, flags],
  );
}

/**
 * Binds this browser profile, handling the in-use warning when it appears.
 *
 * `transfer` is what an operator clicks on the warning, so it is opt-in: a test that wants to
 * observe the warning leaves it false.
 */
export async function bind(page, { identityId, businessId, transfer = false } = {}) {
  if (identityId !== undefined) await chooseOption(page, '#c-identity', identityId);
  if (businessId !== undefined) await chooseOption(page, '#c-business', businessId);

  const clicked = await clickButton(page, /^\s*bind this browser\s*$/i);

  // The in-use warning replaces the simple error, and carries the holder's details.
  const warning = page.getByText(/currently active elsewhere|currently active in another/i);
  const appeared = await warning
    .first()
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (appeared && transfer) {
    const transferred = await clickButton(page, /^\s*transfer to this browser\s*$/i);
    if (!transferred) throw new Error('bind: the in-use warning appeared but had no transfer button');

    // The outcome is "the CRM View is showing" or "an alert other than the warning is showing".
    // Waiting for the warning to disappear would be wrong: the notice stays in the DOM while the
    // shell renders behind it, so it is not a completion signal.
    const settled = await page
      .waitForFunction(
        () => {
          if (document.querySelector('.nx-companion__topnav') !== null) return 'bound';
          const alerts = [...document.querySelectorAll('.nx-alert, [role="alert"]')].map((el) => el.textContent ?? '');
          const refusal = alerts.find((text) => !/currently active/i.test(text));
          return refusal === undefined ? false : 'refused';
        },
        undefined,
        { timeout: 25_000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => 'timeout');

    if (settled === 'refused') {
      const alerts = await page.evaluate(() =>
        [...document.querySelectorAll('.nx-alert, [role="alert"]')].map((el) => el.textContent ?? ''),
      );
      throw new Error(
        `bind: the transfer was refused. Panel says: ${alerts.filter((t) => !/currently active/i.test(t)).join(' | ')}`,
      );
    }
    if (settled === 'timeout') {
      throw new Error('bind: the transfer neither bound nor reported a refusal within 25s');
    }
  }

  // Handle the states a caller cannot do anything about, so the reason is visible rather than a
  // timeout: the button was never found, or the bind was refused for a reason other than a conflict.
  if (!appeared) {
    const state = await page.evaluate(() => ({
      identity: document.querySelector('#c-identity')?.value ?? null,
      business: document.querySelector('#c-business')?.value ?? null,
      alerts: [...document.querySelectorAll('.nx-alert, [role="alert"]')].map((el) => el.textContent.trim()),
      buttons: [...document.querySelectorAll('button')].map((el) => el.textContent.trim()),
    }));
    if (!clicked) throw new Error(`bind: no "Bind this browser" button; panel has ${JSON.stringify(state.buttons)}`);
    if (state.alerts.length > 0) throw new Error(`bind refused: ${state.alerts.join(' | ')}`);
    if (state.identity === null || state.identity === '') {
      throw new Error(`bind: the identity select is empty (business=${String(state.business)})`);
    }
  }

  return appeared;
}

/**
 * Signs in and binds, leaving the panel on the CRM View.
 *
 * Several cases only need "a working Companion", and repeating the two steps in each of them would
 * bury the thing under test. The identity is chosen explicitly because the panel defaults to none.
 */
export async function signInAndBind(page, { transfer = true } = {}) {
  await signIn(page);

  // The browser profile may already be bound — the same profile is reused across the specs — in
  // which case the panel opens straight into the CRM View and there is nothing left to bind.
  const alreadyBound = await isCrmView(page);
  if (alreadyBound) return { identityId: null, businessId: null, warned: false };

  const identities = await page.evaluate(() =>
    [...document.querySelectorAll('#c-identity option')].map((option) => option.value).filter((value) => value.length > 0),
  );
  expect(identities.length, 'the account must have at least one usable sender identity').toBeGreaterThan(0);

  const businesses = await page.evaluate(() =>
    [...document.querySelectorAll('#c-business option')].map((option) => option.value).filter((value) => value.length > 0),
  );

  const warned = await bind(page, {
    identityId: identities[0],
    businessId: businesses[0],
    transfer,
  });

  // The bind request, the transfer and the re-render are three round trips, so the CRM View appears
  // asynchronously. This polls the panel's own DOM: a `Locator` for the same element was observed
  // not resolving in this extension document even while `document.querySelector` found it, so the
  // check goes through the same path the rest of these helpers use.
  const reached = await page
    .waitForFunction(() => document.querySelector('.nx-companion__topnav') !== null, undefined, {
      timeout: 30_000,
    })
    .then(() => true)
    .catch(() => false);

  if (!reached) {
    // A bind that did not reach the CRM View has failed for a reason the operator would see in the
    // alert; surface it here rather than leaving a bare timeout.
    const state = await page.evaluate(() => ({
      alerts: [...document.querySelectorAll('.nx-alert, [role="alert"]')].map((el) => el.textContent.trim()),
      hasTopnav: document.querySelector('.nx-companion__topnav') !== null,
      hasIdentitySelect: document.querySelector('#c-identity') !== null,
      hasEmail: document.querySelector('#c-email') !== null,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
    }));
    throw new Error(`bind did not reach the CRM View; panel state: ${JSON.stringify(state)}`);
  }

  return { identityId: identities[0], businessId: businesses[0], warned };
}

/**
 * Waits for the CRM View to be showing, which is the bound state.
 *
 * Polls the panel's own DOM rather than using a `Locator`. Playwright resolves locators by injecting
 * a script into the page, and inside this `chrome-extension://` document that resolution was
 * observed not to find elements that `document.querySelector` returns immediately — including
 * `getByRole`, which reported nothing for a tab strip that was on screen. Selecting through
 * `waitForFunction` uses the same path as the rest of these helpers and is reliable here.
 */
export async function waitForCrmView(page) {
  await page.waitForFunction(() => document.querySelector('.nx-companion__topnav') !== null, undefined, {
    timeout: 30_000,
  });
}

/** Whether the CRM View is showing right now, without waiting. */
export async function isCrmView(page) {
  return page.evaluate(() => document.querySelector('.nx-companion__topnav') !== null);
}

/** Switches CRM module tab: Leads, Today or Search. */
export async function openModule(page, label) {
  await clickButton(page, new RegExp(`^\\s*${label}`));
  await page.waitForTimeout(600);
}

/** The leads currently listed, as text. */
export async function leadRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.nx-companion__list li')].map((el) => el.textContent?.trim() ?? ''),
  );
}

/** Reads the panel's own storage — the real `chrome.storage`, not a stand-in. */
/** Whether an element matching `selector` is in the panel's DOM right now. */
export async function hasDom(page, selector) {
  return page.evaluate((target) => document.querySelector(target) !== null, selector);
}

/** Waits until the panel's own DOM contains `selector`. */
export async function waitForDom(page, selector, timeout = 20_000) {
  await page.waitForFunction((target) => document.querySelector(target) !== null, selector, { timeout });
}

/** The visible labels of a `<select>`'s options. */
export async function optionLabels(page, selector) {
  return page.evaluate(
    (target) => [...document.querySelectorAll(`${target} option`)].map((option) => option.textContent?.trim() ?? ''),
    selector,
  );
}

/** The values of a `<select>`'s options, excluding the placeholder. */
export async function optionValues(page, selector) {
  return page.evaluate(
    (target) =>
      [...document.querySelectorAll(`${target} option`)].map((option) => option.value).filter((value) => value.length > 0),
    selector,
  );
}

/** The panel's alert texts, as rendered. */
export async function alerts(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.nx-alert, [role="alert"]')].map((el) => (el.textContent ?? '').trim()),
  );
}

/**
 * Calls a Companion API route from the panel, with or without the stored token.
 *
 * `withoutToken` is how the closed surface is demonstrated: the panel's token is otherwise attached,
 * and the request is made from the extension's own origin so CORS is exercised too.
 */
export async function callApi(page, path, { method = 'GET', body, withoutToken = false } = {}) {
  return page.evaluate(
    async ([target, verb, payload, anonymous]) => {
      const headers = { 'content-type': 'application/json' };
      if (!anonymous) {
        const stored = await chrome.storage.session.get('nexus.token');
        const token = stored['nexus.token'];
        if (typeof token === 'string') headers.authorization = `Bearer ${token}`;
      }
      const response = await fetch(`http://127.0.0.1:3000/api/v1${target}`, {
        method: verb,
        headers,
        // A GET/HEAD request with a body is rejected outright by `fetch`, so a body is only attached
        // when one was actually given.
        ...(payload === null || payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text.slice(0, 200);
      }
      return { status: response.status, body: parsed };
    },
    [path, method, body ?? null, withoutToken],
  );
}

/** Reads the panel's own storage — the real `chrome.storage`, not a stand-in. */
export async function readExtensionStorage(page, area, key) {
  return page.evaluate(
    ([storageArea, storageKey]) => chrome.storage[storageArea].get(storageKey),
    [area, key],
  );
}

export async function writeExtensionStorage(page, area, values) {
  await page.evaluate(
    ([storageArea, payload]) => chrome.storage[storageArea].set(payload),
    [area, values],
  );
}

export async function clearExtensionStorage(page, area, keys) {
  await page.evaluate(
    ([storageArea, storageKeys]) => chrome.storage[storageArea].remove(storageKeys),
    [area, keys],
  );
}

/** The install id the extension generated for this browser profile. */
export async function installId(page) {
  const stored = await readExtensionStorage(page, 'local', 'nexus.installId');
  return stored['nexus.installId'] ?? null;
}
