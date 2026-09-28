/**
 * Extraction: turning a staged raw body into committed, provenance-bearing facts.
 *
 * ## The order is the requirement (spec §8, §32.1)
 *
 * ```
 * receive raw → stage → read → DeepSeek extract → validate → commit structured facts
 *   → commit provenance → verify commit → delete raw → advance enrichment state / complete job
 * ```
 *
 * That order is visible in `enrichProfileFromPaste` and `commitCompanyResearch` as
 * numbered steps, and three of them are non-negotiable:
 *
 *   * **the raw body is never written anywhere canonical.** `raw_text_or_json`
 *     gets a small structured summary; the body itself exists only in
 *     `raw_staging`, which is unreadable by a tenant and deleted the moment the
 *     commit is verified.
 *   * **deletion happens last, after verification.** The structured write and its
 *     provenance commit in one transaction, the commit is then verified by reading
 *     it back, and only a verified commit earns a deletion. Any failure calls
 *     `nexus_mark_raw_failed` and *leaves the row* for a retry; the 24h TTL is the
 *     backstop.
 *   * **merge precedence is not negotiable** (§45): 1 user-confirmed, 2 verified
 *     structured source, 3 strong canonical identifier, 4 high-confidence AI
 *     extraction, 5 AI inference. A value that already exists at a higher rank is
 *     never overwritten; an identity conflict is *reported* and the lead moves to
 *     `NEEDS_REVIEW` rather than one value silently winning.
 *
 * No AI output is committed unless the runner validated it against the task's
 * strict schema, so a schema-invalid answer mutates nothing at all.
 */
import 'server-only';

import {
  SIGNAL_KINDS,
  normalizeLinkedInUrl,
  slugify,
  type SignalKind,
  type SignalPolarity,
} from '@nexus/core';

import { withActor, type Viewer } from '../actor';
import type { Db } from '../sql';
import { describeDbError } from '../repo/common';
import {
  chainJobsForLead,
  completeAgentJob,
  failAgentJob,
  getAgentJob,
  submitAgentJobResult,
} from '../repo/agent-jobs';
import {
  recomputeLeadEnrichment,
  recomputeLeadEnrichmentWith,
  recordCompanyEnrichmentWith,
  recordProfileEnrichmentWith,
  setEnrichmentStatus,
} from '../repo/enrichment';
import {
  deleteRaw,
  findStagedRawIdForJob,
  markRawFailed,
  readRaw,
  stageRaw,
} from '../repo/raw-staging';
import { getOrBuildContextPack } from './context-pack';
import { hashAiInput, runAiTask } from './runner';
import {
  companyExtractionSchema,
  profileExtractionSchema,
  TASK_REGISTRY,
  taskPrompt,
  type CompanyExtraction,
  type ProfileExtraction,
} from './tasks';
import type { AiProvider } from './types';

/* ------------------------------------------------------------- helpers --- */

/** A proposed signal, normalised to the closed vocabulary the database enforces. */
interface SignalWrite {
  readonly kind: SignalKind;
  readonly polarity: SignalPolarity;
  readonly strength: number;
  readonly label: string;
  readonly detail: string | null;
}

function asSignalKind(value: string): SignalKind {
  return (SIGNAL_KINDS as readonly string[]).includes(value) ? (value as SignalKind) : 'custom';
}

/**
 * Strength is derived from confidence, never authored by the model as a number.
 *
 * `signals.strength` is `-100…100` with sign carrying polarity, so a negative
 * signal is negative and a neutral one is zero.
 */
function strengthFrom(polarity: SignalPolarity, confidence: number | null): number {
  const clamped = Math.max(0, Math.min(1, confidence ?? 0.5));
  const magnitude = Math.round(clamped * 100);
  if (polarity === 'negative') return -magnitude;
  if (polarity === 'neutral') return 0;
  return magnitude;
}

function bounded(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

function boundedList(values: readonly string[], maxItems: number, maxLength = 200): readonly string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, maxItems)
    .map((value) => (value.length > maxLength ? value.slice(0, maxLength - 1) + '…' : value));
}

function meanConfidence(confidence: Readonly<Record<string, number>>): number {
  const values = Object.values(confidence).filter((value) => Number.isFinite(value));
  if (values.length === 0) return 0.75;
  const total = values.reduce((sum, value) => sum + Math.max(0, Math.min(1, value)), 0);
  return Math.max(0, Math.min(1, total / values.length));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Inserts one signal unless an equivalent one already exists.
 *
 * Signals are append-only (invariant 5): rediscovery adds a row, and it never
 * updates one. The `not exists` guard is what makes re-running the same extraction
 * idempotent without turning "append-only" into "duplicate on every retry".
 */
async function insertSignal(
  sql: Db,
  input: {
    readonly businessId: string;
    readonly leadId: string | null;
    readonly personId: string | null;
    readonly companyId: string | null;
    readonly signal: SignalWrite;
    readonly observedAt: string | null;
    readonly createdBy: string | null;
  },
): Promise<boolean> {
  const result = await sql.query<{ id: string }>(
    `insert into public.signals
       (business_id, company_id, person_id, lead_id, kind, polarity, strength, label, detail,
        observed_at, is_active, created_by)
     select $1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()), true, $11
      where not exists (
        select 1 from public.signals s
         where s.lead_id is not distinct from $4::uuid
           and s.company_id is not distinct from $2::uuid
           and s.kind = $5
           and s.label = $8
      )
     returning id`,
    [
      input.businessId,
      input.companyId,
      input.personId,
      input.leadId,
      input.signal.kind,
      input.signal.polarity,
      input.signal.strength,
      input.signal.label,
      input.signal.detail,
      input.observedAt,
      input.createdBy,
    ],
  );
  return result.rows.length > 0;
}

/**
 * The permanent metadata row for a raw body that is about to be deleted.
 *
 * `raw_text_or_json` holds a *summary* — committed structured facts — and never the
 * body. `content_hash` and `raw_content_hash` are both the hash of the staged
 * bytes, which is what makes the `(business_id, content_hash)` uniqueness the
 * idempotency mechanism for a re-extraction (§57.5).
 */
async function insertEvidence(
  sql: Db,
  input: {
    readonly businessId: string;
    readonly leadId: string | null;
    readonly personId: string | null;
    readonly companyId: string | null;
    readonly source: string;
    readonly sourceUrl: string | null;
    readonly summary: Record<string, unknown>;
    readonly contentHash: string;
    readonly rawBytes: number;
    readonly collectorAgent: string | null;
    readonly agentJobId: string | null;
    readonly promptVersionId: string | null;
    readonly model: string;
    readonly observedAt: string | null;
    readonly confidence: number;
    readonly createdBy: string | null;
  },
): Promise<string | null> {
  const result = await sql.query<{ id: string }>(
    `insert into public.source_evidence
       (business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json,
        content_hash, raw_content_hash, raw_bytes, collector_agent, agent_job_id,
        prompt_version_id, model, observed_at, confidence, created_by, extracted_at)
     values ($1, $2, $3, $4, $5, $6, $7::text, $8, $8, $9, $10, $11, $12, $13,
             coalesce($14::timestamptz, now()), $15, $16, now())
     on conflict (business_id, content_hash) do nothing
     returning id`,
    [
      input.businessId,
      input.personId,
      input.companyId,
      input.leadId,
      input.source,
      input.sourceUrl,
      JSON.stringify(input.summary),
      input.contentHash,
      input.rawBytes,
      input.collectorAgent,
      input.agentJobId,
      input.promptVersionId,
      input.model,
      input.observedAt,
      input.confidence,
      input.createdBy,
    ],
  );
  return result.rows[0]?.id === undefined ? null : String(result.rows[0].id);
}

/** True when this exact raw body has already been committed for this business. */
async function evidenceExists(sql: Db, businessId: string, contentHash: string): Promise<boolean> {
  const result = await sql.query<{ n: number }>(
    `select count(*)::int as n
       from public.source_evidence
      where business_id = $1 and content_hash = $2`,
    [businessId, contentHash],
  );
  return Number(result.rows[0]?.n ?? 0) > 0;
}

/**
 * Stamps `raw_deleted_at` once the staged row is genuinely gone.
 *
 * Written after the deletion, not before: the column's meaning is "the body no
 * longer exists", and setting it optimistically would make it a claim instead of a
 * record.
 */
async function stampRawDeleted(viewer: Viewer, contentHash: string, businessId: string): Promise<void> {
  await withActor(viewer.actor, async (sql) => {
    await sql.query(
      `update public.source_evidence
          set raw_deleted_at = now()
        where business_id = $1 and content_hash = $2 and raw_deleted_at is null`,
      [businessId, contentHash],
    );
  });
}

/* ---------------------------------------------------------- profile path - */

export type ProfileExtractionCommit =
  | {
      readonly ok: true;
      readonly leadId: string;
      readonly personId: string;
      readonly companyId: string | null;
      readonly applied: readonly string[];
      readonly review: readonly string[];
      readonly rawDeleted: boolean;
      readonly runId: string | null;
    }
  | { readonly ok: false; readonly error: string; readonly errorCode: string; readonly rawRetained: boolean };

export interface EnrichProfileFromPasteInput {
  readonly leadId: string;
  readonly linkedinUrl: string;
  readonly pastedContent: string;
  readonly sourceType?: string;
  readonly sourceUrl?: string | null;
  readonly agentJobId?: string | null;
  readonly provider?: AiProvider;
}

type LeadScopeRow = {
  lead_id: string;
  business_id: string;
  person_id: string;
  company_id: string | null;
}

async function loadLeadScope(sql: Db, leadId: string): Promise<LeadScopeRow | null> {
  const result = await sql.query<LeadScopeRow>(
    `select id as lead_id, business_id, person_id, company_id
       from public.leads
      where id = $1 and deleted_at is null`,
    [leadId],
  );
  return result.rows[0] ?? null;
}

/**
 * Human-assisted profile enrichment: URL + pasted body in, committed facts and a
 * deleted staging row out.
 *
 * The paste is **not** persisted. `source_evidence` records the hash, the byte
 * count, the collector, the prompt version, the model and the extraction time; the
 * body is gone by the time this function returns.
 */
export async function enrichProfileFromPaste(
  viewer: Viewer,
  input: EnrichProfileFromPasteInput,
): Promise<ProfileExtractionCommit> {
  // ---- STEP 1: receive raw --------------------------------------------------
  if (input.pastedContent.trim().length === 0) {
    return {
      ok: false,
      error: 'Paste the profile content before enriching.',
      errorCode: 'empty_payload',
      rawRetained: false,
    };
  }

  const normalized = normalizeLinkedInUrl(input.linkedinUrl);
  const canonicalUrl = normalized.canonicalUrl ?? input.linkedinUrl.trim();
  const sourceType = input.sourceType ?? 'linkedin';
  const sourceUrl = input.sourceUrl ?? canonicalUrl;

  // The lead is resolved before anything is spent: a lead the actor cannot see
  // must fail as "not found" without staging a body or calling a model.
  const scope = await withActor(viewer.actor, async (sql) => loadLeadScope(sql, input.leadId));
  if (scope === null) {
    return {
      ok: false,
      error: 'That lead could not be found.',
      errorCode: 'lead_not_visible',
      rawRetained: false,
    };
  }

  // ---- STEP 2: stage --------------------------------------------------------
  //
  // THE STAGING RULE, stated because the alternative is not implementable:
  //
  // * A retry stages a **fresh** row rather than reusing the failed one. There is
  //   no way to find an existing row from the repository layer: `raw_staging` has
  //   every privilege revoked from `authenticated`, and the only function that can
  //   read a row takes its **id** (`nexus_read_raw_staging`). A tenant can learn an
  //   id in exactly two ways — the value `nexus_stage_raw` returns in this request,
  //   or `agent_job_events.payload->>'raw_staging_id'` for a job-scoped submission.
  //   The human paste path has neither, so "reuse the row from the last attempt"
  //   and "supersede the orphan after a commit" both need a database function that
  //   does not exist yet (see the report accompanying this change:
  //   `nexus_find_raw_staging(business_id, lead_id, kind, content_hash)` or
  //   `nexus_supersede_raw_staging(business_id, lead_id, kind, exclude_id)`).
  // * What happens instead is the behaviour §32.2.5 sanctions: a retryable failure
  //   marks its row and leaves it, a successful commit deletes the row it consumed,
  //   and the `nexus_cleanup_raw_staging` TTL sweep removes an abandoned row at most
  //   one processor interval past its 24h expiry. `rawDeleted` reports the truth
  //   about *this* run's row rather than implying the lead has no staged bytes.
  // * The agent-job path is different and does reuse: `commitCompanyResearch` looks
  //   the job's row up through `findStagedRawIdForJob` and consumes that same row,
  //   so a retried job cannot accumulate a second un-consumed row —
  //   `nexus_complete_agent_job` refuses while any remains.
  const staged = await stageRaw(viewer, {
    businessId: String(scope.business_id),
    leadId: input.leadId,
    personId: String(scope.person_id),
    companyId: scope.company_id === null ? null : String(scope.company_id),
    agentJobId: input.agentJobId ?? null,
    kind: 'profile_paste',
    sourceType,
    sourceUrl,
    payload: input.pastedContent,
    collectorAgent: input.agentJobId === undefined || input.agentJobId === null ? 'human_paste' : null,
  });
  if (!staged.ok) {
    return { ok: false, error: staged.error, errorCode: 'raw_stage_failed', rawRetained: false };
  }
  const rawId = staged.id;

  // From here on the body is staged, so every failure leaves the row for a retry
  // and reports `rawRetained: true`.
  // ---- STEP 3: read ---------------------------------------------------------
  const raw = await readRaw(viewer, rawId);
  if (raw === null) {
    return {
      ok: false,
      error: 'The staged content could not be read for extraction.',
      errorCode: 'raw_unreadable',
      rawRetained: true,
    };
  }

  // ---- STEP 4: DeepSeek extract --------------------------------------------
  // The input hash covers the entity, the canonical identifier and the *hash* of
  // the body — never the body itself, which must not be able to leak into a ledger.
  const inputHash = hashAiInput({
    task: 'PROFILE_EXTRACTION',
    leadId: input.leadId,
    linkedinUrl: canonicalUrl,
    contentHash: raw.contentHash,
  });

  const outcome = await runAiTask<ProfileExtraction>(
    viewer,
    {
      businessId: String(scope.business_id),
      task: 'PROFILE_EXTRACTION',
      promptKey: 'profile_extract',
      leadId: input.leadId,
      personId: String(scope.person_id),
      companyId: scope.company_id === null ? null : String(scope.company_id),
      agentJobId: input.agentJobId ?? null,
    },
    {
      inputHash,
      schema: profileExtractionSchema,
      build: (prompt) =>
        taskPrompt(
          TASK_REGISTRY.PROFILE_EXTRACTION,
          { pastedContent: raw.payload, linkedinUrl: canonicalUrl },
          prompt,
        ),
      provider: input.provider,
    },
  );

  if (!outcome.ok) {
    // A failure leaves the staged body in place, marked with the typed code, so a
    // retry inside the TTL does not need the operator to paste again.
    await markRawFailed(viewer, rawId, outcome.errorCode);
    return {
      ok: false,
      error: outcome.error,
      errorCode: outcome.errorCode,
      rawRetained: true,
    };
  }

  // ---- STEP 5: validate ----------------------------------------------------
  // The runner already validated against `profileExtractionSchema`; nothing below
  // runs unless that succeeded, so a schema-invalid answer mutates nothing.

  // ---- STEP 6: commit structured facts, then provenance; STEP 7: verify -----
  let committed: {
    applied: string[];
    review: string[];
    personId: string;
    companyId: string | null;
    alreadyCommitted: boolean;
  };

  try {
    committed = await withActor(viewer.actor, async (sql) => {
      const already = await evidenceExists(sql, String(scope.business_id), raw.contentHash);
      if (already) {
        // §57.5: a re-extraction of the same bytes is a no-op for the structured
        // commit. Its staging row is still consumed and deleted below.
        return {
          applied: [] as string[],
          review: [] as string[],
          personId: String(scope.person_id),
          companyId: scope.company_id === null ? null : String(scope.company_id),
          alreadyCommitted: true,
        };
      }

      const plan = await planProfileCommit(
        sql,
        viewer,
        {
          businessId: String(scope.business_id),
          leadId: input.leadId,
          personId: String(scope.person_id),
          companyId: scope.company_id === null ? null : String(scope.company_id),
          agentJobId: input.agentJobId ?? null,
          canonicalUrl,
        },
        outcome.data,
      );

      // Provenance: the small structured summary, the hash of the bytes, and how
      // they were read. It is written after the facts so the two cannot disagree.
      const evidenceId = await insertEvidence(sql, {
        businessId: String(scope.business_id),
        leadId: input.leadId,
        personId: plan.personId,
        companyId: plan.companyId,
        source: sourceType,
        sourceUrl,
        summary: {
          summary: 'Profile facts extracted from a pasted profile body.',
          fields: {
            full_name: bounded(outcome.data.full_name, 200),
            job_title: bounded(outcome.data.job_title, 200),
            current_company: bounded(outcome.data.current_company, 200),
            location: bounded(outcome.data.location, 200),
          },
        },
        contentHash: raw.contentHash,
        rawBytes: byteLength(raw.payload),
        collectorAgent: raw.collectorAgent,
        agentJobId: input.agentJobId ?? null,
        promptVersionId: outcome.promptVersionId,
        model: outcome.model,
        observedAt: null,
        confidence: meanConfidence(outcome.data.confidence),
        createdBy: viewer.userId,
      });

      if (evidenceId === null) {
        // A concurrent run committed these exact bytes first. The structured plan
        // above is still idempotent, but reporting it as this run's own work would
        // be false.
        return {
          applied: [] as string[],
          review: [] as string[],
          personId: plan.personId,
          companyId: plan.companyId,
          alreadyCommitted: true,
        };
      }

      // The state advance happens in this transaction, because §14.4 forbids a
      // `lead_enrichment` write that leaves the score stale.
      await recordProfileEnrichmentWith(sql, {
        leadId: input.leadId,
        contentHash: raw.contentHash,
        sourceType,
        sourceUrl,
        agentJobId: input.agentJobId ?? null,
        status: plan.review.length > 0 ? 'NEEDS_REVIEW' : undefined,
      });
      await recomputeLeadEnrichmentWith(sql, input.leadId);

      // ---- verify the commit, inside the transaction that made it -------------
      const verified = await sql.query<{ n: number }>(
        `select count(*)::int as n
           from public.source_evidence
          where id = $1 and raw_content_hash = $2`,
        [evidenceId, raw.contentHash],
      );
      if (Number(verified.rows[0]?.n ?? 0) !== 1) {
        throw new Error('evidence verification failed');
      }

      return {
        applied: plan.applied,
        review: plan.review,
        personId: plan.personId,
        companyId: plan.companyId,
        alreadyCommitted: false,
      };
    });
  } catch (error) {
    await markRawFailed(viewer, rawId, 'commit_failed');
    return {
      ok: false,
      error: describeDbError(error, 'enrichProfileFromPaste'),
      errorCode: 'commit_failed',
      rawRetained: true,
    };
  }

  // ---- STEP 8: delete the raw body (only now) -------------------------------
  const rawDeleted = await deleteRaw(viewer, rawId);
  if (rawDeleted) await stampRawDeleted(viewer, raw.contentHash, String(scope.business_id));

  // ---- STEP 9: advance the enrichment state / escalate a conflict -----------
  if (!committed.alreadyCommitted) {
    await recomputeLeadEnrichment(viewer, input.leadId);
    if (committed.review.length > 0) {
      await setEnrichmentStatus(viewer, input.leadId, 'NEEDS_REVIEW');
    }
  }

  return {
    ok: true,
    leadId: input.leadId,
    personId: committed.personId,
    companyId: committed.companyId,
    applied: committed.applied,
    review: committed.review,
    // Reported truthfully: if the deletion did not happen, the TTL sweep is what
    // removes the row, and the caller is told rather than reassured.
    rawDeleted,
    runId: outcome.runId,
  };
}

interface ProfileCommitScope {
  readonly businessId: string;
  readonly leadId: string;
  readonly personId: string;
  readonly companyId: string | null;
  readonly agentJobId: string | null;
  readonly canonicalUrl: string;
}

/**
 * Applies one extraction to the canonical rows, under merge precedence.
 *
 * The rules, in the order §45 states them:
 *
 *   * a field that is empty is filled — AI extraction (4) and inference (5) are
 *     both allowed to add what nobody has claimed yet;
 *   * a field that already holds the same value is left alone;
 *   * an **identity** field that differs (`full_name`, `linkedin_url`, the company)
 *     is *not* overwritten. It becomes a `review` entry and the lead moves to
 *     `NEEDS_REVIEW`;
 *   * a **descriptive** field that differs (`job_title`, `headline`, `location`) is
 *     also not overwritten, but it is not escalated: a title changes over time and
 *     treating every change as a conflict would make `NEEDS_REVIEW` meaningless;
 *   * a `person_contact_points` row that a human confirmed is never replaced.
 */
async function planProfileCommit(
  sql: Db,
  viewer: Viewer,
  scope: ProfileCommitScope,
  extraction: ProfileExtraction,
): Promise<{
  applied: string[];
  review: string[];
  personId: string;
  companyId: string | null;
}> {
  const applied: string[] = [];
  const review: string[] = [];

  const current = await sql.query<{
    person_id: string;
    full_name: string;
    job_title: string | null;
    headline: string | null;
    location: string | null;
    linkedin_url: string | null;
    normalized_linkedin_url: string | null;
    company_id: string | null;
  }>(
    `select p.id as person_id, p.full_name, p.job_title, p.headline, p.location,
            p.linkedin_url, p.normalized_linkedin_url, p.company_id
       from public.people p
      where p.id = $1`,
    [scope.personId],
  );
  const person = current.rows[0];
  if (person === undefined) throw new Error('person not found for lead');

  // A different canonical person already owns this LinkedIn URL: that is an
  // ambiguous duplicate, and merging people is a duplicate-resolution decision, not
  // an enrichment outcome (invariant 16.4).
  const duplicate = await sql.query<{ id: string }>(
    `select id from public.people where normalized_linkedin_url = $1 and id <> $2 limit 1`,
    [scope.canonicalUrl, scope.personId],
  );
  const duplicateExists = duplicate.rows[0] !== undefined;
  if (duplicateExists) {
    review.push('linkedin_url:matches_another_person');
  }

  const fields: Record<string, string | null> = {};
  const proposedName = bounded(extraction.full_name, 200);
  const proposedTitle = bounded(extraction.job_title, 200);
  const proposedHeadline = bounded(extraction.headline, 400);
  const proposedLocation = bounded(extraction.location, 200);

  if (proposedName !== null) {
    if (sameText(person.full_name, proposedName)) {
      fields['full_name'] = null; // nothing to do
    } else if (person.full_name.trim().length === 0) {
      fields['full_name'] = proposedName;
      applied.push('full_name');
    } else {
      review.push('full_name:conflicts_with_existing');
      fields['full_name'] = null;
    }
  }

  for (const [column, proposed] of [
    ['job_title', proposedTitle],
    ['headline', proposedHeadline],
    ['location', proposedLocation],
  ] as const) {
    const existing = person[column];
    if (proposed === null || sameText(existing, proposed)) continue;
    // Fill when empty; otherwise keep the existing value. A descriptive field is
    // not escalated to a review: a job title changes over time, and treating every
    // change as a conflict would make NEEDS_REVIEW meaningless.
    fields[column] = existing === null || existing.trim().length === 0 ? proposed : null;
  }
  if (typeof fields['job_title'] === 'string') applied.push('job_title');
  if (typeof fields['headline'] === 'string') applied.push('headline');
  if (typeof fields['location'] === 'string') applied.push('location');

  // The strong canonical identifier (rank 3) is never replaced by an extraction
  // (rank 4/5), even when the extraction is confident about a different profile.
  const linkedinDiffers =
    person.normalized_linkedin_url !== null && person.normalized_linkedin_url !== scope.canonicalUrl;
  if (linkedinDiffers) {
    review.push('linkedin_url:conflicts_with_existing');
  }

  // The company: an existing link is authoritative; otherwise resolve or create one
  // on the normalised name/domain (spec §44).
  let companyId = scope.companyId;
  const proposedCompany = bounded(extraction.current_company, 200);
  let companyApplied = false;
  if (companyId === null && proposedCompany !== null) {
    const resolved = await sql.query<{ id: string }>(
      `select public.nexus_resolve_or_create_company($1, $2, $3, $4, $5) as id`,
      [scope.businessId, proposedCompany, slugify(proposedCompany), null, viewer.userId],
    );
    companyId = resolved.rows[0]?.id === undefined ? null : String(resolved.rows[0].id);
    if (companyId !== null) {
      applied.push('current_company');
      companyApplied = true;
    }
  } else if (companyId !== null && proposedCompany !== null) {
    const existingCompany = await sql.query<{ name: string }>(
      `select name from public.companies where id = $1`,
      [companyId],
    );
    const name = existingCompany.rows[0]?.name ?? null;
    if (name !== null && !sameText(name, proposedCompany)) {
      review.push('current_company:conflicts_with_existing');
    }
  }

  // Contact points: the URL is a location, not a fact set, and it is never
  // confirmed by an extraction.
  const confirmedConflict = await sql.query<{ id: string }>(
    `select id from public.person_contact_points
      where person_id = $1 and kind = 'linkedin' and confirmed_by_user
        and normalized_value <> $2 and deleted_at is null
      limit 1`,
    [scope.personId, scope.canonicalUrl],
  );
  if (confirmedConflict.rows[0] !== undefined) {
    review.push('linkedin_url:conflicts_with_confirmed_contact_point');
  }
  await sql.query(
    `insert into public.person_contact_points
       (person_id, kind, value, normalized_value, label, is_primary, confidence, source,
        source_url, observed_at, confirmed_by_user, agent_job_id, created_by)
     values ($1, 'linkedin', $2, $2, 'LinkedIn profile', false, 0.9000, $3, $2, now(), false, $4, $5)
     on conflict (person_id, kind, normalized_value) do nothing`,
    [scope.personId, scope.canonicalUrl, scope.agentJobId === null ? 'manual' : 'agent', scope.agentJobId, viewer.userId],
  );

  // The canonical LinkedIn key is only filled when it is empty *and* no other
  // person already holds it: two people sharing one normalised URL would make the
  // dedupe key meaningless.
  const setLinkedin = person.linkedin_url === null ? scope.canonicalUrl : null;
  const setNormalized = person.normalized_linkedin_url === null && !duplicateExists ? scope.canonicalUrl : null;

  await sql.query(
    `update public.people
        set full_name = coalesce($2, full_name),
            normalized_name = coalesce($3, normalized_name),
            job_title = coalesce($4, job_title),
            headline = coalesce($5, headline),
            location = coalesce($6, location),
            linkedin_url = coalesce($7, linkedin_url),
            normalized_linkedin_url = coalesce($8, normalized_linkedin_url),
            company_id = coalesce($9, company_id),
            profile_captured_at = now(),
            updated_at = now()
      where id = $1`,
    [
      scope.personId,
      fields['full_name'] ?? null,
      typeof fields['full_name'] === 'string' ? slugify(fields['full_name']) : null,
      fields['job_title'] ?? null,
      fields['headline'] ?? null,
      fields['location'] ?? null,
      setLinkedin,
      setNormalized,
      companyId,
    ],
  );
  if (setLinkedin !== null) applied.push('linkedin_url');
  if (companyApplied) {
    await sql.query(
      `update public.leads set company_id = coalesce(company_id, $2), updated_at = now() where id = $1`,
      [scope.leadId, companyId],
    );
  }

  for (const signal of extraction.signals) {
    const polarity: SignalPolarity =
      signal.polarity === 'positive' || signal.polarity === 'negative' ? signal.polarity : 'neutral';
    const inserted = await insertSignal(sql, {
      businessId: scope.businessId,
      leadId: scope.leadId,
      personId: scope.personId,
      companyId,
      signal: {
        kind: asSignalKind(signal.kind),
        polarity,
        strength: strengthFrom(polarity, extraction.confidence['signals'] ?? null),
        label: bounded(signal.label, 200) ?? 'Signal',
        detail: bounded(signal.detail, 1000),
      },
      observedAt: null,
      createdBy: viewer.userId,
    });
    if (inserted) applied.push(`signal:${signal.kind}`);
  }

  return { applied, review, personId: scope.personId, companyId };
}

/* ---------------------------------------------------------- company path - */

export type CompanyResearchCommit =
  | {
      readonly ok: true;
      readonly companyId: string | null;
      readonly signals: number;
      readonly rawDeleted: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly errorCode: string; readonly rawRetained: boolean };

export interface CommitCompanyResearchInput {
  readonly jobId: string;
  readonly agent: string;
  /**
   * Used only when the job is `RUNNING`: it is staged through
   * `nexus_submit_agent_job_result`, which is what moves the job to `WAITING_AI`.
   * When the job is already `WAITING_AI` the staged row is authoritative and this
   * value is ignored, so a processor can never resurrect a body from anywhere but
   * staging.
   */
  readonly payload: string;
  readonly sourceType?: string;
  readonly sourceUrl?: string | null;
  readonly provider?: AiProvider;
}

/**
 * The `WAITING_AI` processor path for company research.
 *
 * Steps, in the required order: find the staged raw for the job → read it →
 * `COMPANY_EXTRACTION` → validate → commit company facts, signals, provenance and a
 * structured `research_snapshots` row → verify → delete the raw row → complete the
 * job → chain the next automatic job → rebuild the context pack.
 *
 * A failure never completes the job: a terminal failure is reported through
 * `nexus_fail_agent_job`, and a retryable one is left in `WAITING_AI` so the *same*
 * staged row is retried (spec §50.3, §31.3). Re-opening the job instead would send
 * it back to an agent, which would stage a second row that the completion rule then
 * counts as un-consumed evidence — making `nexus_complete_agent_job` refuse
 * forever.
 */
export async function commitCompanyResearch(
  viewer: Viewer,
  input: CommitCompanyResearchInput,
): Promise<CompanyResearchCommit> {
  // ---- locate the job and its evidence --------------------------------------
  const job = await getAgentJob(viewer, input.jobId);
  if (job === null) {
    return {
      ok: false,
      error: 'That agent job could not be found.',
      errorCode: 'job_not_found',
      rawRetained: false,
    };
  }

  let rawId: string | null = null;
  if (job.status === 'RUNNING') {
    try {
      const submitted = await submitAgentJobResult(viewer, {
        jobId: input.jobId,
        agent: input.agent,
        payload: input.payload,
        kind: 'company_research',
        sourceType: input.sourceType ?? 'web',
        sourceUrl: input.sourceUrl ?? null,
      });
      rawId = submitted.rawStagingId;
    } catch (error) {
      return {
        ok: false,
        error: describeDbError(error, 'commitCompanyResearch.submit'),
        errorCode: 'result_submit_failed',
        rawRetained: false,
      };
    }
  } else if (job.status === 'WAITING_AI') {
    rawId = await withActor(viewer.actor, async (sql) => findStagedRawIdForJob(sql, input.jobId));
  }

  if (rawId === null) {
    // Never call a provider for a job with no evidence: there is nothing to
    // extract, and a terminal failure is the honest answer.
    await safeFailJob(viewer, input.jobId, input.agent, 'raw_staging_missing', false);
    return {
      ok: false,
      error: 'No staged evidence was found for that agent job.',
      errorCode: 'raw_staging_missing',
      rawRetained: false,
    };
  }

  const raw = await readRaw(viewer, rawId);
  if (raw === null) {
    await safeFailJob(viewer, input.jobId, input.agent, 'raw_staging_missing', false);
    return {
      ok: false,
      error: 'The staged evidence could not be read.',
      errorCode: 'raw_staging_missing',
      rawRetained: false,
    };
  }

  const leadId = job.leadId;
  const businessId = job.businessId;

  // ---- extract --------------------------------------------------------------
  const inputHash = hashAiInput({
    task: 'COMPANY_EXTRACTION',
    jobId: input.jobId,
    companyId: job.companyId,
    contentHash: raw.contentHash,
  });

  // Resolved before the call, so the `build` callback stays synchronous: it runs
  // inside the runner and must not open a transaction of its own.
  const companyName = await companyNameFor(viewer, job.companyId);

  const outcome = await runAiTask<CompanyExtraction>(
    viewer,
    {
      businessId,
      task: 'COMPANY_EXTRACTION',
      promptKey: 'company_extract',
      leadId,
      personId: job.personId,
      companyId: job.companyId,
      agentJobId: input.jobId,
    },
    {
      inputHash,
      schema: companyExtractionSchema,
      build: (prompt) =>
        taskPrompt(
          TASK_REGISTRY.COMPANY_EXTRACTION,
          { sourceText: raw.payload, sourceUrl: raw.sourceUrl, companyName },
          prompt,
        ),
      provider: input.provider,
    },
  );

  if (!outcome.ok) {
    await markRawFailed(viewer, rawId, outcome.errorCode);
    if (outcome.retryable) {
      // Deliberately no status transition: the job stays `WAITING_AI` with its
      // evidence intact so the next processor run retries the same bytes.
      return {
        ok: false,
        error: outcome.error,
        errorCode: outcome.errorCode,
        rawRetained: true,
      };
    }
    await safeFailJob(viewer, input.jobId, input.agent, outcome.errorCode, false);
    return {
      ok: false,
      error: outcome.error,
      errorCode: outcome.errorCode,
      rawRetained: true,
    };
  }

  const extraction = outcome.data;

  // ---- commit, verify, then delete -----------------------------------------
  let committed: { companyId: string | null; signals: number; alreadyCommitted: boolean };
  try {
    committed = await withActor(viewer.actor, async (sql) => {
      const already = await evidenceExists(sql, businessId, raw.contentHash);
      if (already) {
        return {
          companyId: job.companyId,
          signals: 0,
          alreadyCommitted: true,
        };
      }

      const companyId = await applyCompanyExtraction(sql, viewer, {
        businessId,
        leadId,
        personId: job.personId,
        companyId: job.companyId,
        extraction,
        confidence: meanConfidence(extraction.confidence),
      });

      const evidenceId = await insertEvidence(sql, {
        businessId,
        leadId,
        personId: job.personId,
        companyId: companyId.companyId,
        source: raw.sourceType,
        sourceUrl: raw.sourceUrl,
        summary: {
          summary: 'Company research committed as structured fields.',
          fields: {
            website: bounded(extraction.website, 300),
            industry: bounded(extraction.industry, 200),
            hiring: extraction.hiring,
            job_openings: extraction.job_openings.length,
          },
        },
        contentHash: raw.contentHash,
        rawBytes: byteLength(raw.payload),
        collectorAgent: raw.collectorAgent,
        agentJobId: input.jobId,
        promptVersionId: outcome.promptVersionId,
        model: outcome.model,
        observedAt: null,
        confidence: meanConfidence(extraction.confidence),
        createdBy: viewer.userId,
      });

      if (evidenceId === null) {
        return { companyId: companyId.companyId, signals: 0, alreadyCommitted: true };
      }

      // A structured snapshot, never the page: bounded fields only, so nothing
      // verbatim from the staged body survives in a findings blob (§34.5).
      await sql.query(
        `insert into public.research_snapshots
           (business_id, lead_id, person_id, company_id, summary, findings, model,
            prompt_version_id, created_by)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [
          businessId,
          leadId,
          job.personId,
          companyId.companyId,
          bounded(extraction.description, 500) ?? 'Company research snapshot',
          JSON.stringify(buildResearchFindings(extraction)),
          outcome.model,
          outcome.promptVersionId,
          viewer.userId,
        ],
      );

      if (leadId !== null) {
        await recordCompanyEnrichmentWith(sql, leadId);
        await recomputeLeadEnrichmentWith(sql, leadId);
      }

      const verified = await sql.query<{ n: number }>(
        `select count(*)::int as n from public.source_evidence
          where id = $1 and raw_content_hash = $2`,
        [evidenceId, raw.contentHash],
      );
      if (Number(verified.rows[0]?.n ?? 0) !== 1) {
        throw new Error('evidence verification failed');
      }

      return {
        companyId: companyId.companyId,
        signals: companyId.signalsInserted,
        alreadyCommitted: false,
      };
    });
  } catch (error) {
    await markRawFailed(viewer, rawId, 'commit_failed');
    await safeFailJob(viewer, input.jobId, input.agent, 'commit_failed', true);
    return {
      ok: false,
      error: describeDbError(error, 'commitCompanyResearch'),
      errorCode: 'commit_failed',
      rawRetained: true,
    };
  }

  const rawDeleted = await deleteRaw(viewer, rawId);
  if (rawDeleted) await stampRawDeleted(viewer, raw.contentHash, businessId);

  // ---- complete the job (the database refuses this while evidence remains) ---
  try {
    await completeAgentJob(viewer, { jobId: input.jobId, aiRunId: outcome.runId });
  } catch (error) {
    return {
      ok: false,
      error: describeDbError(error, 'commitCompanyResearch.complete'),
      errorCode: 'job_completion_refused',
      rawRetained: !rawDeleted,
    };
  }

  // ---- chain the next automatic job and rebuild the context pack ------------
  if (leadId !== null && !committed.alreadyCommitted) {
    await chainJobsForLead(viewer, { businessId, leadId });
    // Deliberately not handed the extraction provider: `CONTEXT_BUILD` is a
    // different task with a different schema, and injecting one task's provider
    // into another would make a test pass for the wrong reason.
    await getOrBuildContextPack(viewer, leadId);
  }

  return {
    ok: true,
    companyId: committed.companyId,
    signals: committed.signals,
    rawDeleted,
  };
}

async function companyNameFor(viewer: Viewer, companyId: string | null): Promise<string | null> {
  if (companyId === null) return null;
  const row = await withActor(viewer.actor, async (sql) =>
    sql.query<{ name: string }>(`select name from public.companies where id = $1`, [companyId]),
  );
  return row.rows[0]?.name ?? null;
}

/** Fails a job without letting a failure to fail it mask the original error. */
async function safeFailJob(
  viewer: Viewer,
  jobId: string,
  agent: string,
  errorCode: string,
  retryable: boolean,
): Promise<void> {
  try {
    await failAgentJob(viewer, { jobId, agent, errorCode, retryable });
  } catch {
    // The job may already be terminal, or held by a processor name the caller did
    // not use. The typed failure has already been returned to the caller.
  }
}

/**
 * The structured findings of a research snapshot.
 *
 * Bounded on every axis, and never the staged body: a description is capped, a
 * list is capped, and the only thing carried verbatim is a short label.
 */
function buildResearchFindings(extraction: CompanyExtraction): Record<string, unknown> {
  return {
    website: bounded(extraction.website, 300),
    industry: bounded(extraction.industry, 200),
    description: bounded(extraction.description, 1000),
    services: boundedList(extraction.services, 20),
    size_indicators: boundedList(extraction.size_indicators, 10),
    locations: boundedList(extraction.locations, 20),
    hiring: extraction.hiring,
    job_openings: extraction.job_openings
      .slice(0, 20)
      .map((opening) => ({ title: bounded(opening.title, 200), url: bounded(opening.url, 500) })),
    content_activity: boundedList(extraction.content_activity, 20),
    confidence_fields: Object.keys(extraction.confidence).sort(),
  };
}

/**
 * Writes company facts under merge precedence and returns the company id.
 *
 * A resolve-or-create only happens when the job carries no company: an agent
 * researching a company for a lead must not be able to repoint that lead at a
 * different company because the page mentioned one.
 */
async function applyCompanyExtraction(
  sql: Db,
  viewer: Viewer,
  input: {
    readonly businessId: string;
    readonly leadId: string | null;
    readonly personId: string | null;
    readonly companyId: string | null;
    readonly extraction: CompanyExtraction;
    readonly confidence: number;
  },
): Promise<{ readonly companyId: string | null; readonly signalsInserted: number }> {
  const extraction = input.extraction;
  let companyId = input.companyId;

  if (companyId === null) {
    const name =
      (await leadCompanyName(sql, input.leadId)) ?? bounded(extraction.website, 200) ?? 'Unknown company';
    const domain = normalizedDomain(extraction.website);
    const resolved = await sql.query<{ id: string }>(
      `select public.nexus_resolve_or_create_company($1, $2, $3, $4, $5) as id`,
      [input.businessId, name, slugify(name), domain, viewer.userId],
    );
    companyId = resolved.rows[0]?.id === undefined ? null : String(resolved.rows[0].id);
    if (companyId !== null && input.leadId !== null) {
      await sql.query(
        `update public.leads set company_id = coalesce(company_id, $2), updated_at = now() where id = $1`,
        [input.leadId, companyId],
      );
    }
  }

  if (companyId !== null) {
    const current = await sql.query<{
      primary_domain: string | null;
      industry: string | null;
      employee_count: number | null;
      description: string | null;
      linkedin_url: string | null;
    }>(
      `select primary_domain, industry, employee_count, description, linkedin_url
         from public.companies where id = $1`,
      [companyId],
    );
    const row = current.rows[0];
    const domain = normalizedDomain(extraction.website);

    await sql.query(
      `update public.companies
          set primary_domain = coalesce(primary_domain, $2),
              normalized_domain = coalesce(normalized_domain, $2),
              industry = coalesce(industry, $3),
              description = coalesce(description, $4),
              updated_at = now()
        where id = $1`,
      [
        companyId,
        // A domain is a strong canonical identifier (rank 3): it is filled when
        // absent and never replaced by an extraction.
        row?.primary_domain === null || row?.primary_domain === undefined ? domain : null,
        bounded(extraction.industry, 200),
        bounded(extraction.description, 2000),
      ],
    );
  }

  let signalsInserted = 0;
  for (const signal of extraction.signals) {
    const polarity: SignalPolarity =
      signal.polarity === 'positive' || signal.polarity === 'negative' ? signal.polarity : 'neutral';
    const inserted = await insertSignal(sql, {
      businessId: input.businessId,
      leadId: input.leadId,
      personId: input.personId,
      companyId,
      signal: {
        kind: asSignalKind(signal.kind),
        polarity,
        strength: strengthFrom(polarity, input.confidence),
        label: bounded(signal.label, 200) ?? 'Signal',
        detail: bounded(signal.detail, 1000),
      },
      observedAt: null,
      createdBy: viewer.userId,
    });
    if (inserted) signalsInserted += 1;
  }

  return { companyId, signalsInserted };
}

async function leadCompanyName(sql: Db, leadId: string | null): Promise<string | null> {
  if (leadId === null) return null;
  const result = await sql.query<{ name: string | null }>(
    `select c.name
       from public.leads l
       left join public.companies c on c.id = l.company_id
      where l.id = $1`,
    [leadId],
  );
  return result.rows[0]?.name ?? null;
}

/** A bare registrable domain from whatever the page or the model reported. */
function normalizedDomain(website: string | null): string | null {
  const value = bounded(website, 300);
  if (value === null) return null;
  const withoutScheme = value
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0];
  if (withoutScheme === undefined) return null;
  return withoutScheme.toLowerCase().length > 0 ? withoutScheme.toLowerCase() : null;
}
