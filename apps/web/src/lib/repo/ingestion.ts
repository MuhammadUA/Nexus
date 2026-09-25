/**
 * Ingestion: import batches, rows and the admin Import Builder (A05 / A20).
 *
 * spec `lead_sources`:
 *   - `required_context_each_ingestion`: "Business, Primary ICP OR Auto-match".
 *   - `import_batch.must_track`: source, business, requested_primary_icp,
 *     created/updated/duplicate/needs_profile/failed counts, created_by,
 *     created_at.
 *   - `import_batch.undo`: "Support undo for recent import by reverting records
 *     created exclusively by that import while preserving pre-existing
 *     records/history" — implemented by `public.undo_import`.
 *   - `google.missing_profile_behavior` / `profile_queue_flow`: a partial record
 *     is still created, flagged Needs Profile and queued for capture.
 *
 * Every ingestion path in this module runs the spec pipeline in order:
 *
 *   validate -> normalize -> dedupe -> persist source evidence -> apply ICP rules
 *   -> create/update the lead -> assign -> queue profile capture -> audit
 *
 * Normalization and dedupe come from `@nexus/core` and are the single
 * implementation shared by the web app, the extension and the API gateway;
 * nothing here re-implements them. The database enforces the same rules again
 * (`leads_business_person_active_key`, `people_normalized_linkedin_key`,
 * `import_batches_idempotency_key`), so a caller that skipped this module still
 * could not create a second active lead for one person.
 *
 * The view-model types and the pure parsing helpers live in
 * `@/lib/ingestion-view`, because the wizard is a client component and may not
 * import this `server-only` module. They are re-exported below so callers have
 * one place to import from.
 */
import 'server-only';

import {
  assignPrimaryIcp,
  contentHash,
  candidatePersonSchema,
  decidePersonDedupe,
  deriveIdempotencyKey,
  ingestEnvelopeSchema,
  matchPerson,
  normalizeCompanyName,
  normalizeDomain,
  normalizeLinkedInUrl,
  normalizePersonName,
  resolveLeadForPerson,
  type ExistingCompany,
  type ExistingLead,
  type ExistingPerson,
  type IcpLike,
  type LeadSourceType,
} from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Db, Row } from '../sql';
import {
  asIso,
  asNumber,
  asString,
  asStringOrNull,
  describeDbError,
  read,
  readOne,
} from './common';
import {
  ZERO_EXECUTE_COUNTS,
  mapRowsToCandidates,
  missingRequiredMapping,
  planPayloadFor,
  parseDelimitedText,
  suggestMapping,
  toImportPreview,
  IMPORT_BATCH_SOURCES,
  MAPPING_FIELDS,
  type ExecuteCounts,
  type FailedRow,
  type ImportBatchSource,
  type ImportPreview,
  type IngestionPlan,
  type PlanPayload,
  type PlannedRow,
  type RawRow,
} from '../ingestion-view';

export {
  IMPORT_BATCH_SOURCES,
  MAPPING_FIELDS,
  mapRowsToCandidates,
  missingRequiredMapping,
  parseDelimitedText,
  planPayloadFor,
  suggestMapping,
  toImportPreview,
  ZERO_EXECUTE_COUNTS,
};
export type {
  ExecuteCounts,
  FailedRow,
  ImportBatchSource,
  ImportPreview,
  IngestionPlan,
  MappingField,
  MappingSummary,
  PlanPayload,
  PlannedRow,
  RawRow,
  RowPreview,
  RowPreviewOutcome,
} from '../ingestion-view';

/* ------------------------------------------------------------------ types -- */

export interface ImportBatch {
  readonly id: string;
  readonly source: string;
  readonly businessName: string | null;
  readonly requestedPrimaryIcp: string | null;
  readonly requestedIcpId: string | null;
  readonly autoMatch: boolean;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly duplicateCount: number;
  readonly needsProfileCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly rowCount: number;
  readonly status: string;
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string | null;
  readonly undoneAt: string | null;
  readonly undoneByName: string | null;
  readonly idempotencyKey: string | null;
}

export interface ImportRow {
  readonly id: string;
  readonly rowNumber: number;
  readonly result: string;
  readonly message: string | null;
  readonly leadId: string | null;
  readonly personName: string | null;
  readonly createdAt: string | null;
}

/* --------------------------------------------------------------- reading -- */

function mapBatch(row: Row): ImportBatch {
  return {
    id: asString(row.id),
    source: asString(row.source, 'external_ingest'),
    businessName: asStringOrNull(row.business),
    requestedPrimaryIcp: asStringOrNull(row.requested_primary_icp),
    requestedIcpId: asStringOrNull(row.requested_icp_id),
    autoMatch: row.auto_match === true,
    createdCount: asNumber(row.created_count),
    updatedCount: asNumber(row.updated_count),
    duplicateCount: asNumber(row.duplicate_count),
    needsProfileCount: asNumber(row.needs_profile_count),
    failedCount: asNumber(row.failed_count),
    skippedCount: asNumber(row.skipped_count),
    rowCount: asNumber(row.row_count),
    status: asString(row.status, 'pending'),
    createdBy: asStringOrNull(row.created_by),
    createdByName: asStringOrNull(row.created_by_name),
    createdAt: asIso(row.created_at),
    undoneAt: asIso(row.undone_at),
    undoneByName: asStringOrNull(row.undone_by_name),
    idempotencyKey: asStringOrNull(row.idempotency_key),
  };
}

const BATCH_SELECT = `
  select b.id, b.source, b.business, b.requested_primary_icp, b.requested_icp_id,
         b.auto_match, b.created_count, b.updated_count, b.duplicate_count,
         b.needs_profile_count, b.failed_count, b.skipped_count, b.row_count,
         b.status, b.created_by, b.created_at, b.undone_at, b.idempotency_key,
         cu.full_name as created_by_name, uu.full_name as undone_by_name
    from public.import_batches b
    left join public.users cu on cu.id = b.created_by
    left join public.users uu on uu.id = b.undone_by`;

/** Recent batches for the Lead Sources hub, newest first. */
export async function listImportBatches(
  actor: Actor,
  businessId: string,
  limit = 20,
): Promise<readonly ImportBatch[]> {
  const capped = Math.min(Math.max(limit, 1), 100);
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `${BATCH_SELECT}
        where b.business_id = $1
        order by b.created_at desc
        limit $2`,
      [businessId, capped],
    );
    return result.rows.map(mapBatch);
  });
}

export async function getImportBatch(actor: Actor, batchId: string): Promise<ImportBatch | null> {
  return readOne(actor, async (sql) => {
    const result = await sql.query<Row>(`${BATCH_SELECT} where b.id = $1`, [batchId]);
    const row = result.rows[0];
    return row === undefined ? null : mapBatch(row);
  });
}

/** The per-row ledger of one batch — what the batch actually did. */
export async function listImportRows(
  actor: Actor,
  batchId: string,
  limit = 200,
): Promise<readonly ImportRow[]> {
  const capped = Math.min(Math.max(limit, 1), 500);
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select r.id, r.row_number, r.result, r.message, r.lead_id, r.created_at,
              p.full_name as person_name
         from public.import_rows r
         left join public.people p on p.id = r.person_id
        where r.batch_id = $1
        order by r.row_number
        limit $2`,
      [batchId, capped],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      rowNumber: asNumber(row.row_number),
      result: asString(row.result, 'pending'),
      message: asStringOrNull(row.message),
      leadId: asStringOrNull(row.lead_id),
      personName: asStringOrNull(row.person_name),
      createdAt: asIso(row.created_at),
    }));
  });
}

export interface IngestionCounts {
  readonly batches: number;
  readonly importsLast30Days: number;
  readonly openDuplicates: number;
  readonly profileQueueOpen: number;
}

/** The hub's four headline numbers, read from the real tables. */
export async function getIngestionCounts(actor: Actor, businessId: string): Promise<IngestionCounts> {
  return read(actor, async (sql) => {
    const batches = await sql.query<Row>(
      `select
         count(*)::int as batches,
         count(*) filter (where created_at > now() - interval '30 days')::int as recent
       from public.import_batches
       where business_id = $1`,
      [businessId],
    );
    const duplicates = await sql.query<Row>(
      `select count(*)::int as open from public.duplicate_candidates
        where business_id = $1 and status = 'open'`,
      [businessId],
    );
    const queue = await sql.query<Row>(
      `select count(*)::int as open from public.profile_capture_queue
        where business_id = $1 and state in ('pending', 'in_progress')`,
      [businessId],
    );
    return {
      batches: asNumber(batches.rows[0]?.batches),
      importsLast30Days: asNumber(batches.rows[0]?.recent),
      openDuplicates: asNumber(duplicates.rows[0]?.open),
      profileQueueOpen: asNumber(queue.rows[0]?.open),
    };
  });
}

/* ---------------------------------------------------------- prepare plan -- */

interface BasePerson extends ExistingPerson {
  readonly deleted_at: string | null;
}

interface BaseLead extends ExistingLead {
  readonly person_name: string;
}

function candidateFor(row: RawRow): unknown {
  return {
    ...(row.name.length === 0 ? {} : { full_name: row.name }),
    ...(row.jobTitle.length === 0 ? {} : { job_title: row.jobTitle }),
    ...(row.company.length === 0 ? {} : { company_name: row.company }),
    ...(row.location.length === 0 ? {} : { location: row.location }),
    ...(row.linkedinUrl.length === 0 ? {} : { linkedin_url: row.linkedinUrl }),
    ...(row.sourceUrl.length === 0 ? {} : { source_url: row.sourceUrl }),
  };
}

/**
 * Builds the whole import plan: validation, normalization, dedupe and ICP
 * assignment — with no writes at all.
 *
 * Both the preview and the import call this, so what the operator sees is
 * produced by the same code that will run the import and the two cannot drift.
 */
export async function prepareIngestion(
  actor: Actor,
  input: {
    readonly businessId: string;
    readonly businessKey: string;
    readonly businessName: string;
    readonly sourceType: ImportBatchSource;
    readonly icpSelection: IcpSelectionInput;
    readonly rows: readonly RawRow[];
    readonly observedAt?: string;
  },
): Promise<IngestionPlan> {
  return read(actor, async (sql) => {
    const icps = await loadIcps(sql, input.businessId);
    const candidates = await loadMatchCandidates(sql, input.businessId, input.rows);
    const existingLeads = candidates.leads;

    const rows: PlannedRow[] = [];
    const failed: FailedRow[] = [];

    for (const raw of input.rows) {
      // Every row is parsed with the shared candidate schema: unknown keys are
      // dropped, lengths are bounded and a bad URL fails the row rather than the
      // import.
      const parsed = candidatePersonSchema.safeParse(candidateFor(raw));
      if (!parsed.success) {
        failed.push({ line: raw.line, message: describeIssue(parsed.error.issues[0]?.message) });
        continue;
      }
      const candidate = parsed.data;

      const fullName = (candidate.full_name ?? '').trim();
      const companyName = (candidate.company_name ?? '').trim();
      const jobTitle = (candidate.job_title ?? '').trim();
      // spec `lead_sources.file.minimum_columns`: name, company and job title are
      // the floor for every ingestion path.
      if (fullName.length === 0) {
        failed.push({ line: raw.line, message: 'A name is required.' });
        continue;
      }
      if (companyName.length === 0) {
        failed.push({ line: raw.line, message: 'A company is required.' });
        continue;
      }
      if (jobTitle.length === 0) {
        failed.push({ line: raw.line, message: 'A job title is required.' });
        continue;
      }

      const linkedin = normalizeLinkedInUrl(candidate.linkedin_url ?? null).canonicalUrl;
      // spec `google.missing_profile_behavior`: partial data still becomes a lead,
      // flagged Needs Profile and queued — it is never silently dropped.
      const needsProfile = linkedin === null;

      const match = matchPerson(
        {
          fullName,
          jobTitle,
          companyName,
          linkedinUrl: candidate.linkedin_url ?? null,
          email: candidate.email ?? null,
          location: candidate.location ?? null,
        },
        candidates.people,
        candidates.companies,
      );
      const decision = decidePersonDedupe(match);

      const matchedPerson =
        match.personId === null ? undefined : candidates.people.find((p) => p.id === match.personId);
      const lead =
        match.personId === null
          ? undefined
          : existingLeads.find((l) => l.person_id === match.personId && l.deleted_at === null);

      const assignment = assignPrimaryIcp(
        input.icpSelection,
        {
          companyName,
          jobTitle,
          geography: candidate.location ?? null,
          companyIndustry: candidate.company_industry ?? null,
          companyEmployeeCount: candidate.company_employee_count ?? null,
        },
        icps,
      );
      if ('error' in assignment) {
        failed.push({
          line: raw.line,
          message: 'No ICP could be resolved for this row. Configure an ICP, or use Auto-match with a default ICP.',
        });
        continue;
      }

      const outcome: 'created' | 'updated' = lead === undefined ? 'created' : 'updated';
      const dedupe: PlannedRow['dedupe'] =
        decision.action === 'update_person' ? 'update' : decision.action === 'review' ? 'review' : 'create';

      rows.push({
        line: raw.line,
        raw,
        prepared: true,
        outcome,
        dedupe,
        matchReason: decision.action === 'create_person' ? null : match.reason,
        confidence: decision.confidence,
        matchedPersonId: match.personId,
        matchedPersonName: matchedPerson?.full_name ?? null,
        matchedLeadId: lead?.id ?? null,
        needsProfile,
        reason: leadReason({
          decision: decision.action,
          leadName: matchedPerson?.full_name ?? null,
          existingLead: lead !== undefined,
        }),
        mapping: {
          icpId: assignment.primaryIcpId,
          icpName: icps.find((i) => i.id === assignment.primaryIcpId)?.name ?? 'Unknown ICP',
          reason: assignment.reason,
          secondaryIcpIds: assignment.secondaryIcpIds,
          needsReview: assignment.needsReview,
        },
        normalized: {
          fullName,
          jobTitle,
          location: candidate.location ?? null,
          linkedinUrl: linkedin,
          companyName,
          companyDomain: normalizeDomain(candidate.company_domain ?? null).domain,
          sourceUrl: candidate.source_url ?? null,
        },
        candidate,
        rawPayload: candidateFor(raw),
      });
    }

    // The envelope the idempotency key is derived from is validated with the
    // shared schema, so the key always satisfies `ingestEnvelopeSchema`.
    const observedAt = input.observedAt ?? new Date().toISOString();
    const payload = rows.map((row) => row.rawPayload);
    const idempotencyKey = deriveIdempotencyKey({
      sourceClient: 'web',
      businessKeyOrId: input.businessKey,
      payloadType: 'candidate',
      payload,
      observedAt,
    });
    const envelope = ingestEnvelopeSchema.safeParse({
      source_client: 'web',
      business_key_or_id: input.businessKey,
      payload_type: 'candidate',
      payload,
      idempotency_key: idempotencyKey,
      observed_at: observedAt,
    });
    if (!envelope.success) {
      throw new Error('The import envelope could not be validated.');
    }

    return {
      sourceType: input.sourceType,
      icpSelection: input.icpSelection,
      rows,
      failed,
      mergeCount: rows.filter((row) => row.dedupe === 'update').length,
      reviewCount: rows.filter((row) => row.dedupe === 'review').length,
      createCount: rows.filter((row) => row.dedupe === 'create').length,
      needsProfileCount: rows.filter((row) => row.needsProfile).length,
      idempotencyKey,
      observedAt,
      payloadHash: contentHash(payload),
    };
  });
}

/** The spec's ICP selection contract, narrowed to what this module accepts. */
type IcpSelectionInput =
  | { readonly mode: 'primary'; readonly icpId: string }
  | { readonly mode: 'auto_match'; readonly icpId: null };

function leadReason(input: {
  readonly decision: 'create_person' | 'update_person' | 'review';
  readonly leadName: string | null;
  readonly existingLead: boolean;
}): string {
  if (input.decision === 'update_person') {
    return input.existingLead
      ? `Matches ${input.leadName ?? 'an existing person'} — the existing lead is updated, not duplicated.`
      : `Matches ${input.leadName ?? 'an existing person'} — no lead in this business yet, so one is created.`;
  }
  if (input.decision === 'review') {
    return `Possible duplicate of ${input.leadName ?? 'an existing person'} — the lead is created and routed to Duplicate Review.`;
  }
  return 'No existing match — a new person and lead are created.';
}

function describeIssue(message: string | undefined): string {
  if (message === undefined || message.length === 0) {
    return 'The row could not be validated. Check the mapped columns.';
  }
  return message;
}

async function loadIcps(sql: Db, businessId: string): Promise<readonly IcpLike[]> {
  const result = await sql.query<Row>(
    `select id, business_id, name, criteria, is_default
       from public.icps
      where business_id = $1 and deleted_at is null and is_active
      order by is_default desc, name`,
    [businessId],
  );
  return result.rows.map((row: Row) => ({
    id: asString(row.id),
    business_id: asString(row.business_id),
    name: asString(row.name),
    criteria: (row.criteria ?? null),
    is_default: row.is_default === true,
  }));
}

/**
 * Loads the comparison set for dedupe.
 *
 * The set is bounded (the people whose LinkedIn key or normalized name matches a
 * submitted row, plus their companies and this business's leads) because the
 * matcher is an in-memory exact/fuzzy comparison rather than a join. RLS decides
 * what is visible, so the bound is a performance limit, never an authorization
 * one; an exact LinkedIn/email match can always be found, which is the case the
 * spec calls the strongest key.
 */
async function loadMatchCandidates(
  sql: Db,
  businessId: string,
  rows: readonly RawRow[],
  limit = 2000,
): Promise<{
  readonly people: readonly BasePerson[];
  readonly companies: readonly ExistingCompany[];
  readonly leads: readonly BaseLead[];
}> {
  const wantedUrls = rows
    .map((row) => normalizeLinkedInUrl(row.linkedinUrl).canonicalUrl)
    .filter((value): value is string => value !== null);
  const wantedNames = rows.map((row) => normalizePersonName(row.name)).filter((name) => name.length > 0);

  const people = await sql.query<Row>(
    `select p.id, p.full_name, p.normalized_name, p.linkedin_url, p.normalized_linkedin_url,
            p.primary_email, p.company_id, p.job_title, p.deleted_at
       from public.people p
      where p.normalized_linkedin_url = any($1::text[])
         or p.normalized_name = any($2::text[])
      limit $3`,
    [wantedUrls, wantedNames, limit],
  );

  const ids = people.rows.map((row: Row) => asString(row.id)).filter((id) => id.length > 0);
  if (ids.length === 0) return { people: [], companies: [], leads: [] };

  const leads = await sql.query<Row>(
    `select l.id, l.business_id, l.person_id, l.status, l.deleted_at, p.full_name as person_name
       from public.leads l
       join public.people p on p.id = l.person_id
      where l.business_id = $1
        and l.person_id = any($2::uuid[])`,
    [businessId, ids],
  );

  const companies = await sql.query<Row>(
    `select c.id, c.name, c.normalized_name, c.normalized_domain
       from public.companies c
      where c.deleted_at is null
        and c.id in (select distinct p.company_id from public.people p
                      where p.id = any($1::uuid[]) and p.company_id is not null)`,
    [ids],
  );

  return {
    people: people.rows.map((row: Row) => ({
      id: asString(row.id),
      full_name: asString(row.full_name),
      normalized_name: asStringOrNull(row.normalized_name),
      linkedin_url: asStringOrNull(row.linkedin_url),
      normalized_linkedin_url: asStringOrNull(row.normalized_linkedin_url),
      primary_email: asStringOrNull(row.primary_email),
      company_id: asStringOrNull(row.company_id),
      job_title: asStringOrNull(row.job_title),
      deleted_at: asIso(row.deleted_at),
    })),
    companies: companies.rows.map((row: Row) => ({
      id: asString(row.id),
      name: asString(row.name),
      normalized_name: asStringOrNull(row.normalized_name),
      normalized_domain: asStringOrNull(row.normalized_domain),
    })),
    leads: leads.rows.map((row: Row) => ({
      id: asString(row.id),
      business_id: asString(row.business_id),
      person_id: asString(row.person_id),
      status: asString(row.status, 'new'),
      deleted_at: asIso(row.deleted_at),
      person_name: asString(row.person_name),
    })),
  };
}

/* ------------------------------------------------- session-carried state -- */

export interface PreparedImport {
  readonly plan: IngestionPlan;
  readonly preview: ImportPreview;
  readonly payload: PlanPayload;
}

/**
 * Runs the read-only half of the Import Builder: validate, normalize, dedupe and
 * count — with no writes.
 *
 * The page calls this to render the preview, and `executeIngestion` repeats the
 * same work inside the write transaction, so a preview the operator edited in the
 * browser cannot change what is actually written.
 */
export async function prepareImportPreview(
  actor: Actor,
  input: {
    readonly businessId: string;
    readonly businessKey: string;
    readonly businessName: string;
    readonly sourceType: ImportBatchSource;
    readonly icpSelection: IcpSelectionInput;
    readonly rows: readonly RawRow[];
    readonly header: readonly string[];
  },
): Promise<PreparedImport> {
  const [plan, icps] = await Promise.all([
    prepareIngestion(actor, input),
    listIcpOptions(actor, input.businessId),
  ]);
  const names = new Map(icps.map((option) => [option.value, option.label]));
  return {
    plan,
    preview: toImportPreview(plan, input.header, names),
    payload: planPayloadFor(plan, input.header),
  };
}

/** ICP options as the wizard's select needs them; also used for preview labels. */
export async function listIcpOptions(
  actor: Actor,
  businessId: string,
): Promise<readonly { readonly value: string; readonly label: string }[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name from public.icps
        where business_id = $1 and deleted_at is null and is_active
        order by is_default desc, name`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({ value: asString(row.id), label: asString(row.name) }));
  });
}

/* --------------------------------------------------------------- execute -- */

export interface ExecuteResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly batchId: string | null;
  readonly message: string;
  readonly counts: ExecuteCounts;
}

/**
 * Runs the import: `import_batches` + `import_rows`, the leads, the ICP matches,
 * the source evidence, the profile queue entries, the duplicate candidates and the
 * idempotency ledger — all in one transaction.
 *
 * Nothing here trusts the preview: the plan is recomputed inside the transaction
 * from the submitted rows, so a tampered preview cannot change what is written.
 */
export async function executeIngestion(
  viewer: Viewer,
  input: {
    readonly businessId: string;
    readonly businessKey: string;
    readonly businessName: string;
    readonly sourceType: ImportBatchSource;
    readonly icpSelection: IcpSelectionInput;
    readonly rows: readonly RawRow[];
  },
): Promise<ExecuteResult> {
  const plan = await prepareIngestion(viewer.actor, input);
  if (plan.rows.length === 0) {
    return {
      ok: false,
      error:
        plan.failed.length > 0
          ? 'Every row failed validation. Fix the mapped columns and preview again.'
          : 'There is nothing to import.',
      batchId: null,
      message: '',
      counts: { ...ZERO_EXECUTE_COUNTS, failed: plan.failed.length },
    };
  }

  try {
    return await withActor(viewer.actor, async (sql) => {
      await sql.exec(`select set_config('nexus.source_client', 'web', true)`);

      // spec invariant 6 / `api_contract.external_ingest`: the idempotency key is
      // unique per (source_client, business, key). Claiming it first is what makes
      // a repeated submission refuse rather than duplicate every lead.
      const attempted = await sql.query<Row>(
        `insert into public.ingest_requests
           (source_client, business_id, payload_type, idempotency_key, observed_at,
            payload, content_hash, status, api_client_id)
         values ('web', $1, 'candidate', $2, $3, $4::jsonb, $5, 'received', null)
         on conflict (source_client, business_id, idempotency_key) do nothing
         returning id`,
        [
          input.businessId,
          plan.idempotencyKey,
          plan.observedAt,
          JSON.stringify({ rows: plan.rows.map((row) => row.rawPayload) }),
          plan.payloadHash,
        ],
      );
      if (attempted.rows.length === 0) {
        return {
          ok: false,
          error: 'This exact import was already submitted (same idempotency key). Nothing was written twice.',
          batchId: null,
          message: '',
          counts: ZERO_EXECUTE_COUNTS,
        };
      }
      const requestId = asString(attempted.rows[0]?.id);

      const batch = await sql.query<Row>(
        `insert into public.import_batches
           (source, business, requested_primary_icp, created_by, business_id,
            requested_icp_id, auto_match, row_count, status, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9)
         returning id`,
        [
          input.sourceType,
          input.businessName,
          input.icpSelection.mode === 'primary'
            ? (plan.rows[0]?.mapping.icpName ?? 'explicitly selected')
            : 'Auto-match',
          viewer.userId,
          input.businessId,
          input.icpSelection.mode === 'primary' ? input.icpSelection.icpId : null,
          input.icpSelection.mode === 'auto_match',
          input.rows.length,
          plan.idempotencyKey,
        ],
      );
      const batchId = asString(batch.rows[0]?.id);
      if (batchId.length === 0) throw new Error('The import batch could not be created.');

      const counts: {
        created: number;
        updated: number;
        duplicate: number;
        needsProfile: number;
        failed: number;
        skipped: number;
      } = { ...ZERO_EXECUTE_COUNTS };

      for (const failedRow of plan.failed) {
        await insertRow(
          sql,
          batchId,
          failedRow.line,
          { line: failedRow.line },
          {},
          'failed',
          failedRow.message,
          null,
          null,
          null,
        );
        counts.failed += 1;
      }

      for (const row of plan.rows) {
        try {
          // Each row is its own savepoint-free unit: a failure is caught, recorded
          // as a failed row and the remaining rows still import.
          const written = await writeRow(sql, {
            viewer,
            businessId: input.businessId,
            batchId,
            plan,
            row,
            observedAt: plan.observedAt,
          });
          counts[written.counter] += 1;
          if (row.needsProfile) counts.needsProfile += 1;
        } catch (error) {
          counts.failed += 1;
          await insertRow(sql, batchId, row.line, row.rawPayload, {}, 'failed', describeDbError(error), null, null, null);
        }
      }

      await sql.query(
        `update public.import_batches
            set created_count = $2, updated_count = $3, duplicate_count = $4,
                needs_profile_count = $5, failed_count = $6, skipped_count = $7,
                status = $8,
                raw_summary = raw_summary || $9::jsonb
          where id = $1`,
        [
          batchId,
          counts.created,
          counts.updated,
          counts.duplicate,
          counts.needsProfile,
          counts.failed,
          counts.skipped,
          counts.failed > 0 && counts.created + counts.updated + counts.duplicate === 0 ? 'failed' : 'completed',
          JSON.stringify({
            pipeline: [
              'validate',
              'normalize',
              'dedupe',
              'persist_evidence',
              'apply_rules',
              'upsert_candidate',
              'assign',
              'enroll',
              'audit',
            ],
            source: input.sourceType,
            icp_mode: input.icpSelection.mode,
            payload_hash: plan.payloadHash,
          }),
        ],
      );

      await sql.query(
        `update public.ingest_requests
            set status = 'processed',
                result = jsonb_build_object('batch_id', $2::text, 'counts', $3::jsonb)
          where id = $1`,
        [requestId, batchId, JSON.stringify(counts)],
      );

      const written = counts.created + counts.updated;
      return {
        ok: true,
        error: null,
        batchId,
        message: `Imported ${String(written)} lead${written === 1 ? '' : 's'}; ${String(counts.duplicate)} routed to Duplicate Review.`,
        counts,
      };
    });
  } catch (error) {
    return {
      ok: false,
      error: describeDbError(error),
      batchId: null,
      message: '',
      counts: ZERO_EXECUTE_COUNTS,
    };
  }
}

async function insertRow(
  sql: Db,
  batchId: string,
  rowNumber: number,
  raw: unknown,
  normalized: unknown,
  result: string,
  message: string | null,
  leadId: string | null,
  personId: string | null,
  companyId: string | null,
): Promise<void> {
  await sql.query(
    `insert into public.import_rows
       (batch_id, row_number, raw, normalized, result, lead_id, person_id, company_id, message)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)
     on conflict (batch_id, row_number) do update
        set raw = excluded.raw, normalized = excluded.normalized, result = excluded.result,
            lead_id = excluded.lead_id, person_id = excluded.person_id,
            company_id = excluded.company_id, message = excluded.message`,
    [
      batchId,
      rowNumber,
      JSON.stringify(raw ?? {}),
      JSON.stringify(normalized ?? {}),
      result,
      leadId,
      personId,
      companyId,
      message,
    ],
  );
}

async function writeRow(
  sql: Db,
  input: {
    readonly viewer: Viewer;
    readonly businessId: string;
    readonly batchId: string;
    readonly plan: IngestionPlan;
    readonly row: PlannedRow;
    readonly observedAt: string;
  },
): Promise<{
  readonly counter: 'created' | 'updated' | 'duplicate' | 'skipped';
  readonly personId: string;
  readonly leadId: string;
}> {
  const { viewer, businessId, batchId, plan, row, observedAt } = input;
  const candidate = row.candidate as {
    readonly headline?: string;
  };

  const fullName = row.normalized.fullName;
  const normalizedName = normalizePersonName(fullName);

  // ---- person ------------------------------------------------------------
  // spec `lead_invariants`: "Rediscovery creates a new Signal/SourceEvidence, not
  // a duplicate Person". An existing person is therefore refreshed, never forked.
  let personId: string | null = null;
  if (row.dedupe === 'create') {
    // A unique LinkedIn key is the person dedupe key (`people_normalized_linkedin_key`).
    // It is looked up first so a person created moments ago by a parallel import is
    // reused rather than attempted twice.
    if (row.normalized.linkedinUrl !== null) {
      const already = await sql.query<Row>(
        `select id from public.people where normalized_linkedin_url = $1 limit 1`,
        [row.normalized.linkedinUrl],
      );
      personId = asStringOrNull(already.rows[0]?.id);
    }
    if (personId === null) {
      const inserted = await sql.query<Row>(
        `insert into public.people
           (full_name, normalized_name, job_title, location, linkedin_url, headline, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          fullName,
          normalizedName,
          row.normalized.jobTitle,
          row.normalized.location,
          row.normalized.linkedinUrl,
          candidate.headline ?? null,
          viewer.userId,
        ],
      );
      personId = asStringOrNull(inserted.rows[0]?.id);
    }
    if (personId === null) throw new Error('The person row could not be created.');
  } else {
    personId = row.matchedPersonId;
    if (personId === null) throw new Error('The matched person could not be resolved.');
    await sql.query(
      `update public.people p
          set full_name = coalesce(nullif($2, ''), p.full_name),
              normalized_name = coalesce(nullif($3, ''), p.normalized_name),
              job_title = coalesce($4, p.job_title),
              location = coalesce($5, p.location),
              linkedin_url = coalesce($6, p.linkedin_url),
              deleted_at = null,
              updated_at = now()
        where p.id = $1`,
      [
        personId,
        fullName,
        normalizedName,
        row.normalized.jobTitle,
        row.normalized.location,
        row.normalized.linkedinUrl,
      ],
    );
  }

  // ---- company (resolve by domain first, then name) -----------------------
  let companyId: string | null = null;
  const normalizedCompany = normalizeCompanyName(row.normalized.companyName);
  const company = await sql.query<Row>(
    `select id, name, normalized_name, normalized_domain
       from public.companies
      where deleted_at is null
        and (($1::text is not null and normalized_domain = $1)
             or normalized_name = $2)
      limit 1`,
    [row.normalized.companyDomain, normalizedCompany],
  );
  const matchedCompany = asStringOrNull(company.rows[0]?.id);
  if (matchedCompany !== null) {
    companyId = matchedCompany;
  } else {
    const inserted = await sql.query<Row>(
      `insert into public.companies (name, normalized_name, primary_domain, normalized_domain, created_by)
       values ($1, $2, $3, $3, $4)
       returning id`,
      [row.normalized.companyName, normalizedCompany, row.normalized.companyDomain, viewer.userId],
    );
    companyId = asStringOrNull(inserted.rows[0]?.id);
    if (companyId === null && row.normalized.companyDomain !== null) {
      const existing = await sql.query<Row>(
        `select id from public.companies where normalized_domain = $1 limit 1`,
        [row.normalized.companyDomain],
      );
      companyId = asStringOrNull(existing.rows[0]?.id);
    }
  }
  if (companyId !== null) {
    await sql.query(`update public.people set company_id = $2, updated_at = now() where id = $1`, [
      personId,
      companyId,
    ]);
  }

  // ---- lead --------------------------------------------------------------
  const leads = await sql.query<Row>(
    `select id, business_id, person_id, status, deleted_at
       from public.leads
      where business_id = $1 and person_id = $2`,
    [businessId, personId],
  );
  // spec `lead_invariants`: within one business a person may have only one active
  // lead. A soft-deleted one must be restored, never shadowed by a second row.
  const leadOutcome = resolveLeadForPerson(
    businessId,
    personId,
    leads.rows.map((existing: Row) => ({
      id: asString(existing.id),
      business_id: asString(existing.business_id),
      person_id: asString(existing.person_id),
      status: asString(existing.status, 'new'),
      deleted_at: asIso(existing.deleted_at),
    })),
  );

  if (leadOutcome.outcome === 'blocked_deleted_lead') {
    await insertRow(
      sql,
      batchId,
      row.line,
      row.rawPayload,
      row.normalized,
      'skipped',
      'This person has a soft-deleted lead in this business. Restore it from Trash instead of importing a second one.',
      leadOutcome.leadId,
      personId,
      companyId,
    );
    // Counted as skipped, not merged: no second lead was created and nothing was
    // reactivated, so the batch must not claim it did anything.
    return { counter: 'skipped', personId, leadId: leadOutcome.leadId };
  }

  const status = row.needsProfile ? 'needs_profile' : 'new';
  const sourceType: LeadSourceType = plan.sourceType;

  if (leadOutcome.outcome === 'reuse_lead') {
    await sql.query(
      `update public.leads
          set company_id = coalesce($2, company_id),
              import_batch_id = $3,
              source_type = $4,
              source_url = coalesce($5, source_url),
              needs_profile = needs_profile or $6,
              next_action_type = case when $6 then 'capture_profile' else next_action_type end,
              next_action_at = case when $6 then now() else next_action_at end,
              last_activity_at = now(),
              updated_at = now()
        where id = $1`,
      [leadOutcome.leadId, companyId, batchId, sourceType, row.normalized.sourceUrl, row.needsProfile],
    );
  } else {
    await sql.query(
      `insert into public.leads
         (business_id, person_id, company_id, status, source_type, source_url,
          needs_profile, import_batch_id, created_by, next_action_type, next_action_at,
          last_activity_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               case when $7 then 'capture_profile' else 'none' end,
               case when $7 then now() else null end,
               now())`,
      [
        businessId,
        personId,
        companyId,
        status,
        sourceType,
        row.normalized.sourceUrl,
        row.needsProfile,
        batchId,
        viewer.userId,
      ],
    );
  }

  const lead = await sql.query<Row>(
    `select id from public.leads
      where business_id = $1 and person_id = $2 and deleted_at is null
      limit 1`,
    [businessId, personId],
  );
  const leadId = asStringOrNull(lead.rows[0]?.id);
  if (leadId === null) throw new Error('The lead could not be resolved after the import.');

  // ---- ICP ---------------------------------------------------------------
  // spec `lead_invariants`: a person may match several ICPs, but only one match is
  // primary and a secondary match never creates a second lead.
  for (const secondary of row.mapping.secondaryIcpIds) {
    await sql.query(
      `insert into public.lead_icp_matches (lead_id, icp_id, is_primary, reason, created_by)
       values ($1, $2, false, $3, $4)
       on conflict (lead_id, icp_id) do nothing`,
      [leadId, secondary, 'secondary match from import dedupe', viewer.userId],
    );
  }
  await sql.query(`select public.set_primary_icp($1, $2)`, [leadId, row.mapping.icpId]);

  // ---- source evidence ---------------------------------------------------
  // spec invariant 18: every ingestion persists provenance with a content hash.
  // The hash is batch-scoped, so the row is unique even when the same payload was
  // imported before; `do nothing` guards a same-batch retry.
  await sql.query(
    `insert into public.source_evidence
       (business_id, person_id, company_id, lead_id, source, source_url,
        raw_text_or_json, content_hash, observed_at, captured_at, confidence, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11)
     on conflict on constraint source_evidence_business_hash_key do nothing`,
    [
      businessId,
      personId,
      companyId,
      leadId,
      `Import · ${sourceType}`,
      row.normalized.sourceUrl,
      JSON.stringify(row.rawPayload),
      contentHash({ batch: batchId, row: row.rawPayload }),
      observedAt,
      row.confidence > 0 ? row.confidence : 0.5,
      viewer.userId,
    ],
  );

  // ---- profile queue -----------------------------------------------------
  // spec `google.missing_profile_behavior`: a partial record is queued for a
  // human profile capture. The queue holds at most one open item per lead
  // (`profile_capture_queue_open_lead_key`), so the open item is updated in place
  // rather than relying on an ON CONFLICT against a partial index.
  if (row.needsProfile) {
    const queued = await sql.query(
      `update public.profile_capture_queue
          set state = 'pending',
              reason = $3,
              updated_at = now()
        where lead_id = $1 and business_id = $2 and state in ('pending', 'in_progress')`,
      [
        leadId,
        businessId,
        'Imported without a LinkedIn profile capture — needs the full profile.',
      ],
    );
    if (queued.affectedRows === 0) {
      await sql.query(
        `insert into public.profile_capture_queue (business_id, lead_id, person_id, state, reason)
         values ($1, $2, $3, 'pending', $4)`,
        [
          businessId,
          leadId,
          personId,
          'Imported without a LinkedIn profile capture — needs the full profile.',
        ],
      );
    }
  }

  // ---- duplicate review --------------------------------------------------
  if (row.dedupe === 'review' && row.matchedPersonId !== null) {
    await sql.query(
      `insert into public.duplicate_candidates
         (business_id, incoming_person_id, existing_person_id, existing_lead_id,
          match_reason, confidence, status, payload)
       values ($1, $2, $3, $4, $5, $6, 'open', $7::jsonb)`,
      [
        businessId,
        personId,
        row.matchedPersonId,
        row.matchedLeadId,
        row.matchReason ?? 'name_company_title',
        Math.min(Math.max(row.confidence, 0), 1),
        JSON.stringify({ import_batch_id: batchId, source: sourceType, line: row.line }),
      ],
    );
  }

  // ---- audited history on the record itself ------------------------------
  await sql.query(
    `insert into public.interactions
       (business_id, lead_id, person_id, type, actor_user_id, direction, summary, payload, source_client, occurred_at)
     values ($1, $2, $3, 'import', $4, 'internal', $5, $6::jsonb, 'web', now())`,
    [
      businessId,
      leadId,
      personId,
      viewer.userId,
      `Imported from ${sourceType} (batch ${batchId})`,
      JSON.stringify({
        batch_id: batchId,
        dedupe: row.dedupe,
        confidence: row.confidence,
        needs_profile: row.needsProfile,
      }),
    ],
  );

  await insertRow(
    sql,
    batchId,
    row.line,
    row.rawPayload,
    row.normalized,
    row.dedupe === 'review' ? 'duplicate' : row.outcome,
    row.reason,
    leadId,
    personId,
    companyId,
  );

  return {
    counter: row.dedupe === 'review' ? 'duplicate' : row.outcome === 'updated' ? 'updated' : 'created',
    personId,
    leadId,
  };
}

/* ------------------------------------------------------------------ undo -- */

export interface UndoResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly reverted: number;
  readonly kept: number;
}

/**
 * spec `import_batch.undo` — reverts records created exclusively by that import
 * and preserves anything that has moved on since. The decision table lives in
 * `public.undo_import`; this is only the call.
 */
export async function undoImport(viewer: Viewer, batchId: string): Promise<UndoResult> {
  try {
    const result = await withActor(viewer.actor, async (sql) => {
      await sql.exec(`select set_config('nexus.source_client', 'web', true)`);
      const rows = await sql.query<Row>(`select public.undo_import($1, $2) as result`, [
        batchId,
        viewer.userId,
      ]);
      const payload = rows.rows[0]?.result as { reverted?: number; kept?: number } | undefined;
      return { reverted: asNumber(payload?.reverted), kept: asNumber(payload?.kept) };
    });
    return { ok: true, error: null, reverted: result.reverted, kept: result.kept };
  } catch (error) {
    return { ok: false, error: describeDbError(error), reverted: 0, kept: 0 };
  }
}
