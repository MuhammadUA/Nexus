/**
 * LinkedIn adapter.
 *
 * The adapter exists because LinkedIn's markup is not a contract. These tests pin three
 * behaviours that matter more than any particular selector:
 *
 *   * a page that is not a profile is refused, so the panel cannot capture the wrong page;
 *   * a field whose markup changed becomes `null` rather than a wrong value, which is what makes
 *     the paste fallback safe to rely on;
 *   * the region captured is the profile, not the whole logged-in page — a profile capture that
 *     sweeps in the feed is a privacy problem, not just a noisy one.
 *
 * The markup below is representative rather than live: it mirrors the shapes LinkedIn has used,
 * including the class-suffix style, so that a selector rewrite has something to fail against.
 */
import { describe, expect, it } from 'vitest';

import { isProfileUrl, readProfile } from './linkedin-adapter.js';

/**
 * A minimal `Document` stand-in.
 *
 * jsdom is not a dependency of this package, and pulling a DOM in for six selector tests would be a
 * large dependency for little value. The fake models the two behaviours the adapter depends on:
 *
 *   * `querySelector` returns the first element whose selector key is listed, and a selector the
 *     engine does not understand throws — which is how `:has()` behaves on older Chrome;
 *   * an element's `innerText` is the text of the element *and its descendants*, which is the
 *     property the adapter relies on to capture a whole profile region.
 *
 * Each element is `{ innerText, children }`, where `children` keys are selectors to match.
 */
interface FakeElement {
  readonly innerText: string;
  readonly children?: Readonly<Record<string, FakeElement>>;
}

function fakeDocument(tree: Readonly<Record<string, FakeElement>>, bodyText = ''): Document {
  /** Builds an element node the adapter can search inside, as a real element can be. */
  const asElement = (node: FakeElement): unknown => ({
    textContent: node.innerText,
    innerText: node.innerText,
    querySelector(selector: string) {
      return queryWithin(node.children ?? {}, selector);
    },
  });

  const queryWithin = (
    children: Readonly<Record<string, FakeElement>>,
    selector: string,
  ): unknown => {
    const stack = [children];
    while (stack.length > 0) {
      const level = stack.pop() ?? {};
      for (const [key, node] of Object.entries(level)) {
        if (key === selector) return asElement(node);
        if (node.children !== undefined) stack.push(node.children);
      }
    }
    if (selector.includes(':has(')) throw new Error(`unsupported selector: ${selector}`);
    return null;
  };

  return {
    querySelector: (selector: string) => queryWithin(tree, selector),
    body: { innerText: bodyText, textContent: bodyText } as unknown as HTMLElement,
  } as unknown as Document;
}

const PROFILE_URL = 'https://www.linkedin.com/in/jon-davies';

describe('profile URL recognition', () => {
  it('accepts profile URLs, including regional hosts', () => {
    expect(isProfileUrl('https://www.linkedin.com/in/jon-davies')).toBe(true);
    expect(isProfileUrl('https://de.linkedin.com/in/jon-davies')).toBe(true);
    expect(isProfileUrl('https://uk.linkedin.com/in/jon-davies/')).toBe(true);
  });

  it('refuses pages that are not profiles', () => {
    expect(isProfileUrl('https://www.linkedin.com/feed/')).toBe(false);
    expect(isProfileUrl('https://www.linkedin.com/company/northstar/')).toBe(false);
    expect(isProfileUrl('https://www.linkedin.com/in/')).toBe(false);
    expect(isProfileUrl('https://example.com/in/jon-davies')).toBe(false);
    expect(isProfileUrl('http://www.linkedin.com/in/jon-davies')).toBe(false);
    expect(isProfileUrl('not a url')).toBe(false);
  });
});

describe('profile extraction', () => {
  /** The two regions the adapter reads: the profile header and the first experience entry. */
  const fullProfile = {
    'main .scaffold-layout__main': {
      innerText:
        'Jon Davies Producer at Frame House New York, US Executive Producer  Frame House',
      children: {
        'h1.text-heading-xlarge': { innerText: 'Jon Davies' },
        '.text-body-medium.break-words': { innerText: 'Producer at Frame House' },
        '.text-body-small.inline.t-black--light.break-words': { innerText: 'New York, US' },
        // Two spaces: the live DOM separates title and company with a block boundary, which
        // `textContent` renders as more than one space.
        '.pvs-list__paged-list-item:first-child': { innerText: 'Executive Producer  Frame House' },
      },
    },
  };

  it('reads the fields the Companion needs', () => {
    const profile = readProfile(fakeDocument(fullProfile), PROFILE_URL, '2026-01-01T00:00:00.000Z');

    expect(profile).not.toBeNull();
    expect(profile?.fullName).toBe('Jon Davies');
    expect(profile?.headline).toBe('Producer at Frame House');
    expect(profile?.location).toBe('New York, US');
    expect(profile?.jobTitle).toBe('Executive Producer');
    expect(profile?.company).toBe('Frame House');
    expect(profile?.source).toBe('profile-main');
    expect(profile?.capturedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('falls back through the container list rather than failing', () => {
    const doc = fakeDocument({
      '#profile-content': { innerText: 'Sarah Smith', children: { h1: { innerText: 'Sarah Smith' } } },
    });
    const profile = readProfile(doc, PROFILE_URL);
    expect(profile?.fullName).toBe('Sarah Smith');
    expect(profile?.source).toBe('profile-content');
  });

  it('refuses a page that is not a profile instead of capturing it', () => {
    const doc = fakeDocument({ main: { innerText: 'Feed' } }, 'Some feed content');
    expect(readProfile(doc, 'https://www.linkedin.com/feed/')).toBeNull();
  });

  it('leaves a field null when its markup changed, rather than guessing', () => {
    // Only the container matches: every field selector has been renamed.
    const doc = fakeDocument({
      main: { innerText: 'Jon Davies', children: { '.totally-new-class': { innerText: 'Jon Davies' } } },
    });
    const profile = readProfile(doc, PROFILE_URL);

    expect(profile).not.toBeNull();
    expect(profile?.jobTitle).toBeNull();
    expect(profile?.company).toBeNull();
    // `main h1` is in the name list but this markup has no h1, so the name is unknown too.
    expect(profile?.fullName).toBeNull();
    // The raw text is still captured, which is what makes the paste fallback work.
    expect(profile?.capturedText).toContain('Jon Davies');
  });

  it('survives a selector the engine cannot parse', () => {
    // `:has()` throws on engines that do not support it; the capture must continue without it. The
    // experience entry keeps the two-space separator the live DOM has between title and company.
    const doc = fakeDocument({
      'main .scaffold-layout__main': {
        innerText: 'Mia Becker Creative Director Kite Studio',
        children: {
          h1: { innerText: 'Mia Becker' },
          '.pvs-list__paged-list-item:first-child': { innerText: 'Creative Director  Kite Studio' },
        },
      },
    });
    const profile = readProfile(doc, PROFILE_URL);
    expect(profile?.fullName).toBe('Mia Becker');
    expect(profile?.jobTitle).toBe('Creative Director');
    // The `:has()` selector throws, so the entry is read through the next candidate instead.
    expect(profile?.company).toBe('Kite Studio');
  });

  it('captures the profile region and not the surrounding page', () => {
    // The feed rail is in the body but outside the profile container: it must not be captured.
    const doc = fakeDocument(
      {
        'main .scaffold-layout__main': {
          innerText: 'Jon Davies Producer at Frame House',
          children: { h1: { innerText: 'Jon Davies' } },
        },
      },
      'Jon Davies Producer at Frame House Suggested for you · Messaging · Notifications',
    );
    const profile = readProfile(doc, PROFILE_URL);
    expect(profile?.capturedText).toContain('Jon Davies');
    expect(profile?.capturedText).not.toContain('Suggested for you');
  });

  it('bounds the captured text', () => {
    const doc = fakeDocument({ main: { innerText: 'x'.repeat(200_000) } });
    const profile = readProfile(doc, PROFILE_URL);
    expect(profile?.capturedText.length).toBe(60_000);
  });
});
