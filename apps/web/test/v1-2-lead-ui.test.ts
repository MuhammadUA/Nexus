import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { searchLinks } from '@nexus/core';

/*
 * The render block at the bottom of this file boots the real schema and renders both V1.2
 * screens, so the SQL this workstream added is *executed* rather than only type-checked.
 *
 * Two mocks make that possible outside a Next.js request:
 *
 *   * `next/headers` — the session cookie the page reads to resolve the viewer;
 *   * `next/navigation` — `notFound()`/`redirect()` throw in the probe, so a screen that
 *     silently fell into an empty state or a bounce would fail loudly, and `useRouter`
 *     exists because the client filter bar calls it during server rendering.
 */
const cookieJar: { value: string } = { value: '' };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'nx_session' ? { value: cookieJar.value } : undefined),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
  notFound: () => {
    throw new Error('probe: notFound() was called');
  },
  redirect: (url: string) => {
    throw new Error(`probe: redirect(${url}) was called`);
  },
}));

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import LeadDetailPage from '@/app/b/[slug]/leads/[id]/page';
import LeadsPage from '@/app/b/[slug]/leads/page';
import { issueSession } from '@/lib/session';

import { createAppHarness, type AppHarness } from './harness';

import {
  briefConfidence,
  buildOpportunityBrief,
  discoverySourceLabel,
  enrichmentIsIncomplete,
  enrichmentStateAccent,
  enrichmentStateLabel,
  flattenPackSummary,
  intelligenceLabel,
  missingFieldsText,
  outreachChannelLabel,
  readPackString,
  storedSourceValuesFor,
  type BriefSignal,
} from '@/components/lead-intelligence-brief';
import {
  missingSearchLinks,
  processingSteps,
  type ProcessingStep,
} from '@/components/lead-enrichment-workspace';
import {
  accountForChannel,
  channelOutreachRows,
  contactPointProvenanceLabel,
  winningContactPoint,
  type ChannelAccountView,
  type ContactPointView,
} from '@/components/lead-channel-outreach';

/*
 * The vitest transform uses the *classic* JSX runtime, because `apps/web/tsconfig.json` sets
 * `jsx: preserve` for Next.js. Next compiles these screens with the automatic runtime, so a
 * page correctly does not import React — but under this runner `React.createElement` has to
 * resolve somewhere. Publishing it globally keeps the render probe honest: no product file
 * changes are needed to make the screens testable.
 */
(globalThis as unknown as { React: unknown }).React = React;

/**
 * V1.2 Lead UI — the pure derivations.
 *
 * Every assertion here is a spec requirement that a screen could otherwise get wrong
 * silently:
 *
 *   * §29.1/§29.2 — a score is never rendered without its missing pieces;
 *   * §30.3/§30.4 — the generated queries are deterministic and their preconditions are
 *     named rather than silently skipped;
 *   * §53.5 — the brief's confidence is derived, reproducible and bounded;
 *   * §53.4 — a brief with no pack or no signals says so;
 *   * §59.6/§54.3 — the pack body is projected over bounded keys, never paraphrased;
 *   * §67.2 — the processing steps are named states with exactly one current step;
 *   * §20.1/§20.2/§26.2 — channels come from accounts and contact points, the discovery
 *     source never restricts them, and a confirmed contact point wins.
 */

function signal(overrides: Partial<BriefSignal> = {}): BriefSignal {
  return {
    id: 'signal-1',
    kind: 'hiring',
    label: 'Hiring a video editor',
    detail: null,
    polarity: 'positive',
    strength: 60,
    observedAt: '2026-01-05T09:00:00.000Z',
    sourceUrl: 'https://example.com/jobs',
    collectorAgent: 'opencode',
    contentHash: 'abc123',
    ...overrides,
  };
}

const stepStates = (steps: readonly ProcessingStep[]): string =>
  steps.map((step) => `${step.key}:${step.state}`).join(',');

describe('intelligence display (§29)', () => {
  it('renders the score as a percentage with the V1.2 wording', () => {
    expect(intelligenceLabel(35)).toBe('Lead intelligence 35%');
    expect(intelligenceLabel(100)).toBe('Lead intelligence 100%');
  });

  it('clamps a score that is out of range or not a number', () => {
    expect(intelligenceLabel(-10)).toBe('Lead intelligence 0%');
    expect(intelligenceLabel(140)).toBe('Lead intelligence 100%');
    expect(intelligenceLabel(Number.NaN)).toBe('Lead intelligence 0%');
  });

  it('names every missing component with its display label, in the stored order', () => {
    expect(missingFieldsText(['linkedin', 'company_research', 'signals', 'ai_context', 'contacts'])).toBe(
      'missing: LinkedIn URL, company research, signals, AI context, contact points',
    );
  });

  it('returns null when nothing is missing, so a complete score is not decorated', () => {
    expect(missingFieldsText([])).toBeNull();
  });

  it('falls back to the machine key for a component it does not know', () => {
    expect(missingFieldsText(['some_future_component'])).toBe('missing: some_future_component');
  });

  it('labels all nine enrichment states distinctly', () => {
    const labels = [
      'MINIMAL',
      'NEEDS_PROFILE',
      'PROFILE_READY',
      'COMPANY_RESEARCH_PENDING',
      'AGENT_RESEARCH_PENDING',
      'AI_PROCESSING',
      'READY',
      'NEEDS_REVIEW',
      'FAILED',
    ].map((state) => enrichmentStateLabel(state));
    expect(new Set(labels).size).toBe(9);
    expect(labels[0]).toBe('Minimal');
    expect(labels[8]).toBe('Failed');
  });

  it('maps an unknown state to its own words rather than throwing', () => {
    expect(enrichmentStateLabel('SOMETHING_NEW')).toBe('SOMETHING NEW');
  });

  it('uses red only for the two states a human must act on, and green only for ready', () => {
    expect(enrichmentStateAccent('READY')).toBe('green');
    expect(enrichmentStateAccent('FAILED')).toBe('red');
    expect(enrichmentStateAccent('NEEDS_REVIEW')).toBe('red');
    expect(enrichmentStateAccent('COMPANY_RESEARCH_PENDING')).toBe('amber');
    expect(enrichmentStateAccent('AI_PROCESSING')).toBe('cyan');
  });

  it('offers the workspace for exactly the four incomplete states', () => {
    expect(enrichmentIsIncomplete('MINIMAL')).toBe(true);
    expect(enrichmentIsIncomplete('NEEDS_PROFILE')).toBe(true);
    expect(enrichmentIsIncomplete('FAILED')).toBe(true);
    expect(enrichmentIsIncomplete('NEEDS_REVIEW')).toBe(true);
    expect(enrichmentIsIncomplete('READY')).toBe(false);
    expect(enrichmentIsIncomplete('AI_PROCESSING')).toBe(false);
  });
});

describe('discovery source projection (§18)', () => {
  it('filters one V1.2 source across both vocabularies', () => {
    const google = storedSourceValuesFor('google');
    expect(google).toContain('google');
    expect(google).toContain('google_search');
  });

  it('returns the bare value for a source with no legacy spelling', () => {
    expect(storedSourceValuesFor('reddit')).toEqual(['reddit']);
    expect(storedSourceValuesFor('upwork')).toEqual(['upwork']);
  });

  it('never repeats a value', () => {
    const values = storedSourceValuesFor('csv');
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain('file_csv');
    expect(values).toContain('file_xlsx');
  });

  it('labels a source for display without inventing one', () => {
    expect(discoverySourceLabel('job_board')).toBe('Job board');
    expect(discoverySourceLabel('other')).toBe('Other');
    expect(discoverySourceLabel('not_a_source')).toBe('not a source');
  });

  it('labels the four outreach channels', () => {
    expect(['linkedin', 'email', 'instagram', 'upwork'].map(outreachChannelLabel)).toEqual([
      'LinkedIn',
      'Email',
      'Instagram',
      'Upwork',
    ]);
  });
});

describe('deterministic search links (§30)', () => {
  const facts = {
    fullName: 'Sarah Miller',
    companyName: 'Acme Media',
    location: 'New York',
  };

  it('builds the four spec query shapes, encoded, with no invented terms', () => {
    const links = searchLinks(facts);
    const byKey = new Map(links.map((link) => [link.key, link]));

    expect(byKey.get('find_linkedin')?.query).toBe('"Sarah Miller" "Acme Media" site:linkedin.com/in');
    expect(byKey.get('search_person')?.query).toBe('"Sarah Miller" "Acme Media" "New York"');
    expect(byKey.get('search_company')?.query).toBe('"Acme Media" company');
    expect(byKey.get('search_signals')?.query).toBe(
      '"Acme Media" hiring OR expansion OR video OR podcast',
    );
  });

  it('URL-encodes the query rather than concatenating it', () => {
    const link = searchLinks(facts).find((entry) => entry.key === 'find_linkedin');
    expect(link?.url).toBe(
      `https://www.google.com/search?q=${encodeURIComponent('"Sarah Miller" "Acme Media" site:linkedin.com/in')}`,
    );
    expect(link?.url).not.toContain('"');
  });

  it('omits a term that is absent instead of leaving a placeholder', () => {
    const person = searchLinks({ fullName: 'Sarah Miller', companyName: null, location: null });
    const searchPerson = person.find((entry) => entry.key === 'search_person');
    expect(searchPerson?.query).toBe('"Sarah Miller"');
    expect(searchPerson?.query).not.toContain('""');
    expect(searchPerson?.query).not.toContain('null');
    // §30.3.5 — the company actions need a company.
    expect(person.some((entry) => entry.key === 'search_company')).toBe(false);
    expect(person.some((entry) => entry.key === 'search_signals')).toBe(false);
  });

  it('falls back to the company domain when no name was supplied', () => {
    const links = searchLinks({ fullName: null, companyName: null, companyDomain: 'acme.com' });
    expect(links.some((entry) => entry.key === 'search_company')).toBe(true);
    expect(links.some((entry) => entry.key === 'find_linkedin')).toBe(false);
  });

  it('names the missing field for each action that cannot be built (§30.3.4)', () => {
    const missing = missingSearchLinks({ fullName: null, companyName: null, location: null });
    const byKey = new Map(missing.map((entry) => [entry.key, entry.reason]));
    expect(byKey.get('find_linkedin')).toBe('person name is missing');
    expect(byKey.get('search_person')).toBe('person name is missing');
    expect(byKey.get('search_company')).toBe('company is missing');
    expect(byKey.get('search_signals')).toBe('company is missing');
  });

  it('reports the specific missing fact, not a generic failure', () => {
    const missing = missingSearchLinks({ fullName: 'Sarah Miller', companyName: null, location: null });
    const byKey = new Map(missing.map((entry) => [entry.key, entry.reason]));
    expect(byKey.has('find_linkedin')).toBe(false);
    expect(byKey.get('search_person')).toBe('company or location is missing');
  });

  it('reports nothing missing when every link can be built', () => {
    expect(missingSearchLinks(facts)).toEqual([]);
  });
});

describe('brief confidence (§53.5)', () => {
  const base = {
    signalCount: 0,
    averagePositiveStrength: 0,
    icpFit: null,
    completenessScore: 0,
    packAgeDays: null,
  };

  it('is reproducible: the same inputs give the same number', () => {
    const input = { ...base, signalCount: 3, averagePositiveStrength: 70, icpFit: 80, completenessScore: 65, packAgeDays: 3 };
    expect(briefConfidence(input).score).toBe(briefConfidence(input).score);
    expect(briefConfidence(input).components.map((component) => component.points)).toEqual(
      briefConfidence(input).components.map((component) => component.points),
    );
  });

  it('never exceeds 100 and never goes below 0', () => {
    const maximal = briefConfidence({
      signalCount: 40,
      averagePositiveStrength: 100,
      icpFit: 100,
      completenessScore: 100,
      packAgeDays: 0,
    });
    expect(maximal.score).toBeLessThanOrEqual(100);
    expect(maximal.score).toBeGreaterThan(0);
    expect(briefConfidence(base).score).toBe(0);
    expect(briefConfidence({ ...base, averagePositiveStrength: -50, icpFit: -20 }).score).toBe(0);
  });

  it('rises with signals, fit and completeness, never falls', () => {
    const none = briefConfidence(base).score;
    const signals = briefConfidence({ ...base, signalCount: 3 }).score;
    const fit = briefConfidence({ ...base, icpFit: 90 }).score;
    const complete = briefConfidence({ ...base, completenessScore: 90 }).score;
    expect(signals).toBeGreaterThan(none);
    expect(fit).toBeGreaterThan(none);
    expect(complete).toBeGreaterThan(none);
    expect(
      briefConfidence({ signalCount: 5, averagePositiveStrength: 100, icpFit: 100, completenessScore: 100, packAgeDays: 1 }).score,
    ).toBeGreaterThan(signals);
  });

  it('discounts a stale context pack rather than treating it as fresh', () => {
    const fresh = briefConfidence({ ...base, signalCount: 2, packAgeDays: 2 });
    const month = briefConfidence({ ...base, signalCount: 2, packAgeDays: 20 });
    const old = briefConfidence({ ...base, signalCount: 2, packAgeDays: 400 });
    expect(fresh.score).toBeGreaterThan(month.score);
    expect(month.score).toBeGreaterThan(old.score);
  });

  it('crosses its three levels at fixed thresholds', () => {
    expect(briefConfidence({ ...base, signalCount: 5, averagePositiveStrength: 100, icpFit: 100, completenessScore: 100, packAgeDays: 1 }).level).toBe('high');
    expect(briefConfidence({ ...base, signalCount: 3, icpFit: 60, completenessScore: 60, packAgeDays: 10 }).level).toBe('medium');
    expect(briefConfidence(base).level).toBe('low');
  });

  it('explains itself with named components rather than a model sentence', () => {
    const assessment = briefConfidence({ ...base, signalCount: 4, icpFit: 50, completenessScore: 50, packAgeDays: 5 });
    expect(assessment.components.map((component) => component.key)).toEqual([
      'signals',
      'signal_strength',
      'icp_fit',
      'completeness',
      'pack_recency',
    ]);
    expect(assessment.reasons).toHaveLength(5);
    expect(assessment.reasons.join(' ')).toContain('ICP fit');
  });
});

describe('opportunity brief (§53.4, §69.3)', () => {
  const base = {
    leadName: 'Sarah Miller',
    leadTitle: 'Head of Content',
    companyName: 'Acme Media',
    primaryIcpName: 'Media agency',
    icpFit: 82,
    icpReason: 'produces video in-house',
    completenessScore: 65,
    missingFields: ['ai_context'],
    signals: [],
    pack: null,
    availableChannels: [],
    now: new Date('2026-02-01T00:00:00.000Z'),
  };

  it('says there is no Context Pack instead of showing an empty brief', () => {
    const brief = buildOpportunityBrief(base);
    expect(brief.state).toBe('no_context');
    expect(brief.headline).toBe('No AI context pack yet');
    expect(brief.angle).toBeNull();
  });

  it('says it has no signals when a pack exists but nothing justifies contact', () => {
    const brief = buildOpportunityBrief({
      ...base,
      pack: { version: 3, createdAt: '2026-01-30T00:00:00.000Z', model: 'deepseek', promptKey: 'context_build', promptVersion: 2, angle: null, recommendation: null, summary: [] },
    });
    expect(brief.state).toBe('no_signals');
    expect(brief.headline).toBe('Context ready — no signals recorded');
  });

  it('never invents a reason: the "why" is assembled from stored facts only', () => {
    const brief = buildOpportunityBrief(base);
    expect(brief.why).toContain('Sarah Miller, Head of Content at Acme Media');
    expect(brief.why).toContain('primary ICP Media agency at fit 82');
    expect(brief.why).toContain('no active signals are recorded');
    expect(brief.why).toContain('Lead intelligence 65%');
    expect(brief.why).toContain('Qualification: produces video in-house');
  });

  it('says what is not recorded rather than omitting it', () => {
    const brief = buildOpportunityBrief({
      ...base,
      companyName: null,
      primaryIcpName: null,
      icpFit: null,
      icpReason: null,
    });
    expect(brief.why).toContain('has no company recorded');
    expect(brief.why).toContain('no primary ICP is recorded');
  });

  it('counts positive signals without hiding the others', () => {
    const brief = buildOpportunityBrief({
      ...base,
      signals: [signal(), signal({ id: 's2', polarity: 'negative' })],
    });
    expect(brief.why).toContain('2 active signals, 1 positive');
  });

  it('uses the pack recommendation as the headline only when the pack carries one', () => {
    const withRecommendation = buildOpportunityBrief({
      ...base,
      signals: [signal()],
      pack: { version: 2, createdAt: '2026-01-30T00:00:00.000Z', model: null, promptKey: null, promptVersion: null, angle: 'Lead with the video case study', recommendation: 'Pitch the video retainer', summary: [] },
    });
    expect(withRecommendation.state).toBe('ready');
    expect(withRecommendation.headline).toBe('Pitch the video retainer');
    expect(withRecommendation.angle).toBe('Lead with the video case study');

    const withoutRecommendation = buildOpportunityBrief({
      ...base,
      signals: [signal()],
      pack: { version: 2, createdAt: '2026-01-30T00:00:00.000Z', model: null, promptKey: null, promptVersion: null, angle: null, recommendation: null, summary: [] },
    });
    expect(withoutRecommendation.angle).toBeNull();
    expect(withoutRecommendation.headline).toBe('Opportunity for Media agency');
  });
});

describe('pack projection over an OPEN body (§59.6)', () => {
  it('reads a known key and a nested scalar field', () => {
    expect(readPackString({ recommended_angle: 'Case study first' }, ['recommended_angle'])).toBe(
      'Case study first',
    );
    expect(readPackString({ angle: { label: 'Case study first' } }, ['angle'])).toBe('Case study first');
  });

  it('returns null rather than guessing at an unknown shape', () => {
    expect(readPackString({ angle: { unknown: ['a'] } }, ['angle'])).toBeNull();
    expect(readPackString({ angle: 42 }, ['angle'])).toBeNull();
    expect(readPackString(null, ['angle'])).toBeNull();
    expect(readPackString(['angle'], ['angle'])).toBeNull();
    expect(readPackString({}, ['angle'])).toBeNull();
  });

  it('flattens scalars, counts arrays and skips nested objects', () => {
    const summary = flattenPackSummary({
      full_name: 'Sarah Miller',
      signals: [{}, {}],
      ignored: { nested: true },
      score: 42,
      fresh: true,
    });
    expect(summary).toEqual([
      { key: 'full_name', value: 'Sarah Miller' },
      { key: 'signals', value: '2 entries' },
      { key: 'score', value: '42' },
      { key: 'fresh', value: 'true' },
    ]);
  });

  it('is bounded, so a pack can never become a dump', () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) wide[`k${String(index)}`] = 'v';
    expect(flattenPackSummary(wide)).toHaveLength(12);
    expect(flattenPackSummary(wide, 3)).toHaveLength(3);
  });

  it('truncates a very long scalar instead of rendering it whole', () => {
    const long = 'x'.repeat(400);
    const [entry] = flattenPackSummary({ note: long });
    expect(entry?.value.length).toBeLessThan(220);
    expect(entry?.value.endsWith('…')).toBe(true);
  });
});

describe('processing steps (§67.2, §67.5)', () => {
  const base = {
    leadExists: true,
    personResolved: false,
    companyResolved: false,
    profileExtractionDone: false,
    companyResearchDone: false,
    companyResearchJobOpen: false,
    qualificationDone: false,
    enrichmentState: 'NEEDS_PROFILE',
    lastErrorCode: null,
  };

  it('names the seven steps in the spec order', () => {
    const steps = processingSteps(base);
    expect(steps.map((step) => step.label)).toEqual([
      'Source captured',
      'Person resolved',
      'Company resolved',
      'Profile extraction',
      'Company research pending',
      'Qualification pending',
      'Ready for outreach',
    ]);
  });

  it('marks exactly one step as current, and it is the first unfinished one', () => {
    const steps = processingSteps(base);
    expect(steps.filter((step) => step.state === 'current')).toHaveLength(1);
    expect(stepStates(steps)).toBe(
      'source_captured:done,person_resolved:current,company_resolved:pending,profile_extraction:pending,company_research:pending,qualification:pending,ready:pending',
    );
  });

  it('waits on an agent rather than showing an indefinite spinner (§67.5)', () => {
    const steps = processingSteps({
      ...base,
      personResolved: true,
      companyResolved: true,
      profileExtractionDone: true,
      enrichmentState: 'AGENT_RESEARCH_PENDING',
      companyResearchJobOpen: true,
    });
    const research = steps.find((step) => step.key === 'company_research');
    expect(research?.state).toBe('waiting');
    expect(research?.detail).toContain('waits durably');
  });

  it('advances to qualification once company research is committed', () => {
    const steps = processingSteps({
      ...base,
      personResolved: true,
      companyResolved: true,
      profileExtractionDone: true,
      companyResearchDone: true,
      enrichmentState: 'PROFILE_READY',
    });
    expect(stepStates(steps)).toBe(
      'source_captured:done,person_resolved:done,company_resolved:done,profile_extraction:done,company_research:done,qualification:current,ready:pending',
    );
  });

  it('reports ready as done only from the READY state', () => {
    const steps = processingSteps({
      ...base,
      personResolved: true,
      companyResolved: true,
      profileExtractionDone: true,
      companyResearchDone: true,
      qualificationDone: true,
      enrichmentState: 'READY',
    });
    expect(steps.every((step) => step.state === 'done')).toBe(true);
    expect(steps.filter((step) => step.state === 'current')).toHaveLength(0);
  });

  it('shows a failure as a state with its stable code, not as a toast (§67.6)', () => {
    const steps = processingSteps({ ...base, enrichmentState: 'FAILED', lastErrorCode: 'provider_error' });
    const failed = steps.find((step) => step.state === 'failed');
    expect(failed?.detail).toBe('failed: provider_error');
  });

  it('names the review decision a NEEDS_REVIEW lead is waiting on (§66.4)', () => {
    const steps = processingSteps({ ...base, enrichmentState: 'NEEDS_REVIEW' });
    const review = steps.find((step) => step.state === 'failed');
    expect(review?.detail).toContain('review decision is required');
  });

  it('marks AI work as waiting so the page never blocks on it', () => {
    const steps = processingSteps({
      ...base,
      personResolved: true,
      companyResolved: true,
      profileExtractionDone: true,
      enrichmentState: 'AI_PROCESSING',
    });
    expect(steps.some((step) => step.state === 'waiting')).toBe(true);
  });
});

describe('outreach rows (§20, §26)', () => {
  const accounts: readonly ChannelAccountView[] = [
    { channel: 'linkedin', displayName: 'Zemnas LI', status: 'active' },
    { channel: 'email', displayName: 'hello@zemnas.com', status: 'active' },
    { channel: 'upwork', displayName: 'Retired Upwork', status: 'retired' },
  ];

  const contactPoints: readonly ContactPointView[] = [
    { kind: 'linkedin', value: 'https://linkedin.com/in/sarah', isPrimary: true, confirmedByUser: false, confidence: 0.8, source: 'manual', observedAt: '2026-01-01T00:00:00.000Z' },
    { kind: 'email', value: 'sarah@acme.com', isPrimary: true, confirmedByUser: true, confidence: 0.4, source: 'manual', observedAt: '2026-01-02T00:00:00.000Z' },
  ];

  const input = {
    availableChannels: ['linkedin', 'email'] as const,
    accounts,
    contactPoints,
    discoverySource: 'reddit',
    nextAction: 'Message 1',
    sequenceState: 'active',
    isDnc: false,
  };

  it('returns one row per V1.2 channel, in vocabulary order', () => {
    expect(channelOutreachRows(input).map((row) => row.channel)).toEqual([
      'linkedin',
      'email',
      'instagram',
      'upwork',
    ]);
  });

  it('lets a Reddit-discovered lead use email: the source never restricts a channel (§20.2)', () => {
    const reddit = channelOutreachRows({ ...input, discoverySource: 'reddit' });
    const linkedin = channelOutreachRows({ ...input, discoverySource: 'linkedin' });
    expect(reddit.map((row) => row.channel)).toEqual(linkedin.map((row) => row.channel));
    expect(reddit.find((row) => row.channel === 'email')?.missing).toEqual([]);
    expect(reddit.find((row) => row.channel === 'email')?.nextAction).toBe('Message 1');
  });

  it('says which half is missing rather than that a channel is unavailable', () => {
    // The business holds no Instagram account and the person has no Instagram handle.
    const instagram = channelOutreachRows(input).find((row) => row.channel === 'instagram');
    expect(instagram?.missing).toEqual(['no channel account', 'no contact point']);
    expect(instagram?.nextAction).toBe('no channel account and no contact point');
  });

  it('never offers a retired account as a sending route', () => {
    expect(accountForChannel('upwork', accounts)).toBeNull();
    const upwork = channelOutreachRows(input).find((row) => row.channel === 'upwork');
    expect(upwork?.account).toBeNull();
    expect(upwork?.missing).toContain('no channel account');
  });

  it('prefers a user-confirmed contact point over a more confident extracted one (§26.2)', () => {
    const winner = winningContactPoint('email', [
      { kind: 'email', value: 'extracted@acme.com', isPrimary: false, confirmedByUser: false, confidence: 0.99, source: 'ai', observedAt: '2026-01-03T00:00:00.000Z' },
      { kind: 'email', value: 'confirmed@acme.com', isPrimary: true, confirmedByUser: true, confidence: 0.2, source: 'manual', observedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(winner?.value).toBe('confirmed@acme.com');
  });

  it('falls back to the highest confidence when nothing is confirmed', () => {
    const winner = winningContactPoint('email', [
      { kind: 'email', value: 'low@acme.com', isPrimary: true, confirmedByUser: false, confidence: 0.3, source: 'ai', observedAt: '2026-01-03T00:00:00.000Z' },
      { kind: 'email', value: 'high@acme.com', isPrimary: false, confirmedByUser: false, confidence: 0.9, source: 'ai', observedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(winner?.value).toBe('high@acme.com');
  });

  it('returns null for a channel with no contact point', () => {
    expect(winningContactPoint('instagram', contactPoints)).toBeNull();
  });

  it('distinguishes confirmed, imported and extracted (§26.4)', () => {
    expect(contactPointProvenanceLabel(contactPoints[1] as ContactPointView)).toBe('confirmed');
    expect(contactPointProvenanceLabel(contactPoints[0] as ContactPointView)).toBe('imported');
    expect(
      contactPointProvenanceLabel({ ...(contactPoints[0] as ContactPointView), source: 'ai' }),
    ).toBe('extracted');
  });

  it('marks a suppressed lead as such on every available channel', () => {
    const rows = channelOutreachRows({ ...input, isDnc: true });
    expect(rows.find((row) => row.channel === 'email')?.nextAction).toBe('suppressed — do not contact');
  });
});

/* ============================================================================
 * The screens themselves, rendered against the real migration set.
 *
 * Type-checking cannot tell a valid SQL join from a broken one, and the two screens this
 * workstream owns both run hand-written, parameterised SQL over the V1.2 tables: the
 * enrichment-filtered list selection and the per-page intelligence overlay. This block boots
 * the production schema, seeds one lead, and renders both pages to markup — so a wrong
 * column, a wrong alias or a filter that can never match fails here instead of in front of an
 * operator. The `RawBody` marker is seeded into the fixture and asserted *absent* from the
 * rendered detail page, which is the §32.2.6 rule expressed as an executable check.
 * ========================================================================== */

const RENDER_USER = 'c0000000-0000-4000-8000-000000000001';
const RENDER_BUSINESS = 'c0000000-0000-4000-8000-00000000000a';
const RENDER_PERSON = 'c0000000-0000-4000-8000-000000000010';
const RENDER_COMPANY = 'c0000000-0000-4000-8000-000000000020';
const RENDER_LEAD = 'c0000000-0000-4000-8000-000000000030';
const RENDER_ICP = 'c0000000-0000-4000-8000-000000000040';
const RENDER_IDENTITY = 'c0000000-0000-4000-8000-000000000050';
/** Seeded into the fixture only to prove the screens never render a stored body. */
const RAW_BODY_MARKER = 'RAW-BODY-MARKER-should-never-render';

describe('the V1.2 screens render against the real schema', () => {
  let h: AppHarness;

  beforeAll(async () => {
    h = await createAppHarness();
    await h.db.exec('set row_security = off');
    await h.db.query(
      `insert into public.users (id, email, full_name, role, status)
       values ($1, 'lead-ui-probe@nexus.test', 'Lead UI Probe', 'admin', 'active')`,
      [RENDER_USER],
    );
    await h.db.query(
      `insert into public.businesses (id, key, name, status, created_by)
       values ($1, 'lead-ui-probe', 'Lead UI Probe Business', 'active', $2)`,
      [RENDER_BUSINESS, RENDER_USER],
    );
    await h.db.query(
      `insert into public.user_business_access
         (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources,
          can_use_profile_queue, can_delete_leads, created_by)
       values ($1, $2, 'admin', true, true, true, true, $1)`,
      [RENDER_USER, RENDER_BUSINESS],
    );
    await h.db.query(
      `insert into public.companies (id, name, normalized_name, primary_domain, normalized_domain, created_by)
       values ($1, 'Acme Media', 'acme-media', 'acme.example', 'acme.example', $2)`,
      [RENDER_COMPANY, RENDER_USER],
    );
    await h.db.query(
      `insert into public.people (id, full_name, normalized_name, job_title, location, linkedin_url,
                                  normalized_linkedin_url, company_id, created_by)
       values ($1, 'Ada Lovelace', 'ada-lovelace', 'Head of Content', 'London',
               'https://www.linkedin.com/in/ada-lovelace', 'https://www.linkedin.com/in/ada-lovelace',
               $2, $3)`,
      [RENDER_PERSON, RENDER_COMPANY, RENDER_USER],
    );
    await h.db.query(
      `insert into public.leads (id, business_id, person_id, company_id, status, source_type, source_url, created_by)
       values ($1, $2, $3, $4, 'new', 'google_search', 'https://example.com/ada', $5)`,
      [RENDER_LEAD, RENDER_BUSINESS, RENDER_PERSON, RENDER_COMPANY, RENDER_USER],
    );
    await h.db.query(
      `insert into public.icps (id, business_id, name, is_default, created_by)
       values ($1, $2, 'Media agency', true, $3)`,
      [RENDER_ICP, RENDER_BUSINESS, RENDER_USER],
    );
    await h.db.query(`update public.leads set primary_icp_id = $2 where id = $1`, [RENDER_LEAD, RENDER_ICP]);
    await h.db.query(
      `insert into public.outreach_identities (id, channel, platform, display_name, status, created_by)
       values ($1, 'linkedin', 'linkedin', 'Probe LinkedIn', 'active', $2)`,
      [RENDER_IDENTITY, RENDER_USER],
    );
    await h.db.query(
      `insert into public.outreach_identity_business_access (outreach_identity_id, business_id)
       values ($1, $2)`,
      [RENDER_IDENTITY, RENDER_BUSINESS],
    );
    await h.db.query(
      `insert into public.person_contact_points
         (person_id, kind, value, normalized_value, is_primary, confidence, source, created_by)
       values ($1, 'linkedin', 'https://www.linkedin.com/in/ada-lovelace',
               'linkedin.com/in/ada-lovelace', true, 0.8, 'manual', $2),
              ($1, 'email', 'ada@acme.example', 'ada@acme.example', true, 0.6, 'ai', $2)`,
      [RENDER_PERSON, RENDER_USER],
    );
    await h.db.query(
      `insert into public.signals (business_id, lead_id, person_id, kind, polarity, strength, label, is_active)
       values ($1, $2, $3, 'hiring', 'positive', 70, 'Hiring two editors', true)`,
      [RENDER_BUSINESS, RENDER_LEAD, RENDER_PERSON],
    );
    await h.db.query(
      `insert into public.research_snapshots (business_id, lead_id, person_id, company_id, summary, model)
       values ($1, $2, $3, $4, 'Produces video in house', 'deepseek-chat')`,
      [RENDER_BUSINESS, RENDER_LEAD, RENDER_PERSON, RENDER_COMPANY],
    );
    await h.db.query(
      `insert into public.source_evidence
         (business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json, content_hash,
          observed_at, confidence)
       values ($1, $2, $3, $4, 'linkedin', 'https://www.linkedin.com/in/ada-lovelace', $5, 'probe-hash-1',
               now(), 0.9)`,
      [RENDER_BUSINESS, RENDER_PERSON, RENDER_COMPANY, RENDER_LEAD, RAW_BODY_MARKER],
    );
    await h.db.query(
      `insert into public.ai_context_packs
         (business_id, lead_id, version, input_hash, pack, source_summary, model)
       values ($1, $2, 1, 'probe-input-hash',
               '{"recommended_angle":"Lead with the video case study"}'::jsonb,
               '{"full_name":"Ada Lovelace","signals":["hiring"]}'::jsonb, 'deepseek-chat')`,
      [RENDER_BUSINESS, RENDER_LEAD],
    );
    await h.db.query(
      `insert into public.agent_jobs (business_id, lead_id, person_id, company_id, job_type, status, reason, dedupe_key)
       values ($1, $2, $3, $4, 'RESEARCH_COMPANY', 'OPEN', 'probe job', 'RESEARCH_COMPANY:probe')`,
      [RENDER_BUSINESS, RENDER_LEAD, RENDER_PERSON, RENDER_COMPANY],
    );
    await h.db.exec('set row_security = on');
    cookieJar.value = issueSession(RENDER_USER).cookieValue;
  }, 240_000);

  afterAll(async () => {
    await h.close();
  });

  it('executes every V1.2 filter predicate without error', async () => {
    const element = await LeadsPage({
      params: Promise.resolve({ slug: 'lead-ui-probe' }),
      searchParams: Promise.resolve({
        enrichment: 'NOT_READY',
        channel: 'linkedin',
        minIntelligence: '10',
        q: 'ada',
        icp: RENDER_ICP,
        owner: RENDER_USER,
        identity: RENDER_IDENTITY,
        status: 'new',
        source: 'google_search',
        needsProfile: '1',
        dnc: '1',
        followups: '1',
        pageSize: '5',
        sort: 'company',
        add: '1',
      }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);
    expect(html).toContain('Add lead');
    expect(html).toContain('Needs enrichment (not Ready)');
    expect(html).toContain('Intelligence at least');
  });

  it('renders a matching row with every V1.2 column and the deterministic search link', async () => {
    const element = await LeadsPage({
      params: Promise.resolve({ slug: 'lead-ui-probe' }),
      searchParams: Promise.resolve({
        enrichment: 'NOT_READY',
        channel: 'linkedin',
        q: 'ada',
        // The V1.2 discovery source, filtered against a legacy-stored `google_search` row.
        source: 'google',
        sort: 'name',
        pageSize: '5',
      }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);
    // The twelve V1.2 columns, each from a stored row rather than a literal.
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Acme Media');
    expect(html).toContain('London');
    expect(html).toContain('Minimal');
    expect(html).toContain('Lead intelligence');
    expect(html).toContain('Media agency');
    expect(html).toContain('pack v1');
    expect(html).toContain('Hiring two editors');
    expect(html).toContain('1 matching lead');
    // §30.3.7 — a deterministic, encoded Google URL in a new tab, never an AI-composed query.
    expect(html).toContain('site%3Alinkedin.com%2Fin');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders the needs-attention and unassigned variants', async () => {
    const element = await LeadsPage({
      params: Promise.resolve({ slug: 'lead-ui-probe' }),
      searchParams: Promise.resolve({ needsAttention: '1', ownerNone: '1', enrichment: 'READY' }),
    });
    expect(renderToStaticMarkup(element as React.ReactElement)).toContain('Leads');
  });

  it('renders the lead detail hierarchy and never a retained raw body (§32.2.6)', async () => {
    const element = await LeadDetailPage({
      params: Promise.resolve({ slug: 'lead-ui-probe', id: RENDER_LEAD }),
    });
    const html = renderToStaticMarkup(element as React.ReactElement);
    expect(html).toContain('AI opportunity brief');
    expect(html).toContain('Enrichment workspace');
    expect(html).toContain('Outreach');
    expect(html).toContain('Timeline');
    expect(html).toContain('Ada Lovelace');
    // §69.5 — the paste box states its own temporariness.
    expect(html).toContain('Temporary raw paste');
    // §32.2.6 — the evidence row above holds a body, and none of it reaches the page.
    expect(html).not.toContain(RAW_BODY_MARKER);
  });
});
