/**
 * The durable agent job queue — reads, and the mutations that go through the
 * database's own functions.
 *
 * `agent_jobs` has a read policy and nothing else: `authenticated` is granted
 * `select` and has `insert`, `update`, `delete` and `truncate` revoked. That is
 * not an oversight to be worked around; it is the mechanism that makes "an agent
 * cannot mark its own work COMPLETE" true (spec §41.5). Every mutation below
 * therefore calls a SECURITY DEFINER function, and each of those asserts a
 * business capability before it touches a row.
 *
 * The one thing this module adds on top is *planning*: `chainJobsForLead` asks
 * `planChainedJobs` in `@nexus/core` what is outstanding from the lead's stored
 * facts and creates at most one job per plan, so a page reload cannot produce a
 * second copy of work already in flight.
 */
import 'server-only';

import {
  AGENT_JOB_CAPABILITIES,
  AGENT_JOB_STATUSES,
  AGENT_JOB_TYPES,
  contentHash,
  defaultPriority,
  planChainedJobs,
  type AgentJobPriority,
  type AgentJobStatus,
  type AgentJobType,
  type EnrichmentState,
  type QualificationChainInput,
} from '@nexus/core';

import { withActor, type Viewer } from '../actor';
import type { Db } from '../sql';
import {
  asIso,
  asNumber,
  asStringArray,
  normalizePaging,
  totalFrom,
} from './common';

export interface AgentJobRecord {
  readonly id: string;
  readonly businessId: string;
  readonly leadId: string | null;
  readonly personId: string | null;
  readonly companyId: string | null;
  readonly jobType: AgentJobType;
  readonly priority: AgentJobPriority;
  readonly status: AgentJobStatus;
  readonly instructions: string | null;
  readonly requiredCapabilities: readonly string[];
  readonly createdByType: string;
  readonly claimedByAgent: string | null;
  readonly claimedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lastErrorCode: string | null;
  readonly dedupeKey: string | null;
  readonly reason: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly completedAt: string | null;
  /** Person and/or company name, so the queue is readable without a second query. */
  readonly entityLabel: string | null;
}

export interface AgentJobEvent {
  readonly id: string;
  readonly eventType: string;
  readonly actorType: string;
  readonly agentName: string | null;
  readonly note: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string | null;
}

/** The event select, shared by the list reads. Notes are short operator text only. */
const JOB_SELECT = `
  select j.id, j.business_id, j.lead_id, j.person_id, j.company_id, j.job_type, j.priority,
         j.status, j.instructions, j.required_capabilities, j.created_by_type, j.claimed_by_agent,
         j.claimed_at, j.lease_expires_at, j.last_heartbeat_at, j.attempt_count, j.max_attempts,
         j.last_error_code, j.dedupe_key, j.reason, j.created_at, j.updated_at, j.completed_at,
         case
           when j.job_type in ('RESEARCH_COMPANY', 'RESEARCH_SIGNALS') then coalesce(c.name, p.full_name)
           else coalesce(p.full_name, c.name)
         end as entity_label
    from public.agent_jobs j
    left join public.leads l on l.id = j.lead_id
    left join public.people p on p.id = coalesce(j.person_id, l.person_id)
    left join public.companies c on c.id = coalesce(j.company_id, l.company_id)
`;

type JobRow = {
  id: string;
  business_id: string;
  lead_id: string | null;
  person_id: string | null;
  company_id: string | null;
  job_type: string;
  priority: string;
  status: string;
  instructions: string | null;
  required_capabilities: string[] | null;
  created_by_type: string;
  claimed_by_agent: string | null;
  claimed_at: unknown;
  lease_expires_at: unknown;
  last_heartbeat_at: unknown;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
  dedupe_key: string | null;
  reason: string | null;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
  entity_label?: string | null;
}

const JOB_TYPE_SET: ReadonlySet<string> = new Set<string>(AGENT_JOB_TYPES);
const JOB_STATUS_SET: ReadonlySet<string> = new Set<string>(AGENT_JOB_STATUSES);

function asJobType(value: string): AgentJobType {
  return JOB_TYPE_SET.has(value) ? (value as AgentJobType) : 'OTHER';
}

function asJobStatus(value: string): AgentJobStatus {
  return JOB_STATUS_SET.has(value) ? (value as AgentJobStatus) : 'OPEN';
}

function asPriority(value: string): AgentJobPriority {
  return value === 'low' || value === 'high' || value === 'urgent' ? value : 'normal';
}

function mapJob(row: JobRow): AgentJobRecord {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    leadId: row.lead_id === null ? null : String(row.lead_id),
    personId: row.person_id === null ? null : String(row.person_id),
    companyId: row.company_id === null ? null : String(row.company_id),
    jobType: asJobType(row.job_type),
    priority: asPriority(row.priority),
    status: asJobStatus(row.status),
    instructions: row.instructions,
    requiredCapabilities: asStringArray(row.required_capabilities),
    createdByType: row.created_by_type,
    claimedByAgent: row.claimed_by_agent,
    claimedAt: asIso(row.claimed_at),
    leaseExpiresAt: asIso(row.lease_expires_at),
    lastHeartbeatAt: asIso(row.last_heartbeat_at),
    attemptCount: asNumber(row.attempt_count, 0),
    maxAttempts: asNumber(row.max_attempts, 3),
    lastErrorCode: row.last_error_code,
    dedupeKey: row.dedupe_key,
    reason: row.reason,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    completedAt: asIso(row.completed_at),
    entityLabel: row.entity_label ?? null,
  };
}

/* ---------------------------------------------------------------- reads -- */

export interface ListAgentJobsParams {
  readonly businessId: string;
  readonly status?: AgentJobStatus;
  readonly jobType?: AgentJobType;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * One page of the queue, newest first, with the total for "showing N of M".
 *
 * The filters are optional *parameters* rather than interpolated SQL, so the
 * status and type vocabularies stay the database's business.
 */
export async function listAgentJobs(
  viewer: Viewer,
  params: ListAgentJobsParams,
): Promise<{ jobs: readonly AgentJobRecord[]; total: number }> {
  const { limit, offset } = normalizePaging({ limit: params.limit, offset: params.offset });

  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<JobRow & { total_count: number }>(
      `select q.*, count(*) over () as total_count
         from (${JOB_SELECT}
               where j.business_id = $1
                 and ($2::text is null or j.status = $2)
                 and ($3::text is null or j.job_type = $3)
               order by
                 case j.status
                   when 'WAITING_AI' then 0
                   when 'RUNNING' then 1
                   when 'OPEN' then 2
                   when 'FAILED' then 3
                   else 4
                 end,
                 case j.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
                 j.created_at desc
               limit $4 offset $5) q`,
      [params.businessId, params.status ?? null, params.jobType ?? null, limit, offset],
    );

    return { jobs: result.rows.map(mapJob), total: totalFrom(result.rows) };
  });
}

export async function getAgentJob(viewer: Viewer, jobId: string): Promise<AgentJobRecord | null> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<JobRow>(`${JOB_SELECT} where j.id = $1`, [jobId]);
    const row = result.rows[0];
    return row === undefined ? null : mapJob(row);
  });
}

export async function listAgentJobEvents(
  viewer: Viewer,
  jobId: string,
  limit = 50,
): Promise<readonly AgentJobEvent[]> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{
      id: string;
      event_type: string;
      actor_type: string;
      agent_name: string | null;
      note: string | null;
      payload: Record<string, unknown> | null;
      created_at: unknown;
    }>(
      `select id, event_type, actor_type, agent_name, note, payload, created_at
         from public.agent_job_events
        where job_id = $1
        order by created_at desc
        limit $2`,
      [jobId, Math.max(1, Math.trunc(limit))],
    );

    return result.rows.map((row) => ({
      id: String(row.id),
      eventType: row.event_type,
      actorType: row.actor_type,
      agentName: row.agent_name,
      note: row.note,
      payload: row.payload ?? {},
      createdAt: asIso(row.created_at),
    }));
  });
}

/** The queue depth per status, zero-filled so a screen never renders an undefined bucket. */
export async function agentJobSummary(
  viewer: Viewer,
  businessId: string,
): Promise<Readonly<Record<AgentJobStatus, number>>> {
  const summary: Record<AgentJobStatus, number> = {
    OPEN: 0,
    RUNNING: 0,
    WAITING_AI: 0,
    COMPLETE: 0,
    FAILED: 0,
    CANCELLED: 0,
  };

  const rows = await withActor(viewer.actor, async (sql) =>
    sql.query<{ status: string; n: number }>(
      `select status, count(*)::int as n
         from public.agent_jobs
        where business_id = $1
        group by status`,
      [businessId],
    ),
  );

  for (const row of rows.rows) {
    if (JOB_STATUS_SET.has(row.status)) summary[row.status as AgentJobStatus] = asNumber(row.n, 0);
  }
  return summary;
}

/* --------------------------------------------------------------- writes -- */

export interface CreateAgentJobInput {
  readonly businessId: string;
  readonly jobType: AgentJobType;
  readonly leadId?: string | null;
  readonly personId?: string | null;
  readonly companyId?: string | null;
  readonly priority?: AgentJobPriority;
  readonly instructions?: string | null;
  readonly requiredCapabilities?: readonly string[];
  readonly dedupeKey?: string | null;
  readonly reason?: string | null;
}

/**
 * `created_by_type`, derived from who is asking.
 *
 * Derived rather than accepted: a caller that could claim to be an `agent` while
 * holding a user session would make the queue's provenance meaningless.
 */
function createdBy(viewer: Viewer): { type: 'user' | 'api_client' | 'system'; id: string | null } {
  if (viewer.actor.kind === 'user') return { type: 'user', id: viewer.actor.userId };
  if (viewer.actor.kind === 'api_client') return { type: 'api_client', id: viewer.actor.apiClientId };
  return { type: 'system', id: null };
}

/**
 * Creates a job, or returns the live one that already carries its dedupe key.
 *
 * `created: false` is a success, not a refusal: the caller asked for a state and
 * that state holds.
 */
export async function createAgentJob(
  viewer: Viewer,
  input: CreateAgentJobInput,
): Promise<{ jobId: string; created: boolean }> {
  if (!JOB_TYPE_SET.has(input.jobType)) {
    throw new Error(`Unknown agent job type: ${String(input.jobType)}`);
  }

  const actor = createdBy(viewer);
  const capabilities =
    input.requiredCapabilities === undefined
      ? AGENT_JOB_CAPABILITIES[input.jobType]
      : input.requiredCapabilities;
  const priority = input.priority ?? defaultPriority(input.jobType);

  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{ job_id: string | null; created: boolean }>(
      `select job_id, created from public.nexus_create_agent_job(
         $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12
       )`,
      [
        input.businessId,
        input.jobType,
        input.leadId ?? null,
        input.personId ?? null,
        input.companyId ?? null,
        priority,
        input.instructions ?? null,
        [...capabilities],
        actor.type,
        actor.id,
        input.dedupeKey ?? null,
        input.reason ?? null,
      ],
    );

    const row = result.rows[0];
    if (row?.job_id === undefined || row.job_id === null) {
      throw new Error('The agent job could not be created.');
    }
    return { jobId: String(row.job_id), created: row.created === true };
  });
}

export async function cancelAgentJob(viewer: Viewer, jobId: string, reason?: string): Promise<void> {
  await withActor(viewer.actor, async (sql) => {
    await sql.query(`select public.nexus_cancel_agent_job($1, $2)`, [jobId, reason ?? null]);
  });
}

/* ------------------------------------------------------- agent-facing ---- */

export interface ClaimAgentJobInput {
  readonly businessId: string;
  readonly agent: string;
  readonly capabilities?: readonly string[];
  readonly jobId?: string | null;
  readonly leaseSeconds?: number;
}

/**
 * Atomically claims one job, or returns null when nothing is claimable.
 *
 * "Nothing claimable" is not an error: an agent polling an empty queue must get an
 * empty answer rather than a failure it would retry.
 */
export async function claimAgentJob(
  viewer: Viewer,
  input: ClaimAgentJobInput,
): Promise<AgentJobRecord | null> {
  return withActor(viewer.actor, async (sql) => {
    const claimed = await sql.query<{ id: string | null }>(
      `select id from public.nexus_claim_agent_job($1, $2, $3::text[], $4, $5)`,
      [
        input.businessId,
        input.agent,
        [...(input.capabilities ?? [])],
        input.jobId ?? null,
        input.leaseSeconds ?? 900,
      ],
    );
    const id = claimed.rows[0]?.id ?? null;
    if (id === null) return null;

    // Re-read inside the same transaction: the claim function returns the fields an
    // agent needs to work, and this returns the row the rest of the product reads,
    // so the two cannot disagree.
    const row = await loadJobRow(sql, String(id));
    return row === null ? null : mapJob(row);
  });
}

async function loadJobRow(sql: Db, jobId: string): Promise<JobRow | null> {
  const result = await sql.query<JobRow>(`${JOB_SELECT} where j.id = $1`, [jobId]);
  return result.rows[0] ?? null;
}

export interface HeartbeatAgentJobInput {
  readonly jobId: string;
  readonly agent: string;
  readonly leaseSeconds?: number;
}

export async function heartbeatAgentJob(
  viewer: Viewer,
  input: HeartbeatAgentJobInput,
): Promise<{ id: string; status: string; leaseExpiresAt: string | null; attemptCount: number }> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{
      id: string;
      status: string;
      lease_expires_at: unknown;
      attempt_count: number;
    }>(
      `select id, status, lease_expires_at, attempt_count
         from public.nexus_heartbeat_agent_job($1, $2, $3)`,
      [input.jobId, input.agent, input.leaseSeconds ?? 900],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('That agent job could not be found.');
    return {
      id: String(row.id),
      status: row.status,
      leaseExpiresAt: asIso(row.lease_expires_at),
      attemptCount: asNumber(row.attempt_count, 0),
    };
  });
}

export async function releaseAgentJob(
  viewer: Viewer,
  input: { readonly jobId: string; readonly agent: string; readonly reason?: string },
): Promise<void> {
  await withActor(viewer.actor, async (sql) => {
    await sql.query(`select public.nexus_release_agent_job($1, $2, $3)`, [
      input.jobId,
      input.agent,
      input.reason ?? null,
    ]);
  });
}

export interface FailAgentJobInput {
  readonly jobId: string;
  readonly agent: string;
  readonly errorCode: string;
  readonly message?: string;
  readonly retryable?: boolean;
}

export async function failAgentJob(
  viewer: Viewer,
  input: FailAgentJobInput,
): Promise<{ id: string; status: string; attemptCount: number }> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{ id: string; status: string; attempt_count: number }>(
      `select id, status, attempt_count
         from public.nexus_fail_agent_job($1, $2, $3, $4, $5)`,
      [
        input.jobId,
        input.agent,
        // A code, truncated by the function to 120 characters. The message is short
        // operator text and never a raw body.
        input.errorCode.slice(0, 120),
        input.message?.slice(0, 500) ?? null,
        input.retryable ?? true,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('That agent job could not be found.');
    return {
      id: String(row.id),
      status: row.status,
      attemptCount: asNumber(row.attempt_count, 0),
    };
  });
}

export interface SubmitAgentJobResultInput {
  readonly jobId: string;
  readonly agent: string;
  readonly payload: string;
  readonly kind?: 'company_research' | 'signal_research' | 'source_metadata' | 'profile_paste';
  readonly sourceType?: string;
  readonly sourceUrl?: string | null;
}

/**
 * Stages the evidence and moves the job to `WAITING_AI`. It cannot reach
 * `COMPLETE` — that transition does not exist in the function's scope.
 */
export async function submitAgentJobResult(
  viewer: Viewer,
  input: SubmitAgentJobResultInput,
): Promise<{ jobId: string; status: string; rawStagingId: string }> {
  const hash = contentHash(input.payload);

  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{
      job_id: string;
      status: string;
      raw_staging_id: string;
    }>(
      `select job_id, status, raw_staging_id
         from public.nexus_submit_agent_job_result($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.jobId,
        input.agent,
        input.payload,
        hash,
        input.kind ?? 'company_research',
        input.sourceType ?? 'web',
        input.sourceUrl ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The agent job result could not be submitted.');
    return {
      jobId: String(row.job_id),
      status: row.status,
      rawStagingId: String(row.raw_staging_id),
    };
  });
}

/**
 * Completes a job. The database refuses this unless the job is `WAITING_AI` and no
 * un-consumed staging row remains for it (55006), so "the raw body is gone before
 * the job is done" is enforced rather than promised.
 */
export async function completeAgentJob(
  viewer: Viewer,
  input: { readonly jobId: string; readonly aiRunId?: string | null },
): Promise<{ jobId: string; status: string }> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{ job_id: string; status: string }>(
      `select job_id, status from public.nexus_complete_agent_job($1, $2)`,
      [input.jobId, input.aiRunId ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The agent job could not be completed.');
    return { jobId: String(row.job_id), status: row.status };
  });
}

/** Moves expired leases back to the queue. Idempotent under concurrency. */
export async function reapExpiredLeases(viewer: Viewer): Promise<number> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{ reaped: number | null }>(
      `select public.nexus_reap_expired_job_leases(50) as reaped`,
    );
    return asNumber(result.rows[0]?.reaped, 0);
  });
}

/* --------------------------------------------------- model-only work ----- */

export interface ClaimedDirectJob {
  readonly jobId: string;
  readonly businessId: string;
  readonly jobType: string;
  readonly leadId: string | null;
  readonly personId: string | null;
  readonly companyId: string | null;
  readonly attemptCount: number;
  readonly leaseExpiresAt: string | null;
}

/**
 * Claims `OPEN` jobs whose whole job is a model call (qualification, context).
 *
 * Distinct from `nexus_claim_ai_work`, which takes `WAITING_AI` jobs — those have a
 * staged body an agent produced. These have no body: their prerequisites are
 * committed structured facts, so they are claimable as soon as the planner creates
 * them. The lease, the attempt count and `SKIP LOCKED` are the same, so two
 * processors cannot take the same job and a dead processor's work returns to the
 * queue through the ordinary reaper.
 */
export async function claimDirectAiWork(
  viewer: Viewer,
  input: {
    readonly businessId?: string | null;
    readonly limit?: number;
    readonly leaseSeconds?: number;
    readonly jobTypes?: readonly string[];
    readonly capabilities?: readonly string[];
  } = {},
): Promise<readonly ClaimedDirectJob[]> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{
      job_id: string;
      business_id: string;
      job_type: string;
      lead_id: string | null;
      person_id: string | null;
      company_id: string | null;
      attempt_count: number;
      lease_expires_at: unknown;
    }>(
      `select job_id, business_id, job_type, lead_id, person_id, company_id,
              attempt_count, lease_expires_at
         from public.nexus_claim_ai_direct_work($1, $2, $3, $4::text[], $5::text[])`,
      [
        input.limit ?? 5,
        input.businessId ?? null,
        input.leaseSeconds ?? 600,
        input.jobTypes ?? ['QUALIFY_LEAD', 'BUILD_CONTEXT'],
        input.capabilities ?? ['ai_qualify', 'ai_context'],
      ],
    );
    return result.rows.map((row) => ({
      jobId: String(row.job_id),
      businessId: String(row.business_id),
      jobType: row.job_type,
      leadId: row.lead_id === null ? null : String(row.lead_id),
      personId: row.person_id === null ? null : String(row.person_id),
      companyId: row.company_id === null ? null : String(row.company_id),
      attemptCount: asNumber(row.attempt_count, 0),
      leaseExpiresAt: asIso(row.lease_expires_at),
    }));
  });
}

/**
 * Completes a model-only job.
 *
 * The database still refuses while an un-consumed staging row exists and still
 * refuses unless the caller holds the running lease, so "complete only after the
 * structured result is persisted and nothing raw is left behind" holds for these
 * jobs exactly as it does for an extraction job.
 */
export async function completeDirectAgentJob(
  viewer: Viewer,
  input: { readonly jobId: string; readonly aiRunId?: string | null; readonly agent?: string },
): Promise<{ jobId: string; status: string }> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{ job_id: string; status: string }>(
      `select job_id, status from public.nexus_complete_direct_agent_job($1, $2, $3)`,
      [input.jobId, input.aiRunId ?? null, input.agent ?? 'ai_processor'],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The agent job could not be completed.');
    return { jobId: String(row.job_id), status: row.status };
  });
}

/* ---------------------------------------------------------------- chain -- */

export interface ChainJobsResult {
  readonly jobId: string;
  readonly created: boolean;
  readonly jobType: AgentJobType;
}

type ChainFactRow = {
  lead_id: string;
  person_id: string;
  company_id: string | null;
  enrichment_state: string;
  has_linkedin: boolean;
  has_company_website: boolean;
  has_company_research: boolean;
  has_ai_context: boolean;
}

/**
 * Plans and creates the automatic jobs this lead is missing.
 *
 * The plan is derived from stored facts only — no model call decides whether work
 * is needed — and each plan carries a `dedupe_key` derived from the entity, so
 * re-running this is a no-op rather than a second copy of the same work.
 */
export async function chainJobsForLead(
  viewer: Viewer,
  input: {
    readonly businessId: string;
    readonly leadId: string;
    /**
     * Qualification state, when the caller can supply it.
     *
     * The planner needs to know whether the stored qualification answers today's
     * facts, and only the AI layer can compute that (the hash is over the same
     * canonical projection the prompt uses). A caller that omits it plans no
     * qualification — the conservative default, because a caller that cannot judge
     * staleness must not cause a model call.
     */
    readonly qualification?: QualificationChainInput;
  },
): Promise<readonly ChainJobsResult[]> {
  // Facts and open keys are read in one transaction; job creation then happens
  // outside it, because each creation opens its own transaction and a nested
  // `begin` on the shared connection would commit the outer one.
  const planned = await withActor(viewer.actor, async (sql) => {
    const facts = await sql.query<ChainFactRow>(
      `select l.id as lead_id,
              l.person_id,
              l.company_id,
              coalesce(e.status, 'MINIMAL') as enrichment_state,
              (p.normalized_linkedin_url is not null or p.linkedin_url is not null) as has_linkedin,
              (coalesce(c.primary_domain, c.normalized_domain) is not null) as has_company_website,
              exists (
                select 1 from public.research_snapshots r
                 where r.lead_id = l.id
                    or (l.company_id is not null and r.company_id = l.company_id)
              ) as has_company_research,
              exists (select 1 from public.ai_context_packs a where a.lead_id = l.id) as has_ai_context
         from public.leads l
         join public.people p on p.id = l.person_id
         left join public.companies c on c.id = l.company_id
         left join public.lead_enrichment e on e.lead_id = l.id
        where l.id = $1
          and l.business_id = $2
          and l.deleted_at is null`,
      [input.leadId, input.businessId],
    );
    const row = facts.rows[0];
    if (row === undefined) return [];

    const open = await sql.query<{ dedupe_key: string | null }>(
      `select dedupe_key
         from public.agent_jobs
        where business_id = $1
          and lead_id = $2
          and status in ('OPEN', 'RUNNING', 'WAITING_AI')
          and dedupe_key is not null`,
      [input.businessId, input.leadId],
    );

    return planChainedJobs({
      leadId: String(row.lead_id),
      personId: row.person_id === null ? null : String(row.person_id),
      companyId: row.company_id === null ? null : String(row.company_id),
      enrichmentState: (row.enrichment_state as EnrichmentState) ?? 'MINIMAL',
      hasLinkedinUrl: row.has_linkedin === true,
      hasCompanyWebsite: row.has_company_website === true,
      hasCompanyResearch: row.has_company_research === true,
      hasAiContext: row.has_ai_context === true,
      openJobKeys: open.rows
        .map((entry) => entry.dedupe_key)
        .filter((key): key is string => typeof key === 'string' && key.length > 0),
      ...(input.qualification === undefined ? {} : { qualification: input.qualification }),
    });
  });

  const created: ChainJobsResult[] = [];
  for (const plan of planned) {
    const outcome = await createAgentJob(viewer, {
      businessId: input.businessId,
      jobType: plan.type,
      leadId: input.leadId,
      priority: plan.priority,
      instructions: plan.instructions,
      requiredCapabilities: plan.requiredCapabilities,
      dedupeKey: plan.dedupeKey,
      reason: plan.reason,
    });
    created.push({ jobId: outcome.jobId, created: outcome.created, jobType: plan.type });
  }

  return created;
}

