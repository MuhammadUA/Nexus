import { describe, expect, it } from 'vitest';
import {
  enrichmentStateFromFacts,
  intelligenceCompleteness,
  outreachChannelsForSource,
  searchLinks,
  type EnrichmentFacts,
  type SearchLink,
} from './enrichment.js';
import {
  CHANNELS_FOR_SOURCE,
  DISCOVERY_SOURCES,
  LEAD_SOURCE_TYPES,
  LEGACY_SOURCE_TO_DISCOVERY,
  OUTREACH_CHANNELS,
  discoverySourceFromLegacy,
  normalizeDiscoverySource,
  normalizeOutreachChannel,
} from './vocabulary.js';

/* ------------------------------------------------------------- fixtures -- */

/** A lead with every fact known — the only way to score 100. */
function facts(overrides: Partial<EnrichmentFacts> = {}): EnrichmentFacts {
  return {
    fullName: 'Sarah Miller',
    companyName: 'Acme Media',
    location: 'New York',
    jobTitle: 'Head of Marketing',
    linkedinUrl: 'https://www.linkedin.com/in/sarah-miller',
    companyWebsite: 'https://acmemedia.com',
    companyResearch: true,
    signalCount: 2,
    hasAiContext: true,
    contactCount: 1,
    ...overrides,
  };
}

const NO_FACTS: EnrichmentFacts = {
  fullName: null,
  companyName: null,
  location: null,
  jobTitle: null,
  linkedinUrl: null,
  companyWebsite: null,
  companyResearch: false,
  signalCount: 0,
  hasAiContext: false,
  contactCount: 0,
};

const ALL_LABELS = [
  'Name',
  'Company',
  'Location',
  'Job title',
  'LinkedIn URL',
  'Company website',
  'Company research',
  'Signals',
  'AI context',
  'Contact points',
];

const GOOGLE_SEARCH_ENDPOINT = 'https://www.google.com/search?q=';

function link(links: readonly SearchLink[], key: SearchLink['key']): SearchLink {
  const found = links.find((candidate) => candidate.key === key);
  if (found === undefined) {
    throw new Error(`expected a ${key} link, got: ${links.map((candidate) => candidate.key).join(', ') || '(none)'}`);
  }
  return found;
}

/* ------------------------------------------------------ completeness ----- */

describe('intelligenceCompleteness', () => {
  it('uses weights that total exactly 100', () => {
    const { components } = intelligenceCompleteness(facts());
    expect(components.map((component) => component.weight)).toEqual([12, 12, 6, 10, 14, 8, 12, 8, 10, 8]);
    expect(components.reduce((total, component) => total + component.weight, 0)).toBe(100);
  });

  it('scores a fully known lead at exactly 100 with nothing missing', () => {
    const result = intelligenceCompleteness(facts());
    expect(result.score).toBe(100);
    expect(result.missing).toEqual([]);
    expect(result.components.every((component) => component.present)).toBe(true);
    expect(result.components.map((component) => component.key)).toEqual([
      'name',
      'company',
      'location',
      'job_title',
      'linkedin',
      'company_website',
      'company_research',
      'signals',
      'ai_context',
      'contacts',
    ]);
  });

  it('adds exactly the present weights (location 6 + website 8 + signals 8 + contacts 8 removed)', () => {
    const result = intelligenceCompleteness(
      facts({ location: null, companyWebsite: null, signalCount: 0, contactCount: 0 }),
    );
    expect(result.score).toBe(70);
    expect(result.components.map((component) => component.present)).toEqual([
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(result.missing).toEqual(['Location', 'Company website', 'Signals', 'Contact points']);
  });

  it('scores an empty lead at 0 and lists every label in component order', () => {
    const result = intelligenceCompleteness(NO_FACTS);
    expect(result.score).toBe(0);
    expect(result.missing).toEqual(ALL_LABELS);
  });

  it('treats blank and whitespace-only strings as absent', () => {
    const result = intelligenceCompleteness(facts({ fullName: '   ', companyName: '', jobTitle: '\t' }));
    expect(result.score).toBe(100 - 12 - 12 - 10);
    expect(result.missing).toEqual(['Name', 'Company', 'Job title']);
  });

  it('counts one signal and one contact point as present', () => {
    expect(intelligenceCompleteness(facts({ signalCount: 1, contactCount: 1 })).score).toBe(100);
    expect(intelligenceCompleteness(facts({ signalCount: 0 })).score).toBe(92);
    expect(intelligenceCompleteness(facts({ contactCount: 0 })).score).toBe(92);
    expect(intelligenceCompleteness(facts({ hasAiContext: false })).score).toBe(90);
    expect(intelligenceCompleteness(facts({ companyResearch: false })).score).toBe(88);
    expect(intelligenceCompleteness(facts({ linkedinUrl: null })).score).toBe(86);
  });

  it('never returns a negative or over-100 score for arbitrary fact sets', () => {
    for (const value of [null, '', '   ', 'x']) {
      for (const count of [0, 1, 5]) {
        const result = intelligenceCompleteness(
          facts({ fullName: value, companyName: value, location: value, signalCount: count, contactCount: count }),
        );
        expect(Number.isInteger(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }
    }
  });
});

/* -------------------------------------------------------- search links --- */

describe('searchLinks', () => {
  it('builds the four documented query shapes, in order', () => {
    const links = searchLinks({ fullName: 'Sarah Miller', companyName: 'Acme Media', location: 'New York' });
    expect(links.map((candidate) => candidate.key)).toEqual([
      'find_linkedin',
      'search_person',
      'search_company',
      'search_signals',
    ]);
    expect(link(links, 'find_linkedin').query).toBe('"Sarah Miller" "Acme Media" site:linkedin.com/in');
    expect(link(links, 'search_person').query).toBe('"Sarah Miller" "Acme Media" "New York"');
    expect(link(links, 'search_company').query).toBe('"Acme Media" company');
    expect(link(links, 'search_signals').query).toBe('"Acme Media" hiring OR expansion OR video OR podcast');
  });

  it('URI-encodes the query onto the Google endpoint', () => {
    const links = searchLinks({ fullName: 'Sarah Miller', companyName: 'Acme Media', location: 'New York' });
    expect(link(links, 'find_linkedin').url).toBe(
      'https://www.google.com/search?q=%22Sarah%20Miller%22%20%22Acme%20Media%22%20site%3Alinkedin.com%2Fin',
    );
    expect(link(links, 'search_person').url).toBe(
      `${GOOGLE_SEARCH_ENDPOINT}%22Sarah%20Miller%22%20%22Acme%20Media%22%20%22New%20York%22`,
    );
    expect(link(links, 'search_company').url).toBe(`${GOOGLE_SEARCH_ENDPOINT}%22Acme%20Media%22%20company`);
    for (const candidate of links) {
      expect(candidate.url.startsWith(GOOGLE_SEARCH_ENDPOINT)).toBe(true);
      expect(decodeURIComponent(candidate.url.slice(GOOGLE_SEARCH_ENDPOINT.length))).toBe(candidate.query);
    }
  });

  it('encodes characters that would otherwise break the URL', () => {
    const links = searchLinks({ fullName: 'Ana Muñoz & Co', companyName: 'R&D Labs' });
    const find = link(links, 'find_linkedin');
    expect(find.query).toBe('"Ana Muñoz & Co" "R&D Labs" site:linkedin.com/in');
    expect(find.url).toBe(`${GOOGLE_SEARCH_ENDPOINT}${encodeURIComponent(find.query)}`);
    expect(find.url).toContain('%26'); // ampersand
    expect(find.url).not.toContain(' ');
  });

  it('omits the location segment when the location is unknown', () => {
    const links = searchLinks({ fullName: 'Sarah Miller', companyName: 'Acme Media' });
    expect(link(links, 'search_person').query).toBe('"Sarah Miller" "Acme Media"');
  });

  it('omits the company segment when the company is unknown', () => {
    const links = searchLinks({ fullName: 'Sarah Miller', location: 'New York' });
    expect(link(links, 'find_linkedin').query).toBe('"Sarah Miller" site:linkedin.com/in');
    expect(link(links, 'search_person').query).toBe('"Sarah Miller" "New York"');
    expect(links.some((candidate) => candidate.key === 'search_company')).toBe(false);
    expect(links.some((candidate) => candidate.key === 'search_signals')).toBe(false);
  });

  it('omits every company link when there is no company at all', () => {
    const links = searchLinks({ fullName: 'Sarah Miller' });
    expect(links.map((candidate) => candidate.key)).toEqual(['find_linkedin', 'search_person']);
  });

  it('returns nothing when there is nothing to search for', () => {
    expect(searchLinks({})).toEqual([]);
    expect(searchLinks({ fullName: '  ', companyName: '', location: null })).toEqual([]);
  });

  it('appends a supplied LinkedIn URL to find_linkedin as a trailing term', () => {
    const links = searchLinks({
      fullName: 'Sarah Miller',
      companyName: 'Acme Media',
      linkedinUrl: 'https://www.linkedin.com/in/sarah-miller',
    });
    expect(link(links, 'find_linkedin').query).toBe(
      '"Sarah Miller" "Acme Media" site:linkedin.com/in "https://www.linkedin.com/in/sarah-miller"',
    );
  });

  it('still confirms identity when only a LinkedIn URL is known', () => {
    const links = searchLinks({ linkedinUrl: 'https://www.linkedin.com/in/sarah-miller' });
    expect(links.map((candidate) => candidate.key)).toEqual(['find_linkedin']);
    expect(link(links, 'find_linkedin').query).toBe(
      'site:linkedin.com/in "https://www.linkedin.com/in/sarah-miller"',
    );
  });

  it('trims terms and drops empty ones', () => {
    const links = searchLinks({ fullName: '  Sarah Miller  ', companyName: '   ', location: '' });
    expect(link(links, 'find_linkedin').query).toBe('"Sarah Miller" site:linkedin.com/in');
    expect(link(links, 'search_person').query).toBe('"Sarah Miller"');
  });

  it('falls back to the company domain when no company name was captured', () => {
    const links = searchLinks({ companyDomain: 'acmemedia.com' });
    expect(link(links, 'search_company').query).toBe('"acmemedia.com" company');
    expect(link(links, 'search_signals').query).toBe(
      '"acmemedia.com" hiring OR expansion OR video OR podcast',
    );
    expect(links.some((candidate) => candidate.key === 'find_linkedin')).toBe(false);
  });

  it('strips embedded double quotes so the operator grouping stays well-formed', () => {
    const links = searchLinks({ fullName: 'Sarah "SM" Miller' });
    expect(link(links, 'find_linkedin').query).toBe('"Sarah SM Miller" site:linkedin.com/in');
  });
});

/* -------------------------------------------------- enrichment state ----- */

describe('enrichmentStateFromFacts', () => {
  it('rule 1: needs a profile when there is no LinkedIn URL and no company research', () => {
    expect(
      enrichmentStateFromFacts(
        facts({ linkedinUrl: null, companyWebsite: null, companyResearch: false, hasAiContext: false }),
      ),
    ).toBe('NEEDS_PROFILE');
  });

  it('rule 2: company research is pending when the person is identified but the company is not', () => {
    expect(
      enrichmentStateFromFacts(facts({ companyWebsite: null, companyResearch: false, hasAiContext: false })),
    ).toBe('COMPANY_RESEARCH_PENDING');
  });

  it('rule 3: company research present without a context pack is PROFILE_READY, never AI_PROCESSING', () => {
    const state = enrichmentStateFromFacts(facts({ hasAiContext: false }));
    expect(state).toBe('PROFILE_READY');
    expect(state).not.toBe('AI_PROCESSING');
  });

  it('rule 4: a cached context pack with a score of at least 70 is READY', () => {
    expect(enrichmentStateFromFacts(facts())).toBe('READY');
    // exactly 70: company research (12) + signals (8) + AI context (10) + name (12)
    // + company (12) + linkedin (14) + job title (10) + contacts (8) - location/website absent
    expect(intelligenceCompleteness(facts({ hasAiContext: true, signalCount: 1 })).score).toBeGreaterThanOrEqual(70);
    expect(enrichmentStateFromFacts(facts({ signalCount: 1 }))).toBe('READY');
  });

  it('rule 4 boundary: 69 is not READY, 70 is', () => {
    const atThreshold = facts({
      hasAiContext: true,
      location: null,
      companyWebsite: null,
      signalCount: 1,
      contactCount: 1,
      jobTitle: null,
    });
    // 100 - 6 (location) - 8 (website) - 10 (job title) = 76 -> READY
    expect(intelligenceCompleteness(atThreshold).score).toBe(76);
    expect(enrichmentStateFromFacts(atThreshold)).toBe('READY');

    const belowThreshold = facts({
      hasAiContext: true,
      location: null,
      companyWebsite: null,
      signalCount: 0,
      contactCount: 0,
      jobTitle: null,
    });
    // 100 - 6 - 8 - 10 - 8 (signals) - 8 (contacts) = 60 -> PROFILE_READY
    expect(intelligenceCompleteness(belowThreshold).score).toBe(60);
    expect(enrichmentStateFromFacts(belowThreshold)).toBe('PROFILE_READY');
  });

  it('never returns a pipeline-owned state, whatever the facts', () => {
    const specimens: EnrichmentFacts[] = [
      NO_FACTS,
      facts(),
      facts({ hasAiContext: false }),
      facts({ linkedinUrl: null, companyResearch: false }),
      facts({ companyWebsite: null }),
      facts({ fullName: null, companyName: null }),
      facts({ signalCount: 0, contactCount: 0, hasAiContext: false }),
    ];
    const derivable = ['NEEDS_PROFILE', 'COMPANY_RESEARCH_PENDING', 'PROFILE_READY', 'READY'];
    for (const specimen of specimens) {
      const state = enrichmentStateFromFacts(specimen);
      expect(derivable).toContain(state);
      expect(state).not.toBe('MINIMAL');
      expect(state).not.toBe('AGENT_RESEARCH_PENDING');
      expect(state).not.toBe('NEEDS_REVIEW');
      expect(state).not.toBe('FAILED');
      expect(state).not.toBe('AI_PROCESSING');
    }
  });

  it('rule 5 fallback: a fact-poor lead lands on PROFILE_READY (MINIMAL belongs to ingestion)', () => {
    expect(enrichmentStateFromFacts(NO_FACTS)).toBe('PROFILE_READY');
  });

  it('does not move backwards when facts are added (monotone in the rule order)', () => {
    expect(
      enrichmentStateFromFacts(facts({ companyWebsite: null, companyResearch: false, hasAiContext: false })),
    ).toBe('COMPANY_RESEARCH_PENDING');
    expect(enrichmentStateFromFacts(facts({ companyWebsite: null, hasAiContext: false }))).toBe('PROFILE_READY');
    expect(enrichmentStateFromFacts(facts())).toBe('READY');
  });
});

/* ------------------------------------------------------ source mapping --- */

describe('normalizeDiscoverySource', () => {
  it('maps the documented free-text examples', () => {
    expect(normalizeDiscoverySource('LinkedIn manual import')).toBe('linkedin');
    expect(normalizeDiscoverySource('reddit')).toBe('reddit');
    expect(normalizeDiscoverySource('file_csv')).toBe('csv');
    expect(normalizeDiscoverySource('')).toBe('other');
    expect(normalizeDiscoverySource(null)).toBe('other');
    expect(normalizeDiscoverySource(undefined)).toBe('other');
  });

  it('is case- and separator-insensitive', () => {
    expect(normalizeDiscoverySource('  REDDIT ')).toBe('reddit');
    expect(normalizeDiscoverySource('Job Board')).toBe('job_board');
    expect(normalizeDiscoverySource('job-board')).toBe('job_board');
    expect(normalizeDiscoverySource('LinkedIn')).toBe('linkedin');
    expect(normalizeDiscoverySource('FILE_XLSX')).toBe('csv');
    expect(normalizeDiscoverySource('xlsx import')).toBe('csv');
  });

  it('handles every legacy V1.1 value', () => {
    for (const legacy of LEAD_SOURCE_TYPES) {
      expect(normalizeDiscoverySource(legacy)).toBe(LEGACY_SOURCE_TO_DISCOVERY[legacy]);
    }
    expect(normalizeDiscoverySource('manual_companion')).toBe('companion');
    expect(normalizeDiscoverySource('research_agent')).toBe('web');
    expect(normalizeDiscoverySource('external_ingest')).toBe('other');
    expect(normalizeDiscoverySource('mcp_agent')).toBe('mcp');
  });

  it('always returns a value from DISCOVERY_SOURCES', () => {
    const inputs = [
      'Reddit /r/marketing',
      'Chrome extension',
      'company website',
      'Apollo (basic)',
      'agency referral',
      'carrier pigeon',
      '   ',
      null,
    ];
    for (const input of inputs) {
      expect(DISCOVERY_SOURCES).toContain(normalizeDiscoverySource(input));
    }
    expect(normalizeDiscoverySource('agency referral')).toBe('other');
    expect(normalizeDiscoverySource('carrier pigeon')).toBe('other');
  });

  it('agrees with discoverySourceFromLegacy', () => {
    for (const legacy of LEAD_SOURCE_TYPES) {
      expect(discoverySourceFromLegacy(legacy)).toBe(normalizeDiscoverySource(legacy));
    }
    expect(discoverySourceFromLegacy('not-a-source')).toBe('other');
    expect(discoverySourceFromLegacy(null)).toBe('other');
    expect(discoverySourceFromLegacy('reddit')).toBe('reddit');
  });
});

describe('CHANNELS_FOR_SOURCE', () => {
  it('pairs every discovery source with all four channels', () => {
    expect(OUTREACH_CHANNELS).toEqual(['linkedin', 'email', 'instagram', 'upwork']);
    for (const source of DISCOVERY_SOURCES) {
      expect(CHANNELS_FOR_SOURCE[source]).toEqual(['linkedin', 'email', 'instagram', 'upwork']);
      expect(outreachChannelsForSource(source)).toHaveLength(OUTREACH_CHANNELS.length);
    }
  });

  it('does not restrict a Reddit-discovered lead to any channel', () => {
    const source = normalizeDiscoverySource('reddit');
    expect(source).toBe('reddit');
    expect(outreachChannelsForSource(source)).toEqual(['linkedin', 'email', 'instagram', 'upwork']);
    // The claim under test: discovery never dictates channel.
    expect(outreachChannelsForSource(source)).toEqual([...outreachChannelsForSource('linkedin')]);
  });
});

describe('normalizeOutreachChannel', () => {
  it('passes through the four canonical channels', () => {
    for (const channel of OUTREACH_CHANNELS) {
      expect(normalizeOutreachChannel(channel)).toBe(channel);
      expect(normalizeOutreachChannel(channel.toUpperCase())).toBe(channel);
    }
  });

  it('resolves LinkedIn-ish, Instagram-ish and email-ish free text', () => {
    expect(normalizeOutreachChannel('LinkedIn Sales Navigator')).toBe('linkedin');
    expect(normalizeOutreachChannel('li')).toBe('linkedin');
    expect(normalizeOutreachChannel('Gmail')).toBe('email');
    expect(normalizeOutreachChannel('Outlook Web')).toBe('email');
    expect(normalizeOutreachChannel('Instagram DM')).toBe('instagram');
    expect(normalizeOutreachChannel('ig')).toBe('instagram');
    expect(normalizeOutreachChannel('Upwork message')).toBe('upwork');
  });

  it('returns null for a real contact route this pipeline cannot send through', () => {
    expect(normalizeOutreachChannel('phone')).toBeNull();
    expect(normalizeOutreachChannel('twitter')).toBeNull();
    expect(normalizeOutreachChannel('carrier pigeon')).toBeNull();
    expect(normalizeOutreachChannel('')).toBeNull();
    expect(normalizeOutreachChannel('   ')).toBeNull();
    expect(normalizeOutreachChannel(null)).toBeNull();
    expect(normalizeOutreachChannel(undefined)).toBeNull();
  });
});
