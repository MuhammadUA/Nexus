/**
 * `lead_enrichment` and the read model the V1.2 screens are built on.
 *
 * Two rules are load-bearing here and both are easy to get wrong:
 *
 *   1. **The completeness score is computed in TypeScript, never in SQL.** The
 *      weight table lives in `@nexus/core` (`intelligenceCompleteness`), and the
 *      V1.1 lesson that produced it is that a score computed twice — once in a
 *      view, once in code — drifts. This module therefore reads *facts* in one
 *      statement and derives the score, the missing-field list, the enrichment
 *      state, the channels and the search links from them.
 *   2. **One round trip.** The enrichment workspace renders on every lead open,
 *      so the whole fact set (person, company, signals, contact points, research
 *      snapshot, context pack) is gathered by correlated sub-selects in a single
 *      statement rather than by a waterfall of queries.
 *
 * The state vocabulary and its permitted transitions are spec §14–§15. A facts
 * change may only move a lead along an allowed edge; `NEEDS_REVIEW` and `FAILED`
 * are human/pipeline decisions and are never cleared by a recomputation, because a
 * recompute that silently resolved a conflict would lose the decision an operator
 * has not made yet.
 */
import 'server-only';

import {
  ENRICHMENT_STATES,
  OUTREACH_CHANNELS,
  intelligenceCompleteness,
  enrichmentStateFromFacts,
  normalizeDiscoverySource,
  searchLinks,
  type DiscoverySource,
  type EnrichmentFacts,
  type EnrichmentState,
  type OutreachChannel,
  type SearchLink,
} from '@nexus/core';

import { withActor, type Viewer } from '../actor';
import type { Db } from '../sql';
import { asBoolean, asIso, asNumber, asStringArray, describeDbError } from './common';

export interface LeadEnrichmentRecord {
  readonly leadId: string;
  readonly businessId: string;
  readonly status: EnrichmentState;
  readonly completenessScore: number;
  readonly missingFields: readonly string[];
  readonly lastProfileEnrichmentAt: string | null;
  readonly lastCompanyEnrichmentAt: string | null;
  readonly lastContextBuildAt: string | null;
  readonly lastErrorCode: string | null;
  readonly profileSourceType: string | null;
  readonly profileSourceUrl: string | null;
  readonly profileObservedAt: string | null;
  readonly profileContentHash: string | null;
  readonly profileAgentJobId: string | null;
}

export interface LeadIntelligence {
  readonly leadId: string;
  readonly businessId: string;
  readonly personId: string;
  readonly companyId: string | null;
  readonly status: EnrichmentState;
  readonly completenessScore: number;
  readonly missingFields: readonly string[];
  readonly facts: EnrichmentFacts;
  readonly availableChannels: readonly OutreachChannel[];
  readonly source: DiscoverySource;
  readonly searchLinks: readonly SearchLink[];
}

/**
 * Permitted enrichment transitions, spec §15.1, reproduced exactly.
 *
 * Anything outside this table is refused by the application layer rather than by
 * a CHECK, because the illegal transition is a *rule* about the pipeline, not a
 * statement about a single column.
 */
const ENRICHMENT_TRANSITIONS: Readonly<Record<EnrichmentState, readonly EnrichmentState[]>> = {
  MINIMAL: ['NEEDS_PROFILE', 'PROFILE_READY', 'AI_PROCESSING', 'FAILED'],
  NEEDS_PROFILE: ['PROFILE_READY', 'AI_PROCESSING', 'FAILED', 'MINIMAL'],
  PROFILE_READY: [
    'COMPANY_RESEARCH_PENDING',
    'AGENT_RESEARCH_PENDING',
    'AI_PROCESSING',
    'READY',
    'FAILED',
  ],
  COMPANY_RESEARCH_PENDING: ['AGENT_RESEARCH_PENDING', 'AI_PROCESSING', 'FAILED', 'NEEDS_REVIEW'],
  AGENT_RESEARCH_PENDING: [
    'AI_PROCESSING',
    'FAILED',
    'NEEDS_REVIEW',
    'COMPANY_RESEARCH_PENDING',
  ],
  AI_PROCESSING: ['READY', 'NEEDS_REVIEW', 'FAILED', 'PROFILE_READY'],
  READY: ['MINIMAL', 'NEEDS_REVIEW', 'AI_PROCESSING'],
  NEEDS_REVIEW: ['READY', 'FAILED', 'AI_PROCESSING', 'MINIMAL'],
  FAILED: ['MINIMAL', 'NEEDS_PROFILE', 'AI_PROCESSING'],
};

/**
 * States a *fact-derived* recomputation may leave on its own.
 *
 * `AI_PROCESSING` and `AGENT_RESEARCH_PENDING` describe work in flight; a
 * recompute running inside that work would otherwise erase the "a model/agent is
 * working on this" fact. `NEEDS_REVIEW` and `FAILED` are waiting on a human.
 */
const PIPELINE_OWNED_STATES: ReadonlySet<EnrichmentState> = new Set<EnrichmentState>([
  'AI_PROCESSING',
  'AGENT_RESEARCH_PENDING',
  'NEEDS_REVIEW',
  'FAILED',
]);

export function isEnrichmentState(value: unknown): value is EnrichmentState {
  return typeof value === 'string' && (ENRICHMENT_STATES as readonly string[]).includes(value);
}

/** The state a fact-derived recomputation is allowed to reach from `current`. */
function permittedFactsState(current: EnrichmentState, derived: EnrichmentState): EnrichmentState {
  if (PIPELINE_OWNED_STATES.has(current)) return current;
  if (derived === current) return current;
  return ENRICHMENT_TRANSITIONS[current].includes(derived) ? derived : current;
}

/* --------------------------------------------------------------- reads --- */

type FactRow = {
  lead_id: string;
  business_id: string;
  person_id: string;
  company_id: string | null;
  source_type: string | null;
  full_name: string;
  job_title: string | null;
  linkedin_url: string | null;
  person_location: string | null;
  company_name: string | null;
  company_domain: string | null;
  stored_status: string | null;
  completeness_score: number | null;
  missing_fields: string[] | null;
  signal_count: number;
  contact_count: number;
  has_context_pack: boolean;
  has_company_research: boolean;
  last_profile_enrichment_at: unknown;
  last_company_enrichment_at: unknown;
  last_context_build_at: unknown;
  last_error_code: string | null;
  profile_source_type: string | null;
  profile_source_url: string | null;
  profile_observed_at: unknown;
  profile_content_hash: string | null;
  profile_agent_job_id: string | null;
}

/**
 * The one statement that gathers every permanent fact the score is derived from.
 *
 * Correlated sub-selects rather than joins on purpose: three independent counts
 * (signals, contact points, packs) joined in one row would multiply each other.
 */
const LEAD_INTELLIGENCE_SQL = `
  with lead_row as (
    select l.id as lead_id,
           l.business_id,
           l.person_id,
           l.company_id,
           l.source_type,
           p.full_name,
           p.job_title,
           p.linkedin_url,
           p.location as person_location,
           c.name as company_name,
           coalesce(c.primary_domain, c.normalized_domain) as company_domain,
           e.status as stored_status,
           e.completeness_score,
           e.missing_fields,
           e.last_profile_enrichment_at,
           e.last_company_enrichment_at,
           e.last_context_build_at,
           e.last_error_code,
           e.profile_source_type,
           e.profile_source_url,
           e.profile_observed_at,
           e.profile_content_hash,
           e.profile_agent_job_id
      from public.leads l
      join public.people p on p.id = l.person_id
      left join public.companies c on c.id = l.company_id
      left join public.lead_enrichment e on e.lead_id = l.id
     where l.id = $1
       and l.deleted_at is null
  )
  select lr.*,
         (select count(*)::int
            from public.signals s
           where s.is_active
             and (s.lead_id = lr.lead_id
                  or s.person_id = lr.person_id
                  or (lr.company_id is not null and s.company_id = lr.company_id))) as signal_count,
         (select count(*)::int
            from public.person_contact_points cp
           where cp.person_id = lr.person_id
             and cp.deleted_at is null) as contact_count,
         exists (select 1 from public.ai_context_packs a where a.lead_id = lr.lead_id) as has_context_pack,
         exists (select 1 from public.research_snapshots r
                  where (r.lead_id = lr.lead_id)
                     or (lr.company_id is not null and r.company_id = lr.company_id)) as has_company_research
    from lead_row lr
`;

function factsFrom(row: FactRow): EnrichmentFacts {
  return {
    fullName: row.full_name,
    companyName: row.company_name,
    location: row.person_location,
    jobTitle: row.job_title,
    linkedinUrl: row.linkedin_url,
    companyWebsite: row.company_domain,
    companyResearch: asBoolean(row.has_company_research),
    signalCount: asNumber(row.signal_count, 0),
    hasAiContext: asBoolean(row.has_context_pack),
    contactCount: asNumber(row.contact_count, 0),
  };
}

/**
 * The full intelligence view of one lead, or null when the actor cannot see it.
 *
 * RLS is the tenancy boundary: a lead outside the actor's businesses yields no
 * row, so this doubles as the "not visible" check the enrichment route needs.
 */
export async function loadLeadIntelligence(viewer: Viewer, leadId: string): Promise<LeadIntelligence | null> {
  return withActor(viewer.actor, async (sql) => {
    const row = await loadFactRow(sql, leadId);
    if (row === null) return null;

    const facts = factsFrom(row);
    const completeness = intelligenceCompleteness(facts);
    const derived = enrichmentStateFromFacts(facts);
    const status: EnrichmentState =
      row.stored_status !== null && isEnrichmentState(row.stored_status) ? row.stored_status : derived;
    const source = normalizeDiscoverySource(row.source_type);

    return {
      leadId: String(row.lead_id),
      businessId: String(row.business_id),
      personId: String(row.person_id),
      companyId: row.company_id === null ? null : String(row.company_id),
      status,
      // Derived here, not read from the column: a stored score can be stale by one
      // write, and showing the stale one is how "why is this 88% and missing
      // nothing" happens.
      completenessScore: completeness.score,
      missingFields: completeness.missing,
      facts,
      // All four, always. Discovery source never restricts the channel a lead may
      // be contacted through (spec §20).
      availableChannels: OUTREACH_CHANNELS,
      source,
      searchLinks: searchLinks({
        fullName: row.full_name,
        companyName: row.company_name,
        location: row.person_location,
        companyDomain: row.company_domain,
        linkedinUrl: row.linkedin_url,
      }),
    };
  });
}

async function loadFactRow(sql: Db, leadId: string): Promise<FactRow | null> {
  const result = await sql.query<FactRow>(LEAD_INTELLIGENCE_SQL, [leadId]);
  return result.rows[0] ?? null;
}

/** The durable `lead_enrichment` row on its own, or null when it is not visible. */
export async function loadLeadEnrichment(viewer: Viewer, leadId: string): Promise<LeadEnrichmentRecord | null> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{
      lead_id: string;
      business_id: string;
      status: string;
      completeness_score: number;
      missing_fields: string[] | null;
      last_profile_enrichment_at: unknown;
      last_company_enrichment_at: unknown;
      last_context_build_at: unknown;
      last_error_code: string | null;
      profile_source_type: string | null;
      profile_source_url: string | null;
      profile_observed_at: unknown;
      profile_content_hash: string | null;
      profile_agent_job_id: string | null;
    }>(
      `select lead_id, business_id, status, completeness_score, missing_fields,
              last_profile_enrichment_at, last_company_enrichment_at, last_context_build_at,
              last_error_code, profile_source_type, profile_source_url, profile_observed_at,
              profile_content_hash, profile_agent_job_id
         from public.lead_enrichment
        where lead_id = $1`,
      [leadId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      leadId: String(row.lead_id),
      businessId: String(row.business_id),
      status: isEnrichmentState(row.status) ? row.status : 'MINIMAL',
      completenessScore: asNumber(row.completeness_score, 0),
      missingFields: asStringArray(row.missing_fields),
      lastProfileEnrichmentAt: asIso(row.last_profile_enrichment_at),
      lastCompanyEnrichmentAt: asIso(row.last_company_enrichment_at),
      lastContextBuildAt: asIso(row.last_context_build_at),
      lastErrorCode: row.last_error_code,
      profileSourceType: row.profile_source_type,
      profileSourceUrl: row.profile_source_url,
      profileObservedAt: asIso(row.profile_observed_at),
      profileContentHash: row.profile_content_hash,
      profileAgentJobId: row.profile_agent_job_id === null ? null : String(row.profile_agent_job_id),
    };
  });
}

/* -------------------------------------------------------------- writes --- */

export type RecomputeResult =
  | {
      readonly ok: true;
      readonly status: EnrichmentState;
      readonly completenessScore: number;
      readonly missingFields: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Recomputes the score, the missing-field list and the fact-derived state.
 *
 * Spec §14.4 requires the score and the state to move together, which is why this
 * is one function: a status change that leaves the score stale is a defect. The
 * status is only moved along a permitted edge (`permittedFactsState`), so a
 * recompute can never erase `NEEDS_REVIEW` or a state that says work is in flight.
 */
export async function recomputeLeadEnrichment(
  viewer: Viewer,
  leadId: string,
): Promise<RecomputeResult> {
  try {
    return await withActor(viewer.actor, async (sql) => recomputeLeadEnrichmentWith(sql, leadId));
  } catch (error) {
    return { ok: false, error: describeDbError(error, 'recomputeLeadEnrichment') };
  }
}

/**
 * The same recomputation against an open transaction.
 *
 * Exists so a commit that writes `lead_enrichment` can recompute the score and the
 * missing-field list **in that same transaction**, which §14.4 requires: a status
 * change that leaves the score stale is a defect, and a second transaction is how
 * that happens.
 */
export async function recomputeLeadEnrichmentWith(sql: Db, leadId: string): Promise<RecomputeResult> {
  const row = await loadFactRow(sql, leadId);
  if (row === null) return { ok: false, error: 'That lead could not be found.' };

  const facts = factsFrom(row);
  const completeness = intelligenceCompleteness(facts);
  const derived = enrichmentStateFromFacts(facts);
  const current =
    row.stored_status !== null && isEnrichmentState(row.stored_status) ? row.stored_status : derived;
  const next = permittedFactsState(current, derived);

  await sql.query(
    `update public.lead_enrichment
        set status = $2,
            completeness_score = $3,
            missing_fields = $4,
            updated_at = now()
      where lead_id = $1`,
    [leadId, next, completeness.score, completeness.missing],
  );

  return {
    ok: true,
    status: next,
    completenessScore: completeness.score,
    missingFields: completeness.missing,
  };
}

export interface RecordProfileEnrichmentInput {
  readonly leadId: string;
  /** Set when the caller is making an explicit pipeline decision. */
  readonly status?: EnrichmentState;
  readonly contentHash: string;
  readonly sourceType: string;
  readonly sourceUrl: string | null;
  readonly agentJobId?: string | null;
  readonly observedAt?: string;
}

/**
 * Records the *permanent* provenance of a profile extraction.
 *
 * The raw body is deleted by the time this runs; what survives is the hash that
 * proves which bytes produced the current facts, plus the source, the observation
 * time and the prompt version that read them.
 */
export async function recordProfileEnrichment(
  viewer: Viewer,
  input: RecordProfileEnrichmentInput,
): Promise<void> {
  await withActor(viewer.actor, async (sql) => recordProfileEnrichmentWith(sql, input));
}

/** The same provenance write against an open transaction. */
export async function recordProfileEnrichmentWith(
  sql: Db,
  input: RecordProfileEnrichmentInput,
): Promise<void> {
  await sql.query(
    `update public.lead_enrichment
        set last_profile_enrichment_at = now(),
            profile_source_type = $2,
            profile_source_url = $3,
            profile_observed_at = coalesce($4::timestamptz, now()),
            profile_content_hash = $5,
            profile_agent_job_id = $6,
            status = coalesce($7, status),
            -- A successful extraction is not a failure: clearing the code here is
            -- what makes "the last thing that happened was a failure" stop being
            -- displayed after a retry succeeds.
            last_error_code = null,
            updated_at = now()
      where lead_id = $1`,
    [
      input.leadId,
      input.sourceType,
      input.sourceUrl,
      input.observedAt ?? null,
      input.contentHash,
      input.agentJobId ?? null,
      input.status ?? null,
    ],
  );
}

/** Records that committed company research exists for this lead. */
export async function recordCompanyEnrichment(viewer: Viewer, leadId: string): Promise<void> {
  await withActor(viewer.actor, async (sql) => recordCompanyEnrichmentWith(sql, leadId));
}

/** The same company-enrichment timestamp against an open transaction. */
export async function recordCompanyEnrichmentWith(sql: Db, leadId: string): Promise<void> {
  await sql.query(
    `update public.lead_enrichment
        set last_company_enrichment_at = now(), last_error_code = null, updated_at = now()
      where lead_id = $1`,
    [leadId],
  );
}

/** Records that a context pack was built (or refreshed) for this lead. */
export async function recordContextBuild(viewer: Viewer, leadId: string): Promise<void> {
  await withActor(viewer.actor, async (sql) => {
    await sql.query(
      `update public.lead_enrichment
          set last_context_build_at = now(), updated_at = now()
        where lead_id = $1`,
      [leadId],
    );
  });
}

/**
 * Sets an explicit pipeline state.
 *
 * `errorCode` is required by the callers that use this for `FAILED` and is stored
 * as a stable machine string — never a sentence, never an upstream body.
 */
export async function setEnrichmentStatus(
  viewer: Viewer,
  leadId: string,
  status: EnrichmentState,
  errorCode?: string | null,
): Promise<void> {
  await withActor(viewer.actor, async (sql) => {
    await sql.query(
      `update public.lead_enrichment
          set status = $2,
              last_error_code = case
                -- A transition out of FAILED clears the code; anything else keeps
                -- whatever the caller supplied (including null, meaning "resolved").
                when $2 <> 'FAILED' then $3
                else coalesce($3, 'unknown')
              end,
              updated_at = now()
        where lead_id = $1`,
      [leadId, status, errorCode ?? null],
    );
  });
}

/* ---------------------------------------------------------------- lists -- */

export interface LeadNeedingEnrichment {
  readonly leadId: string;
  readonly status: EnrichmentState;
  readonly completenessScore: number;
  readonly missingFields: readonly string[];
}

/**
 * Leads whose enrichment is outstanding or failed, newest first.
 *
 * Reads the stored score rather than recomputing it: this feeds a work list, and
 * fifty per-row fact queries per page render would be the performance defect spec
 * §76 forbids.
 */
export async function listLeadsNeedingEnrichment(
  viewer: Viewer,
  businessId: string,
  limit = 50,
): Promise<readonly LeadNeedingEnrichment[]> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{
      lead_id: string;
      status: string;
      completeness_score: number;
      missing_fields: string[] | null;
    }>(
      `select e.lead_id, e.status, e.completeness_score, e.missing_fields
         from public.lead_enrichment e
         join public.leads l on l.id = e.lead_id
        where e.business_id = $1
          and l.deleted_at is null
          and e.status in ('NEEDS_PROFILE', 'COMPANY_RESEARCH_PENDING', 'AGENT_RESEARCH_PENDING', 'FAILED')
        order by e.updated_at desc
        limit $2`,
      [businessId, Math.max(1, Math.trunc(limit))],
    );

    return result.rows.map((row) => ({
      leadId: String(row.lead_id),
      status: isEnrichmentState(row.status) ? row.status : 'MINIMAL',
      completenessScore: asNumber(row.completeness_score, 0),
      missingFields: asStringArray(row.missing_fields),
    }));
  });
}
