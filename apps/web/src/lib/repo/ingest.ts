/**
 * External ingest pipeline.
 *
 * spec `api_contract.external_ingest.pipeline`, implemented literally and in order,
 * with every stage recorded so the caller and the audit trail can see what ran:
 *
 *   validate -> normalize -> dedupe -> persist source evidence ->
 *   apply business/ICP rules -> create/update candidate/lead -> assignment ->
 *   optional sequence enrollment -> audit
 *
 * Two rules are non-negotiable here:
 *   - **Idempotency.** A duplicate `(source_client, business_id, idempotency_key)`
 *     returns the recorded outcome and writes nothing. A retrying agent must never be
 *     able to create a second lead by asking twice.
 *   - **Dedupe before create.** The canonical person is resolved (normalized LinkedIn
 *     URL first, then name+company) *before* any lead row is inserted, and rediscovery
 *     adds evidence rather than a second identity.
 */
import 'server-only';

import { contentHash, normalizeLinkedInUrl, slugify } from '@nexus/core';

import { withActor, type Actor } from '../actor';
import type { Row } from '../sql';
import { asString, asStringOrNull } from './common';

/** The pipeline stages, in the order the spec lists them. */
export const PIPELINE_STAGES = [
  'validate',
  'normalize',
  'dedupe',
  'persist_source_evidence',
  'apply_business_icp_rules',
  'create_or_update_lead',
  'assignment',
  'sequence_enrollment',
  'audit',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface IngestInput {
  readonly sourceClient: string;
  readonly businessId: string;
  readonly payloadType: string;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  /** ISO-8601. The envelope schema normalises a `Date` to a string before this. */
  readonly observedAt: string;
  readonly businessKeyOrId: string;
}

export interface IngestOutcome {
  readonly idempotent: boolean;
  readonly stages: readonly PipelineStage[];
  readonly leadId?: string;
  readonly personId?: string;
  readonly companyId?: string;
  readonly duplicateCandidateId?: string;
}

interface CandidatePayload {
  readonly full_name?: string | null;
  readonly name?: string | null;
  readonly job_title?: string | null;
  readonly title?: string | null;
  readonly company_name?: string | null;
  readonly company?: string | null;
  readonly linkedin_url?: string | null;
  readonly location?: string | null;
  readonly source_url?: string | null;
  readonly notes?: string | null;
}

/** Reads a string field off an unvalidated payload without trusting its shape. */
function field(payload: unknown, key: keyof CandidatePayload): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function submitIngest(actor: Actor, input: IngestInput): Promise<IngestOutcome> {
  const stages: PipelineStage[] = ['validate'];

  const hash = contentHash({ payload: input.payload, observedAt: input.observedAt });

  return withActor(actor, async (sql) => {
    // ---------------------------------------------------------------- idempotency --
    const existing = await sql.query<{ result: unknown; status: string }>(
      `select result, status from public.ingest_requests
        where source_client = $1 and business_id = $2 and idempotency_key = $3
        limit 1`,
      [input.sourceClient, input.businessId, input.idempotencyKey],
    );

    const priorRow = existing.rows[0];
    // `processed` and `duplicate` both mean "this key has already been fully applied"; `received` means
    // a previous attempt died mid-pipeline, which must be retried rather than replayed.
    if (
      priorRow !== undefined &&
      (priorRow.status === 'processed' || priorRow.status === 'duplicate') &&
      typeof priorRow.result === 'object' &&
      priorRow.result !== null
    ) {
      const prior = priorRow.result as Record<string, unknown>;
      return {
        idempotent: true,
        stages: ['validate'],
        ...(typeof prior.leadId === 'string' ? { leadId: prior.leadId } : {}),
        ...(typeof prior.personId === 'string' ? { personId: prior.personId } : {}),
        ...(typeof prior.companyId === 'string' ? { companyId: prior.companyId } : {}),
        ...(typeof prior.duplicateCandidateId === 'string'
          ? { duplicateCandidateId: prior.duplicateCandidateId }
          : {}),
      };
    }

    // Record the request up front so a crash mid-pipeline leaves an auditable trace
    // rather than an unexplained missing row.
    //
    // `received` is the in-flight value. The status vocabulary is closed — `received`, `processed`,
    // `failed`, `duplicate` — and an earlier version of this ledger wrote `processing`, which is not
    // one of them, so the insert was rejected and the whole ingest failed before it started.
    await sql.query(
      `insert into public.ingest_requests
         (source_client, business_id, payload_type, idempotency_key, observed_at, payload, content_hash, status)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'received')
       on conflict (source_client, business_id, idempotency_key) do update
         set status = 'received', payload = excluded.payload`,
      [
        input.sourceClient,
        input.businessId,
        input.payloadType,
        input.idempotencyKey,
        input.observedAt,
        JSON.stringify(input.payload),
        hash,
      ],
    );

    // ---------------------------------------------------------------- normalize --
    stages.push('normalize');
    const fullName = field(input.payload, 'full_name') ?? field(input.payload, 'name');
    const companyName = field(input.payload, 'company_name') ?? field(input.payload, 'company');
    const jobTitle = field(input.payload, 'job_title') ?? field(input.payload, 'title');
    const linkedinRaw = field(input.payload, 'linkedin_url');
    const sourceUrl = field(input.payload, 'source_url');
    const location = field(input.payload, 'location');

    const linkedin = normalizeLinkedInUrl(linkedinRaw);
    const normalizedName = fullName === null ? null : slugify(fullName);
    const normalizedCompany = companyName === null ? null : slugify(companyName);

    // ------------------------------------------------------------------- dedupe --
    stages.push('dedupe');

    let personId: string | null = null;
    if (linkedin.canonicalUrl !== null) {
      const byUrl = await sql.query<{ id: string }>(
        `select id from public.people where normalized_linkedin_url = $1 and deleted_at is null limit 1`,
        [linkedin.canonicalUrl],
      );
      personId = byUrl.rows[0]?.id ?? null;
    }
    if (personId === null && normalizedName !== null) {
      const byName = await sql.query<{ id: string }>(
        `select p.id from public.people p
           left join public.companies c on c.id = p.company_id
          where p.normalized_name = $1
            and ($2::text is null or c.normalized_name = $2)
          limit 1`,
        [normalizedName, normalizedCompany],
      );
      personId = byName.rows[0]?.id ?? null;
    }

    let companyId: string | null = null;
    if (normalizedCompany !== null) {
      const byCompany = await sql.query<{ id: string }>(
        `select id from public.companies where normalized_name = $1 limit 1`,
        [normalizedCompany],
      );
      companyId = byCompany.rows[0]?.id ?? null;
      if (companyId === null) {
        const created = await sql.query<{ id: string }>(
          `insert into public.companies (name, normalized_name, created_by)
           values ($1, $2, null) returning id`,
          [companyName, normalizedCompany],
        );
        companyId = created.rows[0]?.id ?? null;
      }
    }

    if (personId === null) {
      const created = await sql.query<{ id: string }>(
        `insert into public.people
           (full_name, normalized_name, job_title, location, linkedin_url, normalized_linkedin_url, company_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          fullName ?? 'Unknown (external candidate)',
          normalizedName ?? slugify(fullName ?? 'unknown'),
          jobTitle,
          location,
          linkedinRaw,
          linkedin.canonicalUrl,
          companyId,
        ],
      );
      personId = created.rows[0]?.id ?? null;
    }

    if (personId === null) throw new Error('The person record could not be resolved.');

    // -------------------------------------------------- persist source evidence --
    stages.push('persist_source_evidence');
    await sql.query(
      `insert into public.source_evidence
         (business_id, person_id, company_id, source, source_url, raw_text_or_json, content_hash,
          observed_at, confidence, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null)
       on conflict (business_id, content_hash) do nothing`,
      [
        input.businessId,
        personId,
        companyId,
        input.sourceClient,
        sourceUrl ?? linkedin.canonicalUrl,
        JSON.stringify(input.payload).slice(0, 100_000),
        hash,
        input.observedAt,
        // External agent submissions are evidence, not verified truth.
        0.5,
      ],
    );

    // ------------------------------------------------ business / ICP + lead -------
    stages.push('apply_business_icp_rules');
    stages.push('create_or_update_lead');

    const existingLead = await sql.query<{ id: string; deleted_at: string | null }>(
      `select id, deleted_at from public.leads where business_id = $1 and person_id = $2 limit 1`,
      [input.businessId, personId],
    );

    const needsProfile = companyName === null || jobTitle === null;
    let leadId: string;
    const lead = existingLead.rows[0];

    if (lead !== undefined) {
      // One active Lead per (business, person): rediscovery updates, never duplicates.
      leadId = lead.id;
      await sql.query(
        `update public.leads
            set deleted_at = null,
                needs_profile = needs_profile or $2,
                last_activity_at = now()
          where id = $1`,
        [leadId, needsProfile],
      );
    } else {
      const inserted = await sql.query<{ id: string }>(
        // `external_ingest` is the declared source type for this path
        // (`LEAD_SOURCE_TYPES` in `@nexus/core`, and `leads_source_type_check`). The literal here used
        // to be `api_ingest`, which is not in the vocabulary — so this insert was rejected and every
        // externally ingested candidate failed. The filter bar offers a label, not a value.
        `insert into public.leads
           (business_id, person_id, company_id, status, source_type, source_url, needs_profile, last_activity_at)
         values ($1, $2, $3, $4, 'external_ingest', $5, $6, now())
         returning id`,
        [
          input.businessId,
          personId,
          companyId,
          needsProfile ? 'needs_profile' : 'ready',
          sourceUrl ?? linkedin.canonicalUrl,
          needsProfile,
        ],
      );
      leadId = inserted.rows[0]?.id ?? '';
      if (leadId.length === 0) throw new Error('The lead could not be created.');

      if (needsProfile) {
        await sql.query(
          `insert into public.profile_capture_queue (business_id, lead_id, person_id, state, reason)
           values ($1, $2, $3, 'pending', 'external ingest was partial')
           on conflict do nothing`,
          [input.businessId, leadId, personId],
        );
      }
    }

    // ------------------------------------------------------------------ audit ----
    stages.push('audit');
    await sql.query(
      `insert into public.audit_events
         (actor_type, actor_id, business_id, entity_type, entity_id, action, after_json, source_client, api_client_id)
       values (
         case when public.acting_api_client_id() is not null then 'api_client' else 'system' end,
         public.acting_api_client_id(),
         $1, 'ingest_requests', $2, 'ingest', $3::jsonb, $4, public.acting_api_client_id()
       )`,
      [
        input.businessId,
        leadId,
        JSON.stringify({ payload_type: input.payloadType, stages, person_id: personId }),
        input.sourceClient,
      ],
    );

    await sql.query(
      // `processed`, not `completed`: `ingest_requests_status_check` allows `received`, `processed`,
      // `failed` and `duplicate`. This ledger used to write `completed`, and because the row is part of
      // the same transaction as the lead it was rolled back with it — every `nexus.submit_candidate`
      // call through the MCP gateway failed at the first write. The vocabulary is used verbatim.
      `update public.ingest_requests
          set status = 'processed', result = $4::jsonb
        where source_client = $1 and business_id = $2 and idempotency_key = $3`,
      [
        input.sourceClient,
        input.businessId,
        input.idempotencyKey,
        JSON.stringify({ leadId, personId, companyId: companyId ?? undefined, stages }),
      ],
    );

    return {
      idempotent: false,
      stages,
      leadId,
      personId,
      ...(companyId === null ? {} : { companyId }),
    };
  });
}

/** Messages from an external client, applied through the same reply path as a UI. */
export async function recordExternalReply(
  actor: Actor,
  input: { readonly leadId: string; readonly exactText: string; readonly outcome: string; readonly sourceClient: string },
): Promise<void> {
  await withActor(actor, async (sql) => {
    await sql.query(`select public.capture_reply($1, $2, $3, $4, $5, now())`, [
      input.leadId,
      input.exactText,
      input.outcome,
      null,
      input.sourceClient,
    ]);
  });
}

export function summariseIngestRow(row: Row): { readonly id: string; readonly status: string } {
  return { id: asString(row.id), status: asString(row.status, 'unknown') };
}

export { asStringOrNull };
