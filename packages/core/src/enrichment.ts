/**
 * Deterministic enrichment arithmetic.
 *
 * Three questions, all answered without a database and without a model:
 *
 *   1. how complete is what we know about this lead (`intelligenceCompleteness`)?
 *   2. what should the operator click next to fill the gaps (`searchLinks`)?
 *   3. which enrichment state does this fact set imply (`enrichmentStateFromFacts`)?
 *
 * "Zero-token" is a requirement, not an optimisation. These run on every lead
 * render and on every list row, so an AI call here would cost money, add latency
 * and — worse — make the same lead score differently on two consecutive renders.
 * The AI contributes *facts*; this module only counts and ranks them.
 *
 * The module is pure: no clock, no randomness, no I/O, no mutation of its input.
 */

import {
  CHANNELS_FOR_SOURCE,
  type DiscoverySource,
  type EnrichmentState,
  type OutreachChannel,
} from './vocabulary.js';

/* ----------------------------------------------------------- facts ------ */

/**
 * The facts the enrichment decision is allowed to depend on.
 *
 * Deliberately a flat, already-resolved shape rather than a lead row: the caller
 * decides what counts as "research exists" and what counts as a contact point,
 * so scoring stays independent of the storage layout.
 */
export interface EnrichmentFacts {
  readonly fullName: string | null;
  readonly companyName: string | null;
  readonly location: string | null;
  readonly jobTitle: string | null;
  readonly linkedinUrl: string | null;
  readonly companyWebsite: string | null;
  /** True when a company research snapshot exists for the company. */
  readonly companyResearch: boolean;
  /** Number of active signals recorded for the lead/company. */
  readonly signalCount: number;
  /** True when a cached AI context pack exists for the lead. */
  readonly hasAiContext: boolean;
  /** Number of known contact points (email/social) for the person. */
  readonly contactCount: number;
}

export interface CompletenessComponent {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly present: boolean;
}

export interface IntelligenceCompleteness {
  readonly score: number;
  readonly components: readonly CompletenessComponent[];
  readonly missing: readonly string[];
}

/* ------------------------------------------------------ completeness ---- */

/** A component before the fact set is applied to it. */
interface ComponentSpec {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
}

/**
 * The completeness table. Weights total exactly 100, so the score reads as a
 * percentage with no second conversion; `enrichment.test.ts` asserts the total
 * so a later edit cannot quietly make the scale meaningless.
 *
 * A weight is the marginal value of the fact to an operator deciding whether to
 * contact the lead, not the cost of obtaining it — which is why the LinkedIn URL
 * (the only field that makes the person reachable *and* verifiable) outweighs the
 * job title.
 */
const COMPLETENESS_COMPONENTS: readonly ComponentSpec[] = [
  { key: 'name', label: 'Name', weight: 12 }, // 12 — without a name there is nobody to contact
  { key: 'company', label: 'Company', weight: 12 }, // 12 — the company is what the signal and research jobs key on
  { key: 'location', label: 'Location', weight: 6 }, // 6 — shapes timezone, travel and ICP geography fit
  { key: 'job_title', label: 'Job title', weight: 10 }, // 10 — decides whether this person owns the problem
  { key: 'linkedin', label: 'LinkedIn URL', weight: 14 }, // 14 — highest single value: identity plus a reachable channel
  { key: 'company_website', label: 'Company website', weight: 8 }, // 8 — grounds company research in the real business
  { key: 'company_research', label: 'Company research', weight: 12 }, // 12 — the fact base every message depends on
  { key: 'signals', label: 'Signals', weight: 8 }, // 8 — a reason to make contact *now*
  { key: 'ai_context', label: 'AI context', weight: 10 }, // 10 — the cached pack that makes drafting cheap
  { key: 'contacts', label: 'Contact points', weight: 8 }, // 8 — a second route in when the first is ignored
];

/** A string fact is present only when it holds something after trimming. */
function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Scores how much is known about a lead: the sum of the weights of the present
 * facts, plus the labels of the absent ones in component order.
 *
 * An integer result, so two callers comparing scores never disagree about a
 * rounding boundary.
 */
export function intelligenceCompleteness(facts: EnrichmentFacts): IntelligenceCompleteness {
  const presence: Readonly<Record<string, boolean>> = {
    name: hasText(facts.fullName),
    company: hasText(facts.companyName),
    location: hasText(facts.location),
    job_title: hasText(facts.jobTitle),
    linkedin: hasText(facts.linkedinUrl),
    company_website: hasText(facts.companyWebsite),
    company_research: facts.companyResearch,
    signals: facts.signalCount > 0,
    ai_context: facts.hasAiContext,
    contacts: facts.contactCount > 0,
  };

  const components: readonly CompletenessComponent[] = COMPLETENESS_COMPONENTS.map((component) => ({
    key: component.key,
    label: component.label,
    weight: component.weight,
    present: presence[component.key] ?? false,
  }));

  let score = 0;
  for (const component of components) {
    if (component.present) score += component.weight;
  }

  return {
    score,
    components,
    missing: components.filter((component) => !component.present).map((component) => component.label),
  };
}

/* -------------------------------------------------------- search links -- */

export interface SearchLinkInput {
  readonly fullName?: string | null;
  readonly companyName?: string | null;
  readonly location?: string | null;
  readonly companyDomain?: string | null;
  readonly linkedinUrl?: string | null;
}

export interface SearchLink {
  readonly key: 'find_linkedin' | 'search_person' | 'search_company' | 'search_signals';
  readonly label: string;
  readonly query: string;
  readonly url: string;
}

const GOOGLE_SEARCH_ENDPOINT = 'https://www.google.com/search?q=';

/**
 * Trimmed term, or null when the caller supplied nothing usable.
 *
 * Embedded double quotes are dropped rather than escaped: the quotes in these
 * queries are the operator's grouping syntax, and a stray quote from a scraped
 * page would split a group and silently change what the search means.
 */
function term(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/"/g, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function quoted(value: string): string {
  return `"${value}"`;
}

function googleSearchUrl(query: string): string {
  return GOOGLE_SEARCH_ENDPOINT + encodeURIComponent(query);
}

/**
 * Deterministic, zero-token Google search URLs. NEVER call an AI model to build
 * these.
 *
 * Query shapes (exactly):
 *   find_linkedin  -> "Sarah Miller" "Acme Media" site:linkedin.com/in
 *   search_person  -> "Sarah Miller" "Acme Media" "New York"   (location segment omitted when unknown)
 *   search_company -> "Acme Media" company
 *   search_signals -> "Acme Media" hiring OR expansion OR video OR podcast
 *
 * Quotes are literal double quotes around each supplied term. Terms are trimmed;
 * empty/missing terms are skipped. `url` is `https://www.google.com/search?q=` +
 * `encodeURIComponent(query)`.
 *
 * A link is omitted when there is not enough input to make it meaningful (no
 * company for `search_company`, no person for `find_linkedin`/`search_person`).
 * The company term falls back to `companyDomain` when no name was supplied,
 * because a domain still identifies the company; if neither is present the
 * company links are omitted. A supplied LinkedIn URL is appended to
 * `find_linkedin` as a trailing term so an operator can confirm identity rather
 * than pick a namesake.
 */
export function searchLinks(input: SearchLinkInput): readonly SearchLink[] {
  const fullName = term(input.fullName);
  const company = term(input.companyName) ?? term(input.companyDomain);
  const location = term(input.location);
  const linkedinUrl = term(input.linkedinUrl);

  const links: SearchLink[] = [];

  if (fullName !== null || linkedinUrl !== null) {
    const parts: string[] = [];
    if (fullName !== null) parts.push(quoted(fullName));
    if (company !== null) parts.push(quoted(company));
    parts.push('site:linkedin.com/in');
    if (linkedinUrl !== null) parts.push(quoted(linkedinUrl));
    const query = parts.join(' ');
    links.push({
      key: 'find_linkedin',
      label: 'Find LinkedIn profile',
      query,
      url: googleSearchUrl(query),
    });
  }

  if (fullName !== null) {
    const parts: string[] = [quoted(fullName)];
    if (company !== null) parts.push(quoted(company));
    if (location !== null) parts.push(quoted(location));
    const query = parts.join(' ');
    links.push({
      key: 'search_person',
      label: 'Search this person',
      query,
      url: googleSearchUrl(query),
    });
  }

  if (company !== null) {
    const companyQuery = `${quoted(company)} company`;
    links.push({
      key: 'search_company',
      label: 'Search this company',
      query: companyQuery,
      url: googleSearchUrl(companyQuery),
    });

    const signalQuery = `${quoted(company)} hiring OR expansion OR video OR podcast`;
    links.push({
      key: 'search_signals',
      label: 'Search for buying signals',
      query: signalQuery,
      url: googleSearchUrl(signalQuery),
    });
  }

  return links;
}

/* ---------------------------------------------------- state decision ---- */

/**
 * Chooses the enrichment state from facts, deterministically. Rules, in order:
 *
 *  1. no linkedinUrl and no companyResearch -> if fullName && companyName -> NEEDS_PROFILE
 *  2. linkedinUrl known but companyWebsite/companyResearch unknown -> COMPANY_RESEARCH_PENDING
 *  3. companyResearch known but no hasAiContext -> AI_PROCESSING is NOT chosen here; return 'PROFILE_READY'
 *  4. hasAiContext and score >= 70 -> READY
 *  5. otherwise -> PROFILE_READY
 *
 * The order is the contract: a rule lower down never overrides a higher one, so
 * adding facts cannot move a lead backwards through the pipeline.
 *
 * This function only ever returns NEEDS_PROFILE, COMPANY_RESEARCH_PENDING,
 * PROFILE_READY or READY. The other `ENRICHMENT_STATES` belong to the pipeline,
 * not to the facts: MINIMAL is produced by ingestion before any profile work,
 * AI_PROCESSING and AGENT_RESEARCH_PENDING are set when a job is actually
 * claimed or waiting on a model, and NEEDS_REVIEW / FAILED are set by a human or
 * by a failing run. Deriving them from a fact set would invent a work state.
 */
export function enrichmentStateFromFacts(facts: EnrichmentFacts): EnrichmentState {
  const hasLinkedin = hasText(facts.linkedinUrl);
  const hasResearch = facts.companyResearch;
  const hasWebsite = hasText(facts.companyWebsite);

  // 1. Nothing to research yet: the operator has to capture the profile first.
  if (!hasLinkedin && !hasResearch) {
    if (hasText(facts.fullName) && hasText(facts.companyName)) return 'NEEDS_PROFILE';
    // A lead with neither identity is still on the ingestion path; rule 5 decides.
  }

  // 2. The person is identified but the company is not: research is the next hop.
  if (hasLinkedin && !hasWebsite && !hasResearch) return 'COMPANY_RESEARCH_PENDING';

  // 3. Company research is in, the context pack is not. That is a *ready profile*,
  //    not AI work in flight — a job row is what makes it AI_PROCESSING.
  if (hasResearch && !facts.hasAiContext) return 'PROFILE_READY';

  // 4. Context pack cached and the profile is substantially complete.
  if (facts.hasAiContext && intelligenceCompleteness(facts).score >= 70) return 'READY';

  // 5. Anything else: the profile is usable but nothing more advanced is proven.
  return 'PROFILE_READY';
}

/* ------------------------------------------------------------- channels -- */

/**
 * The channels an operator may use for a lead discovered through `source`.
 *
 * Always all four: discovery never dictates channel (see `CHANNELS_FOR_SOURCE`).
 * Exposed as a function so call sites do not reach into the table directly and
 * start treating an empty list as a restriction.
 */
export function outreachChannelsForSource(source: DiscoverySource): readonly OutreachChannel[] {
  return CHANNELS_FOR_SOURCE[source];
}
