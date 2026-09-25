/**
 * LinkedIn profile extraction.
 *
 * The content script runs inside a page Nexus does not control and whose markup changes without
 * notice. Two rules follow from that, and this module exists to enforce both:
 *
 *   1. **Every selector lives here.** A LinkedIn redesign then breaks one file with one test suite,
 *      instead of silently degrading the Companion. Each field is a list of candidates tried in
 *      order, so one renamed class costs one candidate rather than the whole capture.
 *   2. **Extraction never throws and never guesses.** A field that cannot be read is `null`, and
 *      the caller falls back to asking the operator to paste the profile — which is the documented
 *      path, not an error state. A fabricated headline would be indistinguishable from a real one
 *      once stored.
 *
 * What it deliberately does not do: read anything outside the profile's own region, collect
 * credentials or form values, click, scroll, or modify the page.
 *
 * This module is pure with respect to the page: it takes a `Document` and returns data, so it can
 * be tested against captured markup without a browser.
 */

/** The fields Nexus needs. Nothing else is collected. */
export interface LinkedInProfile {
  readonly url: string;
  readonly fullName: string | null;
  readonly headline: string | null;
  readonly location: string | null;
  readonly company: string | null;
  readonly jobTitle: string | null;
  /** The profile text, bounded. Stored as source evidence, rendered as text, never executed. */
  readonly capturedText: string;
  /** Which selector matched the container; recorded so a stale selector is visible. */
  readonly source: 'profile-main' | 'profile-content' | 'main' | 'body';
  readonly capturedAt: string;
}

/**
 * Containers that hold the profile and nothing else, most specific first.
 *
 * `main` is a fallback rather than a first choice: on a logged-in LinkedIn page it also contains
 * the feed rail and the messaging overlay, so capturing it wholesale brings in text that has
 * nothing to do with the prospect.
 */
const PROFILE_CONTAINERS: readonly { readonly selector: string; readonly source: LinkedInProfile['source'] }[] = [
  { selector: 'main .scaffold-layout__main', source: 'profile-main' },
  { selector: '.scaffold-layout__main', source: 'profile-main' },
  { selector: '#profile-content', source: 'profile-content' },
  { selector: 'main', source: 'main' },
];

/** The profile's own heading block, tried in order. */
const NAME_SELECTORS = ['h1.text-heading-xlarge', 'main h1', '.pv-text-details__left-panel h1', 'h1'];

const HEADLINE_SELECTORS = [
  '.text-body-medium.break-words',
  '.pv-text-details__left-panel .text-body-medium',
  '[data-generated-suggestion-target] .text-body-medium',
];

const LOCATION_SELECTORS = [
  '.text-body-small.inline.t-black--light.break-words',
  '.pv-text-details__left-panel .text-body-small',
  '.text-body-small.t-black--light',
];

/** The most recent experience entry: current employer and title. */
const EXPERIENCE_SELECTORS = [
  '#experience ~ .pvs-list__outer-container li:first-child',
  'section:has(#experience) li:first-child',
  '.pvs-list__paged-list-item:first-child',
];

/** Text of the first element matching any of `selectors`, trimmed to `max` characters. */
function firstText(root: ParentNode, selectors: readonly string[], max = 300): string | null {
  for (const selector of selectors) {
    let element: Element | null = null;
    try {
      element = root.querySelector(selector);
    } catch {
      // An unsupported selector in an older engine must not abort the whole capture.
      continue;
    }
    const text = element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (text.length > 0) return text.slice(0, max);
  }
  return null;
}

/**
 * Splits an experience entry into title and company.
 *
 * LinkedIn renders them as separate block elements within one list item. `textContent` joins those
 * blocks without a separator, so the boundary has to be read *before* whitespace is collapsed —
 * normalising first removes the only signal there is, which is why this does not reuse
 * `firstText`. The first line is the title and the second is the company; when the shape is not
 * recognised both are left null rather than guessed.
 */
function readExperience(root: ParentNode): { readonly jobTitle: string | null; readonly company: string | null } {
  for (const selector of EXPERIENCE_SELECTORS) {
    let element: Element | null = null;
    try {
      element = root.querySelector(selector);
    } catch {
      continue;
    }
    const raw = element?.textContent ?? '';
    if (raw.trim().length === 0) continue;

    const lines = raw
      // A block boundary shows up as a newline, or as runs of whitespace when the markup is flat.
      .split(/\n|\r|(?:\s{2,})/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0 && line.length < 160);

    if (lines.length >= 2) return { jobTitle: lines[0] ?? null, company: lines[1] ?? null };
    if (lines.length === 1) return { jobTitle: lines[0] ?? null, company: null };
  }
  return { jobTitle: null, company: null };
}

/** Whether a URL is a LinkedIn *profile* page, which is the only page capture is offered on. */
export function isProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'linkedin.com' && !parsed.hostname.endsWith('.linkedin.com')) return false;
    return /^\/in\/[^/]+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Reads the profile from a document.
 *
 * Returns `null` when the page is not a profile, so the panel can say "open a profile first"
 * instead of offering a capture that would store the wrong page.
 */
export function readProfile(doc: Document, url: string, at: string = new Date().toISOString()): LinkedInProfile | null {
  if (!isProfileUrl(url)) return null;

  let container: Element | null = null;
  let source: LinkedInProfile['source'] = 'body';
  for (const candidate of PROFILE_CONTAINERS) {
    try {
      container = doc.querySelector(candidate.selector);
    } catch {
      container = null;
    }
    if (container !== null) {
      source = candidate.source;
      break;
    }
  }
  const root: ParentNode = container ?? doc.body;

  const experience = readExperience(root);
  // `innerText` is the rendered text, which is what an operator would copy; `textContent` includes
  // hidden nodes. It is read through the `HTMLElement` view rather than `Element`, where it is
  // declared, and falls back for a document whose shell is not an element.
  const container_ = container as HTMLElement | null;
  const text = container_?.innerText ?? doc.body?.innerText ?? doc.body?.textContent ?? '';

  return {
    url,
    fullName: firstText(root, NAME_SELECTORS, 120),
    headline: firstText(root, HEADLINE_SELECTORS, 300),
    location: firstText(root, LOCATION_SELECTORS, 120),
    company: experience.company,
    jobTitle: experience.jobTitle,
    capturedText: text.replace(/\s+\n/g, '\n').trim().slice(0, 60_000),
    source,
    capturedAt: at,
  };
}
