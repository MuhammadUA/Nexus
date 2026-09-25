import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  collapseWhitespace,
  contentHash,
  deriveIdempotencyKey,
  normalizeCompanyName,
  normalizeDomain,
  normalizeDomainKey,
  normalizeEmail,
  normalizeJobTitle,
  normalizeLinkedInKey,
  normalizeLinkedInUrl,
  normalizePersonName,
  normalizePhone,
  normalizeText,
  sha256Hex,
  slugify,
  wordCount,
} from './normalize.js';

describe('sha256', () => {
  it('matches the known NIST vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('handles multi-byte UTF-8 by encoding to real UTF-8 bytes', () => {
    // SHA-256 of U+2014 EM DASH (UTF-8 E2 80 94) — independently verifiable.
    expect(sha256Hex('—')).toBe('bda050585a00f0f6cb502350559d75532ae3b244c9498b996e7c5df2d98dfc8d');
    expect(sha256Hex('Zemnas — studio')).toBe(
      'c0160a30ad8bca701861b5102f340ced0b19151103618f8bb0729a6bf002c3e8',
    );
  });

  it('distinguishes multi-byte content from its ASCII lookalike', () => {
    expect(sha256Hex('Zemnas — studio')).not.toBe(
      '2a45022064b33d02c9d3d4159ec017b7d833bde156f641ebe3c4d5b888e2de7c',
    );
  });

  it('produces 64 hex characters for every input length, including block boundaries', () => {
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1000]) {
      const hash = sha256Hex('a'.repeat(n));
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('collapseWhitespace / normalizeText', () => {
  it('collapses runs and strips zero-width characters', () => {
    expect(collapseWhitespace('  Tom\u200b   Henry \n ')).toBe('Tom Henry');
  });

  it('lowercases, strips diacritics and punctuation', () => {
    expect(normalizeText('Mia  Bëcker, GmbH!')).toBe('mia becker gmbh');
  });

  it('keeps semantic characters used in company names', () => {
    expect(normalizeText('Northstar & Co.')).toBe('northstar & co.');
  });
});

describe('normalizeLinkedInUrl', () => {
  const cases: Array<[string, string | null]> = [
    ['https://www.linkedin.com/in/tom-henry', 'https://www.linkedin.com/in/tom-henry'],
    ['https://www.linkedin.com/in/tom-henry/', 'https://www.linkedin.com/in/tom-henry'],
    ['http://linkedin.com/in/Tom-Henry', 'https://www.linkedin.com/in/tom-henry'],
    ['linkedin.com/in/tom-henry', 'https://www.linkedin.com/in/tom-henry'],
    ['//www.linkedin.com/in/tom-henry', 'https://www.linkedin.com/in/tom-henry'],
    ['https://de.linkedin.com/in/tom-henry', 'https://www.linkedin.com/in/tom-henry'],
    ['https://m.linkedin.com/in/tom-henry', 'https://www.linkedin.com/in/tom-henry'],
    ['https://uk.linkedin.com/in/tom-henry', 'https://www.linkedin.com/in/tom-henry'],
    // tracking / query variants must normalize to the same key
    ['https://www.linkedin.com/in/tom-henry?trk=public_profile_browsemap', 'https://www.linkedin.com/in/tom-henry'],
    [
      'https://www.linkedin.com/in/tom-henry/?originalSubdomain=uk&trk=people-guest',
      'https://www.linkedin.com/in/tom-henry',
    ],
    [
      'https://www.linkedin.com/in/tom-henry?utm_source=newsletter&utm_medium=email&utm_campaign=x',
      'https://www.linkedin.com/in/tom-henry',
    ],
    // deep links
    [
      'https://www.linkedin.com/in/tom-henry/detail/recent-activity/',
      'https://www.linkedin.com/in/tom-henry',
    ],
    // percent-encoded
    ['https://www.linkedin.com/in/tom%2Dhenry', 'https://www.linkedin.com/in/tom-henry'],
    // whitespace and export noise
    ['  <https://www.linkedin.com/in/tom-henry>  ', 'https://www.linkedin.com/in/tom-henry'],
    // non-LinkedIn must yield null
    ['https://twitter.com/tomhenry', null],
    ['https://www.google.com/search?q=tom', null],
    ['not a url at all', null],
    ['', null],
  ];

  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input)}`, () => {
      expect(normalizeLinkedInUrl(input).canonicalUrl).toBe(expected);
    });
  }

  it('returns the member slug for parsed profiles', () => {
    const r = normalizeLinkedInUrl('https://www.linkedin.com/in/tom-henry?trk=x');
    expect(r.memberSlug).toBe('tom-henry');
    expect(r.isLinkedInButUnparsed).toBe(false);
    expect(r.host).toBe('linkedin.com');
  });

  it('flags a LinkedIn URL with no member slug as unparsed rather than inventing a key', () => {
    const r = normalizeLinkedInUrl('https://www.linkedin.com/feed/');
    expect(r.canonicalUrl).toBeNull();
    expect(r.isLinkedInButUnparsed).toBe(true);
  });

  it('keeps lnkd.in short links usable but never as the person dedupe key', () => {
    const r = normalizeLinkedInUrl('https://lnkd.in/abc123');
    expect(r.canonicalUrl).toBe('https://lnkd.in/abc123');
    expect(r.memberSlug).toBeNull();
    // And crucially the convenience key helper refuses to use it.
    expect(normalizeLinkedInKey('https://lnkd.in/abc123')).toBe('https://lnkd.in/abc123');
  });

  it('is idempotent', () => {
    const once = normalizeLinkedInUrl('https://de.linkedin.com/in/tom-henry?trk=a&utm_source=b').canonicalUrl;
    const twice = normalizeLinkedInUrl(once).canonicalUrl;
    expect(twice).toBe(once);
  });

  it('preserves non-tracking query parameters deterministically', () => {
    const a = normalizeLinkedInUrl('https://www.linkedin.com/in/x?b=2&a=1&trk=z').canonicalUrl;
    const b = normalizeLinkedInUrl('https://www.linkedin.com/in/x?a=1&b=2').canonicalUrl;
    expect(a).toBe(b);
  });
});

describe('normalizeDomain', () => {
  it('extracts registrable domains from URLs, bare hosts and emails', () => {
    expect(normalizeDomainKey('https://www.zemnas.com/about')).toBe('zemnas.com');
    expect(normalizeDomainKey('zemnas.com')).toBe('zemnas.com');
    expect(normalizeDomainKey('Tom Henry <tom@zemnas.com>')).toBe('zemnas.com');
    expect(normalizeDomainKey('tom@zemnas.com')).toBe('zemnas.com');
    expect(normalizeDomainKey('careers.zemnas.com')).toBe('zemnas.com');
  });

  it('handles multi-part public suffixes', () => {
    expect(normalizeDomainKey('www.lavishfoods.co.uk')).toBe('lavishfoods.co.uk');
    expect(normalizeDomainKey('shop.lavishfoods.com.pk')).toBe('lavishfoods.com.pk');
    expect(normalizeDomainKey('a.b.example.com.au')).toBe('example.com.au');
  });

  it('refuses free mailbox providers as company domains', () => {
    expect(normalizeDomainKey('gmail.com')).toBeNull();
    expect(normalizeDomainKey('tom.henry@gmail.com')).toBeNull();
    const r = normalizeDomain('tom.henry@outlook.com');
    expect(r.isFreeMail).toBe(true);
    expect(r.domain).toBe('outlook.com');
  });

  it('rejects hosts that are not real domains', () => {
    expect(normalizeDomainKey('localhost')).toBeNull();
    expect(normalizeDomainKey('')).toBeNull();
    expect(normalizeDomainKey('not a domain')).toBeNull();
  });
});

describe('name / title / email / phone normalization', () => {
  it('normalizes person names and drops trailing credentials', () => {
    expect(normalizePersonName('  Mia Bëcker ')).toBe('mia becker');
    expect(normalizePersonName('Tom Henry (PMP)')).toBe('tom henry');
    expect(normalizePersonName('Sarah Smith MBA')).toBe('sarah smith');
    expect(normalizePersonName('Jon Davies Jr')).toBe('jon davies');
    // A name that is only a credential must not collapse to empty.
    expect(normalizePersonName('Jr')).toBe('jr');
  });

  it('normalizes company names and strips legal suffixes', () => {
    expect(normalizeCompanyName('Frame House Ltd.')).toBe('frame house');
    expect(normalizeCompanyName('Nova Haus GmbH')).toBe('nova haus');
    expect(normalizeCompanyName('ABC Media, Inc.')).toBe('abc media');
    // A company whose entire name is a suffix keeps something usable.
    expect(normalizeCompanyName('Group')).toBe('group');
  });

  it('normalizes job titles by removing seniority noise', () => {
    expect(normalizeJobTitle('Senior Video Editor')).toBe('video editor');
    expect(normalizeJobTitle('Head of Content')).toBe('content');
    expect(normalizeJobTitle('Post Production Lead')).toBe('post production');
  });

  it('normalizes emails and phones', () => {
    expect(normalizeEmail('Tom Henry <TOM@Zemnas.COM>')).toBe('tom@zemnas.com');
    expect(normalizeEmail('no-email')).toBeNull();
    expect(normalizePhone('+49 (0) 30 1234 567')).toBe('+490301234567');
    expect(normalizePhone('123')).toBeNull();
  });
});

describe('content hashing and idempotency', () => {
  it('canonicalizes key order so equivalent payloads hash identically', () => {
    const a = { b: 1, a: [1, 2, { d: 4, c: 3 }] };
    const b = { a: [1, 2, { c: 3, d: 4 }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('changes the hash when the payload changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('drops undefined values rather than hashing them as null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('derives a stable idempotency key from the required envelope fields', () => {
    const base = {
      sourceClient: 'chatgpt',
      businessKeyOrId: 'zemnas',
      payloadType: 'candidate',
      payload: { full_name: 'Tom Henry' },
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(deriveIdempotencyKey(base)).toBe(deriveIdempotencyKey({ ...base }));
    expect(deriveIdempotencyKey(base)).not.toBe(
      deriveIdempotencyKey({ ...base, observedAt: '2026-01-02T00:00:00.000Z' }),
    );
    expect(deriveIdempotencyKey(base)).not.toBe(
      deriveIdempotencyKey({ ...base, sourceClient: 'opencode' }),
    );
  });
});

describe('slugify and wordCount', () => {
  it('slugifies business names for /b/:businessSlug routes', () => {
    expect(slugify('Zemnas Creative Studio')).toBe('zemnas-creative-studio');
    expect(slugify('  Lavish  Foods!! ')).toBe('lavish-foods');
    expect(slugify('AI Integrations')).toBe('ai-integrations');
  });

  it('caps slug length', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it('counts words ignoring extra whitespace', () => {
    expect(wordCount('  one   two \n three ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});
