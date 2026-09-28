/**
 * Raw staging — the only door to `raw_staging`.
 *
 * V1.2 holds a pasted profile or a scraped page in `raw_staging` for exactly one
 * extraction attempt, then deletes it (spec §32). Two consequences shape this
 * module:
 *
 *   1. **There is no SQL here.** `raw_staging` is ENABLE + FORCE row level
 *      security with a single policy satisfied only by membership of
 *      `nexus_raw_writer`, and every privilege is revoked from `authenticated`.
 *      A repository that selected from the table directly would fail closed, so
 *      every operation goes through a SECURITY DEFINER function that asserts a
 *      business capability first. That is deliberate: the raw body is reachable
 *      through six auditable functions, not through a table any caller can join.
 *   2. **The content hash is computed here, never accepted.** The hash is the
 *      permanent proof of which bytes produced the committed facts (the body is
 *      gone by then), so a caller must not be able to supply it — a wrong hash
 *      would make a re-extraction look like new evidence.
 *
 * Nothing in this module logs a payload, returns a payload to a caller that did
 * not ask for one, or copies a payload anywhere else.
 */
import 'server-only';

import { contentHash } from '@nexus/core';

import { withActor, type Viewer } from '../actor';
import type { Db } from '../sql';
import { asIso, asNumber, describeDbError } from './common';

/** The four raw kinds the database accepts (`raw_staging_kind_check`). */
export const RAW_STAGING_KINDS = [
  'profile_paste',
  'company_research',
  'signal_research',
  'source_metadata',
] as const;
export type RawStagingKind = (typeof RAW_STAGING_KINDS)[number];

export const RAW_STAGING_STATUSES = [
  'PENDING',
  'PROCESSING',
  'CONSUMED',
  'FAILED',
  'EXPIRED',
] as const;
export type RawStagingStatus = (typeof RAW_STAGING_STATUSES)[number];

export interface StagedRaw {
  readonly id: string;
}

export interface RawStagingRow {
  readonly id: string;
  readonly businessId: string;
  readonly leadId: string | null;
  readonly personId: string | null;
  readonly companyId: string | null;
  readonly agentJobId: string | null;
  readonly kind: RawStagingKind;
  readonly sourceType: string;
  readonly sourceUrl: string | null;
  /** The staged body. Never logged, never echoed to a client, never re-stored. */
  readonly payload: string;
  readonly contentHash: string;
  readonly collectorAgent: string | null;
  readonly status: RawStagingStatus;
  readonly attemptCount: number;
  readonly expiresAt: string | null;
}

export interface StageRawInput {
  readonly businessId: string;
  readonly leadId?: string | null;
  readonly personId?: string | null;
  readonly companyId?: string | null;
  readonly agentJobId?: string | null;
  readonly kind: RawStagingKind;
  readonly sourceType: string;
  readonly sourceUrl?: string | null;
  readonly payload: string;
  readonly collectorAgent?: string | null;
}

export type StageRawResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string };

/**
 * Stages one raw body and returns its id.
 *
 * The hash covers the payload exactly as staged, so a retry of the same paste is
 * recognisable as the same bytes without keeping the bytes.
 */
export async function stageRaw(viewer: Viewer, input: StageRawInput): Promise<StageRawResult> {
  if (input.payload.trim().length === 0) {
    return { ok: false, error: 'There is nothing to stage.' };
  }
  if (input.payload.length > 400_000) {
    // Matches `nexus_stage_raw`'s own ceiling so the caller gets a sentence
    // rather than a 22023 from the database.
    return { ok: false, error: 'The pasted content is too large to process in one attempt.' };
  }

  const hash = contentHash(input.payload);

  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string | null }>(
        `select public.nexus_stage_raw(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
         ) as id`,
        [
          input.businessId,
          input.leadId ?? null,
          input.personId ?? null,
          input.companyId ?? null,
          input.agentJobId ?? null,
          input.kind,
          input.sourceType,
          input.sourceUrl ?? null,
          input.payload,
          hash,
          input.collectorAgent ?? null,
        ],
      );
      const id = result.rows[0]?.id ?? null;
      if (id === null) {
        return { ok: false as const, error: 'The content could not be staged for processing.' };
      }
      return { ok: true as const, id };
    });
  } catch (error) {
    // `describeDbError` never surfaces SQL text, bound parameters or the payload.
    return { ok: false, error: describeDbError(error, 'stageRaw') };
  }
}

type RawRowShape = {
  id: string;
  business_id: string;
  lead_id: string | null;
  person_id: string | null;
  company_id: string | null;
  agent_job_id: string | null;
  kind: string;
  source_type: string;
  source_url: string | null;
  payload: string;
  content_hash: string;
  collector_agent: string | null;
  status: string;
  attempt_count: number;
  expires_at: unknown;
}

function asKind(value: string): RawStagingKind {
  return (RAW_STAGING_KINDS as readonly string[]).includes(value)
    ? (value as RawStagingKind)
    : 'source_metadata';
}

function asStatus(value: string): RawStagingStatus {
  return (RAW_STAGING_STATUSES as readonly string[]).includes(value)
    ? (value as RawStagingStatus)
    : 'PENDING';
}

function mapRaw(row: RawRowShape): RawStagingRow {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    leadId: row.lead_id === null ? null : String(row.lead_id),
    personId: row.person_id === null ? null : String(row.person_id),
    companyId: row.company_id === null ? null : String(row.company_id),
    agentJobId: row.agent_job_id === null ? null : String(row.agent_job_id),
    kind: asKind(row.kind),
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    payload: row.payload,
    contentHash: row.content_hash,
    collectorAgent: row.collector_agent,
    status: asStatus(row.status),
    attemptCount: asNumber(row.attempt_count, 0),
    expiresAt: asIso(row.expires_at),
  };
}

/**
 * Reads one staged body for one extraction attempt.
 *
 * Reading is the attempt: `nexus_read_raw_staging` increments `attempt_count` and
 * moves a PENDING row to PROCESSING, so a crash between read and delete is
 * visible rather than invisible. Returns null for both "no such row" and "not
 * yours" — distinguishing them would leak tenancy information.
 */
export async function readRaw(viewer: Viewer, id: string): Promise<RawStagingRow | null> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<RawRowShape>(
      `select id, business_id, lead_id, person_id, company_id, agent_job_id, kind,
              source_type, source_url, payload, content_hash, collector_agent,
              status, attempt_count, expires_at
         from public.nexus_read_raw_staging($1)`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRaw(row);
  });
}

/** Hard-deletes one staged body. Returns whether a row was actually removed. */
export async function deleteRaw(viewer: Viewer, id: string): Promise<boolean> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{ deleted: boolean | null }>(
      `select public.nexus_delete_raw_staging($1) as deleted`,
      [id],
    );
    return result.rows[0]?.deleted === true;
  });
}

/**
 * Marks a staged row as failed.
 *
 * Only the error *code* reaches the table: an upstream message can quote the
 * payload it was given, and this table's whole purpose is that the payload does
 * not persist.
 */
export async function markRawFailed(viewer: Viewer, id: string, errorCode: string): Promise<void> {
  await withActor(viewer.actor, async (sql) => {
    await sql.query(`select public.nexus_mark_raw_failed($1, $2)`, [id, errorCode.slice(0, 120)]);
  });
}

/** TTL sweep: deletes abandoned rows past `expires_at`. Idempotent. */
export async function cleanupExpiredRaw(viewer: Viewer, limit = 200): Promise<number> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{ deleted: number | null }>(
      `select public.nexus_cleanup_raw_staging($1) as deleted`,
      [Math.max(1, Math.trunc(limit))],
    );
    return asNumber(result.rows[0]?.deleted, 0);
  });
}

/**
 * The staged raw id for an agent job, read from the append-only event history.
 *
 * `raw_staging` itself is unreadable by a tenant — including the processor — so
 * the `result_submitted` event is the designed discovery path: it records the id
 * the moment the evidence was staged, and it is the only durable pointer.
 *
 * This is what lets the job-scoped path *reuse* the row a retry already staged,
 * which matters beyond tidiness: `nexus_complete_agent_job` refuses while any
 * un-consumed row remains for the job, so a second staged row would make the job
 * uncompletable forever.
 */
export async function findStagedRawIdForJob(sql: Db, jobId: string): Promise<string | null> {
  const result = await sql.query<{ raw_staging_id: string | null }>(
    `select nullif(e.payload ->> 'raw_staging_id', '') as raw_staging_id
       from public.agent_job_events e
      where e.job_id = $1
        and e.event_type = 'result_submitted'
        and e.payload ? 'raw_staging_id'
      order by e.created_at desc
      limit 1`,
    [jobId],
  );
  return result.rows[0]?.raw_staging_id ?? null;
}
