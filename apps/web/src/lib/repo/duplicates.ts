/**
 * Duplicate Review (A07).
 *
 * spec `lead_sources.duplicate_review`:
 *   - "merge into existing"
 *   - "keep separate only when truly different person/entity"
 *   - "skip"
 *
 * The three resolutions are one database function —
 * `public.merge_duplicate_candidate(candidate_id, actor, resolution)` — so the
 * decision, the lead moves, the soft deletes and the audit event can never get
 * out of step. This module only builds the comparison the operator needs and
 * calls that function; it never edits a person or a lead directly.
 *
 * spec `lead_invariants`: "Rediscovery creates a new Signal/SourceEvidence, not a
 * duplicate Person/Company" and "Within the same business, a Person may have only
 * one active Lead record" — which is why `merge` soft-deletes or re-points the
 * incoming lead instead of leaving two.
 */
import 'server-only';

import { DUPLICATE_RESOLUTIONS, type DuplicateResolution } from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Row } from '../sql';
import { asIso, asNumber, asNumberOrNull, asString, asStringOrNull, describeDbError, read, readOne } from './common';

export interface DuplicatePerson {
  readonly id: string;
  readonly fullName: string;
  readonly headline: string | null;
  readonly jobTitle: string | null;
  readonly location: string | null;
  readonly linkedinUrl: string | null;
  readonly normalizedLinkedinUrl: string | null;
  readonly companyName: string | null;
  readonly companyDomain: string | null;
  readonly isDeleted: boolean;
}

export interface DuplicateLeadSummary {
  readonly id: string;
  readonly status: string;
  readonly deletedAt: string | null;
  readonly sourceType: string | null;
  readonly primaryIcpName: string | null;
  readonly ownerName: string | null;
  readonly createdAt: string | null;
  readonly sentMessages: number;
  readonly replies: number;
}

export interface DuplicateCandidate {
  readonly id: string;
  readonly businessId: string;
  readonly status: string;
  readonly matchReason: string | null;
  readonly confidence: number | null;
  readonly resolution: string | null;
  readonly createdAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedByName: string | null;
  readonly importBatchId: string | null;
  readonly incoming: DuplicatePerson | null;
  readonly existing: DuplicatePerson | null;
  readonly incomingLead: DuplicateLeadSummary | null;
  readonly existingLead: DuplicateLeadSummary | null;
}

export interface DuplicateCounts {
  readonly open: number;
  readonly merged: number;
  readonly keptSeparate: number;
  readonly skipped: number;
}

function mapPerson(row: Row, prefix: string): DuplicatePerson | null {
  const id = asStringOrNull(row[`${prefix}_id`]);
  if (id === null) return null;
  return {
    id,
    fullName: asString(row[`${prefix}_full_name`], 'Unknown'),
    headline: asStringOrNull(row[`${prefix}_headline`]),
    jobTitle: asStringOrNull(row[`${prefix}_job_title`]),
    location: asStringOrNull(row[`${prefix}_location`]),
    linkedinUrl: asStringOrNull(row[`${prefix}_linkedin_url`]),
    normalizedLinkedinUrl: asStringOrNull(row[`${prefix}_normalized_linkedin_url`]),
    companyName: asStringOrNull(row[`${prefix}_company_name`]),
    companyDomain: asStringOrNull(row[`${prefix}_company_domain`]),
    isDeleted: asIso(row[`${prefix}_deleted_at`]) !== null,
  };
}

const CANDIDATE_SELECT = `
  select d.id, d.business_id, d.status, d.match_reason, d.confidence, d.resolution,
         d.created_at, d.resolved_at, d.payload, d.incoming_person_id, d.existing_person_id,
         d.existing_lead_id, il.id as incoming_lead_id, ru.full_name as resolved_by_name,
         ip.id as incoming_id, ip.full_name as incoming_full_name, ip.headline as incoming_headline,
         ip.job_title as incoming_job_title, ip.location as incoming_location,
         ip.linkedin_url as incoming_linkedin_url,
         ip.normalized_linkedin_url as incoming_normalized_linkedin_url,
         ip.deleted_at as incoming_deleted_at,
         ic.name as incoming_company_name,
         ic.normalized_domain as incoming_company_domain,
         ep.id as existing_id, ep.full_name as existing_full_name, ep.headline as existing_headline,
         ep.job_title as existing_job_title, ep.location as existing_location,
         ep.linkedin_url as existing_linkedin_url,
         ep.normalized_linkedin_url as existing_normalized_linkedin_url,
         ep.deleted_at as existing_deleted_at,
         ec.name as existing_company_name,
         ec.normalized_domain as existing_company_domain
    from public.duplicate_candidates d
    left join public.users ru on ru.id = d.resolved_by
    left join public.people ip on ip.id = d.incoming_person_id
    left join public.companies ic on ic.id = ip.company_id
    left join public.people ep on ep.id = d.existing_person_id
    left join public.companies ec on ec.id = ep.company_id
    left join lateral (
      -- The row stores only the *existing* side's lead. The incoming side has no column of
      -- its own because the merge resolves it from the person, so it is derived the same
      -- way merge_duplicate_candidate does: the active lead for that person in this business.
      select l.id
        from public.leads l
       where l.person_id = d.incoming_person_id
         and l.business_id = d.business_id
         and l.deleted_at is null
       order by l.created_at desc
       limit 1
    ) il on true`;

function mapCandidate(row: Row, leads: readonly DuplicateLeadSummary[]): DuplicateCandidate {
  const payload = (row.payload ?? {}) as { import_batch_id?: unknown };
  return {
    id: asString(row.id),
    businessId: asString(row.business_id),
    status: asString(row.status, 'open'),
    matchReason: asStringOrNull(row.match_reason),
    confidence: asNumberOrNull(row.confidence),
    resolution: asStringOrNull(row.resolution),
    createdAt: asIso(row.created_at),
    resolvedAt: asIso(row.resolved_at),
    resolvedByName: asStringOrNull(row.resolved_by_name),
    importBatchId: typeof payload.import_batch_id === 'string' ? payload.import_batch_id : null,
    incoming: mapPerson(row, 'incoming'),
    existing: mapPerson(row, 'existing'),
    // `loadLeadsForPeople` loads every lead for both people, so both lookups have to be
    // scoped to the side they belong to: without the person filter a candidate would show
    // the incoming lead as its existing lead whenever the two people share a business.
    incomingLead: leads.find((lead) => lead.id === asStringOrNull(row.incoming_lead_id)) ?? null,
    existingLead: leads.find((lead) => lead.id === asStringOrNull(row.existing_lead_id)) ?? null,
  };
}

/** Open candidates first, newest first — the review order. */
export async function listDuplicateCandidates(
  actor: Actor,
  businessId: string,
  status = 'open',
  limit = 50,
): Promise<readonly DuplicateCandidate[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `${CANDIDATE_SELECT}
        where d.business_id = $1 and d.status = $2
        order by d.confidence desc nulls last, d.created_at desc
        limit $3`,
      [businessId, status, capped],
    );

    const personIds = result.rows
      .flatMap((row: Row) => [asStringOrNull(row.incoming_id), asStringOrNull(row.existing_id)])
      .filter((id): id is string => id !== null);
    const leads = await loadLeadsForPeople(sql, businessId, personIds);
    return result.rows.map((row: Row) => mapCandidate(row, leads));
  });
}

export async function getDuplicateCandidate(
  actor: Actor,
  candidateId: string,
): Promise<DuplicateCandidate | null> {
  return readOne(actor, async (sql) => {
    const result = await sql.query<Row>(`${CANDIDATE_SELECT} where d.id = $1`, [candidateId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const personIds = [asStringOrNull(row.incoming_id), asStringOrNull(row.existing_id)].filter(
      (id): id is string => id !== null,
    );
    const leads = await loadLeadsForPeople(sql, asString(row.business_id), personIds);
    return mapCandidate(row, leads);
  });
}

/**
 * The lead context on both sides of the comparison.
 *
 * `sentMessages` and `replies` are the evidence for "keep separate is only for a
 * genuinely different person": once a lead has history, merging it is a decision
 * with consequences the operator must be able to see.
 */
async function loadLeadsForPeople(
  sql: { query<T extends Row>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }> },
  businessId: string,
  personIds: readonly string[],
): Promise<readonly DuplicateLeadSummary[]> {
  if (personIds.length === 0) return [];
  const result = await sql.query<Row>(
    `select l.id, l.status, l.deleted_at, l.source_type, l.created_at,
            i.name as primary_icp_name, u.full_name as owner_name,
            (select count(*)::int from public.message_instances mi
              where mi.lead_id = l.id and mi.sent_at is not null) as sent_messages,
            (select count(*)::int from public.conversation_outcomes co
              where co.lead_id = l.id) as replies
       from public.leads l
       left join public.icps i on i.id = l.primary_icp_id
       left join public.users u on u.id = l.owner_user_id
      where l.business_id = $1 and l.person_id = any($2::uuid[])`,
    [businessId, personIds],
  );
  return result.rows.map((row: Row) => ({
    id: asString(row.id),
    status: asString(row.status, 'new'),
    deletedAt: asIso(row.deleted_at),
    sourceType: asStringOrNull(row.source_type),
    primaryIcpName: asStringOrNull(row.primary_icp_name),
    ownerName: asStringOrNull(row.owner_name),
    createdAt: asIso(row.created_at),
    sentMessages: asNumber(row.sent_messages),
    replies: asNumber(row.replies),
  }));
}

export async function getDuplicateCounts(actor: Actor, businessId: string): Promise<DuplicateCounts> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select
         count(*) filter (where status = 'open')::int as open,
         count(*) filter (where status = 'merged')::int as merged,
         count(*) filter (where status = 'kept_separate')::int as kept_separate,
         count(*) filter (where status = 'skipped')::int as skipped
       from public.duplicate_candidates
       where business_id = $1`,
      [businessId],
    );
    return {
      open: asNumber(result.rows[0]?.open),
      merged: asNumber(result.rows[0]?.merged),
      keptSeparate: asNumber(result.rows[0]?.kept_separate),
      skipped: asNumber(result.rows[0]?.skipped),
    };
  });
}

export interface ResolutionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly status: string | null;
  readonly leadsMoved: number;
  readonly leadsSoftDeleted: number;
}

/**
 * Applies one of the three resolutions through the audited database function.
 *
 * `resolution` is validated against the shared vocabulary before it reaches SQL,
 * and the function re-validates it — an unknown value cannot be smuggled in.
 */
export async function resolveDuplicate(
  viewer: Viewer,
  candidateId: string,
  resolution: DuplicateResolution,
): Promise<ResolutionResult> {
  if (!DUPLICATE_RESOLUTIONS.includes(resolution)) {
    return { ok: false, error: 'That resolution is not supported.', status: null, leadsMoved: 0, leadsSoftDeleted: 0 };
  }

  try {
    return await withActor(viewer.actor, async (sql) => {
      await sql.exec(`select set_config('nexus.source_client', 'web', true)`);
      const result = await sql.query<Row>(
        `select public.merge_duplicate_candidate($1, $2, $3) as result`,
        [candidateId, viewer.userId, resolution],
      );
      const payload = result.rows[0]?.result as
        | { status?: unknown; leads_moved?: unknown; leads_soft_deleted?: unknown }
        | undefined;
      return {
        ok: true,
        error: null,
        status: asStringOrNull(payload?.status),
        leadsMoved: asNumber(payload?.leads_moved),
        leadsSoftDeleted: asNumber(payload?.leads_soft_deleted),
      };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error), status: null, leadsMoved: 0, leadsSoftDeleted: 0 };
  }
}
