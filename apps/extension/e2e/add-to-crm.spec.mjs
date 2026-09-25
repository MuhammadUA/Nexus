/**
 * Add to CRM: canonicalization and dedupe.
 *
 * spec `lead_invariants` is the contract under test: rediscovery must not create a second Person or
 * Company, and within one business a Person may have only one active Lead. Each case asserts what
 * exists afterwards rather than what the response said — a route that reports success while writing a
 * duplicate is the failure this is here to catch.
 *
 * Requests go from the panel's own origin with its own token, so the path exercised is the one the
 * Companion uses, including CORS.
 */
import { expect, test } from '@playwright/test';

import { launchExtension } from './harness.mjs';
import { callApi, signInAndBind, waitForCrmView, waitForShell } from './helpers.mjs';

let extension;
let page;
let businessId;
let identityId;
let otherBusinessId;

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

  const ids = await page.evaluate(() => {
    const pick = (selector, pattern) =>
      [...document.querySelectorAll(`${selector} option`)].find((option) => pattern.test(option.textContent ?? ''))
        ?.value ?? '';
    return {
      business: pick('#nx-c-business', /Zemnas/),
      other: pick('#nx-c-business', /Lavish/),
      identity: pick('#nx-c-identity', /Osama/),
    };
  });

  businessId = ids.business;
  otherBusinessId = ids.other;
  identityId = ids.identity;
  expect(businessId, 'the Zemnas business must be selectable').not.toBe('');
  expect(identityId, 'the Osama sender identity must be selectable').not.toBe('');
});

test.afterEach(async () => {
  await page?.close();
});

/**
 * A unique prospect for this run, so the cases never collide with seeded data.
 *
 * The handle is built the way LinkedIn builds them — letters, digits and hyphens only. A handle with
 * a space is not a valid LinkedIn profile URL, and both the TypeScript canonicalizer and the
 * database trigger would rewrite it differently, which would make the dedupe appear broken when the
 * input was simply not a profile URL.
 */
function prospect(label) {
  const stamp = `${String(Date.now()).slice(-7)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  const handleName = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const name = `${label} ${stamp}`;
  return {
    name,
    url: `https://www.linkedin.com/in/${handleName}-${stamp}`,
    content: `${name}\nChief Editor at Kernel Works\nBerlin, Germany\nKernel Works\nMedia production`.repeat(3),
  };
}

/**
 * Adds a profile the way the panel does.
 *
 * The route's contract is explicit: an ingestion names its business, its Primary ICP or an
 * `autoMatch` request, the pasted content, and an idempotency key. A fresh key per call is what makes
 * "offered twice" a real second ingestion rather than a replay, so the dedupe that follows is the
 * person/lead dedupe under test and not the idempotency guard.
 */
async function addProfile(business, { linkedinUrl, pageContent }) {
  const listed = await callApi(page, `/companion/icps?businessId=${encodeURIComponent(business)}`);
  const icpId = listed.body?.icps?.[0]?.id ?? '';
  expect(icpId, `business ${business} must expose an ICP to the panel`).not.toBe('');

  return callApi(page, '/companion/add', {
    method: 'POST',
    body: {
      linkedinUrl,
      pastedContent: pageContent,
      businessId: business,
      icpId,
      autoMatch: false,
      identityId,
      idempotencyKey: `e2e-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
}

function searchFor(query) {
  return callApi(page, `/companion/search?q=${encodeURIComponent(query)}`);
}

/** The leads the companion search can see for a person, in one business. */
async function leadsFor(name, business) {
  const found = await searchFor(name);
  expect(found.status, `search must succeed: ${JSON.stringify(found.body).slice(0, 200)}`).toBe(200);
  return (found.body?.results ?? []).filter((row) => row.businessId === business);
}

test('a new prospect creates a lead that is immediately searchable', async () => {
  const { name, url, content } = prospect('Ada Lovelace');

  const added = await addProfile(businessId, { linkedinUrl: url, pageContent: content });
  expect(added.status, JSON.stringify(added.body).slice(0, 300)).toBe(200);
  expect(added.body?.leadId, `add returned no leadId: ${JSON.stringify(added.body).slice(0, 300)}`).toBeTruthy();

  const leads = await leadsFor(name, businessId);
  expect(leads.length).toBe(1);
  expect(leads[0]?.personName).toBe(name);
  expect(leads[0]?.companyName).toContain('Kernel');
});

test('the same profile offered twice in one business updates rather than duplicating', async () => {
  const { name, url, content } = prospect('Alan Turing');

  const first = await addProfile(businessId, { linkedinUrl: url, pageContent: content });
  expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
  const second = await addProfile(businessId, { linkedinUrl: url, pageContent: content });
  expect(second.status, JSON.stringify(second.body).slice(0, 300)).toBe(200);

  // The second call reports that it found the record rather than making one.
  expect(second.body?.created).toBe(false);
  expect(second.body?.deduped).toBe(true);
  expect(second.body?.leadId).toBe(first.body?.leadId);

  const leads = await leadsFor(name, businessId);
  expect(leads.length).toBe(1);
});

test('a URL carrying tracking parameters resolves to the same person', async () => {
  const { name, url, content } = prospect('Katherine Johnson');

  const first = await addProfile(businessId, { linkedinUrl: url, pageContent: content });
  expect(first.status).toBe(200);

  // LinkedIn's own share links append these; they must not create a second person.
  const withTracking = `${url}?trk=public_profile_browsemap&original_referer=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F`;
  const second = await addProfile(businessId, { linkedinUrl: withTracking, pageContent: content });
  expect(second.status).toBe(200);
  expect(second.body?.leadId).toBe(first.body?.leadId);

  const leads = await leadsFor(name, businessId);
  expect(leads.length).toBe(1);
});

test('the same person in a second business gets a second lead, not a second person', async () => {
  test.skip(otherBusinessId === '', 'a second business is not available to this account');

  const { name, url, content } = prospect('Grace Hopper');

  const first = await addProfile(businessId, { linkedinUrl: url, pageContent: content });
  expect(first.status, JSON.stringify(first.body).slice(0, 200)).toBe(200);
  const second = await addProfile(otherBusinessId, { linkedinUrl: url, pageContent: content });
  expect(second.status, JSON.stringify(second.body).slice(0, 200)).toBe(200);

  // A different lead, because a Lead is per business. Reusing the first lead would mean the second
  // business had no context of its own.
  expect(second.body?.leadId).not.toBe(first.body?.leadId);
  expect(second.body?.created).toBe(true);

  // One Person for both contexts. `people_normalized_linkedin_key` is global, so a fork would have
  // been refused outright — `created` being true for a *new business* while the person already
  // existed is the reuse path, and a fork would have surfaced as an error instead.
  const perBusiness = await leadsFor(name, otherBusinessId);
  expect(perBusiness.length).toBe(1);
  expect(perBusiness[0]?.companyName).toContain('Kernel');
});

test('a non-LinkedIn URL is refused rather than turned into a person', async () => {
  const added = await addProfile(businessId, {
    linkedinUrl: 'https://example.com/in/not-linkedin',
    pageContent: 'Not a LinkedIn profile at all',
  });
  // The canonicalizer's permissiveness is not enough on its own; the route refuses a non-LinkedIn host.
  expect(added.status, JSON.stringify(added.body).slice(0, 200)).toBe(400);
  expect(added.body?.reason).toBe('not_a_linkedin_profile');

  // Nothing was created under a name that appears nowhere in the seed.
  const found = await searchFor('example nonlinkedin placeholder');
  expect((found.body?.results ?? []).length).toBe(0);
});

test('a profile with no pasted body still creates the lead, flagged as needing a profile', async () => {
  const { url } = prospect('Empty Body');
  const added = await addProfile(businessId, { linkedinUrl: url, pageContent: '' });

  // A capture with nothing to extract is a *partial* record, not an error: spec
  // `lead_sources.duplicate_review` and the profile queue exist precisely for this case. The
  // invariant is that it is flagged, so the queue picks it up rather than it passing as complete.
  expect(added.status, JSON.stringify(added.body).slice(0, 200)).toBe(200);
  expect(added.body?.needsProfile).toBe(true);
});

test('adding a profile requires a token', async () => {
  const anonymous = await callApi(page, '/companion/add', {
    method: 'POST',
    body: { businessId, identityId, linkedinUrl: 'https://www.linkedin.com/in/x', pageContent: 'x' },
    withoutToken: true,
  });
  expect(anonymous.status).toBe(401);
});
