import type { ReactNode } from 'react';

import {
  AGENT_JOB_PRIORITIES,
  AGENT_JOB_STATUSES,
  AGENT_JOB_TYPES,
  routePermissionsFor,
  type AgentJobPriority,
  type AgentJobStatus,
  type AgentJobType,
} from '@nexus/core';
import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  PageHead,
  Row,
  Stack,
  Stat,
  VisuallyHidden,
  type Column,
} from '@nexus/ui';
import { notFound, redirect } from 'next/navigation';

import {
  AgentJobRowActions,
  AgentJobsFilterForm,
  AttemptsText,
  CreateAgentJobForm,
  JobPriorityChip,
  JobStatusCell,
  JobTypeChip,
  LeaseCell,
  ReleaseStaleClaimsForm,
  TimestampText,
} from '@/components/agent-job-forms';
import { withActor, type Actor, type Viewer } from '@/lib/actor';
import { PAGE_SIZE_PARAM, filterHref, pageHref } from '@/lib/filter-url';
import { agentJobSummary, listAgentJobs, type AgentJobRecord } from '@/lib/repo/agent-jobs';
import { asIso, asNumber, asStringArray } from '@/lib/repo/common';
import { listLeads } from '@/lib/repo/leads';
import { requireRouteAccess } from '@/lib/route-guard';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';

import { createAgentJobAction, runAgentJobOperationAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * A33 — Agent Jobs: the durable queue (spec §70).
 *
 * What an operator comes here for is a decision: *is this lead's work moving, and if not, what
 * do I do about it?* So the screen leads with the five queue buckets, then the rows, then the
 * one safe intervention (put a terminal job back on the queue, or release a claim whose lease
 * lapsed).
 *
 * Three rules shape it:
 *
 *   * **The five buckets are the only buckets** (§70.2): OPEN, RUNNING, WAITING AI, FAILED and
 *     DONE TODAY, where DONE TODAY is `COMPLETE` with `completed_at` today. Nothing else is
 *     invented, and an empty bucket shows zero rather than disappearing.
 *   * **There is no manual "complete"** (§70.4). The row controls offer retry, cancel, release
 *     and open — and nothing else. `agent_jobs` has no UPDATE policy, so the absent button is
 *     the absence of a path; the screen says so in words so nobody goes looking for it.
 *   * **Nothing here calls a model** (§76.1). Every figure is a structured read, the
 *     independent reads are issued together, and the one dependent read (the newest event per
 *     row) is a single bounded query keyed by the page's ids.
 *
 * Presentation — status accents, lease state, timestamp format — lives in
 * `@/components/agent-job-forms`, which is a client module: a non-component export of such a
 * module cannot be called from a Server Component, so each mapped value is rendered through a
 * small component. That is what keeps "what FAILED looks like" defined once.
 */
export type AgentJobsSearchParams = {
  readonly [key: string]: string | undefined;
  readonly status?: string;
  readonly jobType?: string;
  readonly stale?: string;
  readonly page?: string;
  readonly pageSize?: string;
};

/** Rows per page unless the URL asks otherwise. */
const DEFAULT_PAGE_SIZE = 25;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;

/**
 * The route pattern this screen is judged against.
 *
 * `packages/core` owns the route → permission matrix and is being extended by the agent that
 * owns that package; `/b/:businessSlug/agent-jobs` is not in it yet. The guard fails closed on
 * an undeclared route — which would make this screen unreachable — so until that entry lands
 * the screen is judged by the requirement of the section §70.1 places it in: Integrations /
 * Automation. `routePermissionsFor` is consulted first, so the screen follows the matrix the
 * moment the entry exists. `actions.ts` resolves the same pattern for its own guard.
 */
const AGENT_JOBS_ROUTE: string =
  routePermissionsFor('/b/:businessSlug/agent-jobs') === null
    ? '/b/:businessSlug/automations'
    : '/b/:businessSlug/agent-jobs';

/** True when a boolean-ish flag param is present and not explicitly switched off. */
function flagged(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/** The page size the URL asks for, clamped. */
function parsePageSize(value: string | undefined): number {
  const parsed = Number(value ?? String(DEFAULT_PAGE_SIZE));
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(parsed), MIN_PAGE_SIZE), MAX_PAGE_SIZE);
}

function parseStatus(value: string | undefined): AgentJobStatus | null {
  return value !== undefined && (AGENT_JOB_STATUSES as readonly string[]).includes(value)
    ? (value as AgentJobStatus)
    : null;
}

function parseJobType(value: string | undefined): AgentJobType | null {
  return value !== undefined && (AGENT_JOB_TYPES as readonly string[]).includes(value)
    ? (value as AgentJobType)
    : null;
}

export default async function AgentJobsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<AgentJobsSearchParams>;
}): Promise<ReactNode> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  requireRouteAccess(context, { route: AGENT_JOBS_ROUTE, businessId: business.id });

  const page = Math.max(Number(query.page ?? '1') || 1, 1);
  const pageSize = parsePageSize(query.pageSize);
  const status = parseStatus(query.status);
  const jobType = parseJobType(query.jobType);
  const staleOnly = flagged(query.stale);

  /**
   * Whether the viewer may change the queue.
   *
   * The same capability the database asserts in `nexus_job_scope_ok`: an administrator, or a
   * person who can manage leads in this business. It decides which controls are rendered —
   * never what is allowed, because every action re-checks on the server and `agent_jobs` has no
   * UPDATE policy at all.
   */
  const grant = context.grants.find((candidate) => candidate.businessId === business.id);
  const canManageJobs = context.viewer.role === 'admin' || grant?.canManageLeads === true;

  /**
   * The independent reads, issued together (§76.3): one page of jobs (the repository's own
   * read, or the stale-lease read when the toggle is on), the five buckets, the "done today"
   * count, the number of claims the reaper would release, and a bounded lead list for the
   * create form. No read here re-resolves the viewer or the business (§76.4).
   */
  const paging = { limit: pageSize, offset: (page - 1) * pageSize };
  const [jobPage, summary, doneToday, staleCount, leadPage] = await Promise.all([
    staleOnly
      ? listStaleAgentJobs(context.viewer, { businessId: business.id, status, jobType, ...paging })
      : listAgentJobs(context.viewer, {
          businessId: business.id,
          ...(status === null ? {} : { status }),
          ...(jobType === null ? {} : { jobType }),
          ...paging,
        }),
    agentJobSummary(context.viewer, business.id),
    completedToday(context.viewer.actor, business.id),
    staleClaimCount(context.viewer.actor, business.id),
    listLeads(context.viewer.actor, { businessId: business.id }, { limit: 50 }),
  ]);

  const total = jobPage.total;
  const offset = paging.offset;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const basePath = `/b/${business.key}/agent-jobs`;

  /**
   * A page past the end is corrected rather than rendered empty: "you overshot" and "there is
   * nothing here" must not present as the same screen.
   */
  if (page > totalPages) redirect(pageHref(basePath, query, totalPages));

  /**
   * The newest event per visible job (§70.5). One statement keyed by the ids just read, rather
   * than a query per row: twenty-five transactions to render one table is the waterfall §76.3
   * forbids. This is the one read that depends on the page above, which is why it is not in
   * the `Promise.all`.
   */
  const notes = await lastEventNotes(
    context.viewer.actor,
    jobPage.jobs.map((job) => job.id),
  );

  /* `nowIso` comes from the server so the first paint and the hydrated render agree about
   * which leases are expired. */
  const nowIso = new Date().toISOString();

  const columns: readonly Column<AgentJobRecord>[] = [
    {
      key: 'priority',
      header: 'Priority',
      cell: (job) => <JobPriorityChip priority={job.priority} />,
    },
    {
      key: 'type',
      header: 'Type',
      cell: (job) => <JobTypeChip jobType={job.jobType} />,
    },
    {
      key: 'reason',
      header: 'Why / dedupe key',
      // §70.6: why the job exists and the key that stops automatic chaining from creating a
      // second identical job, so a chained job is distinguishable from a hand-made one.
      cell: (job) => (
        <div className="nx-stack nx-stack--sm">
          <span className="nx-hint" title={job.instructions ?? undefined}>
            {job.reason ?? 'no reason recorded'}
          </span>
          <span className="nx-table__mono">{job.dedupeKey ?? 'no dedupe key'}</span>
        </div>
      ),
    },
    {
      key: 'entity',
      header: 'Entity',
      cell: (job) =>
        job.leadId === null ? (
          <span className="nx-hint">{job.entityLabel ?? 'no entity'}</span>
        ) : (
          <a href={`/b/${business.key}/leads/${job.leadId}`}>
            {job.entityLabel ?? 'Open lead'}
          </a>
        ),
    },
    {
      key: 'business',
      header: 'Business',
      cell: () => business.name,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (job) => {
        const note = notes.get(job.id);
        return (
          <JobStatusCell
            status={job.status}
            lastErrorCode={job.lastErrorCode}
            eventType={note?.eventType ?? null}
            note={note?.note ?? null}
          />
        );
      },
    },
    {
      key: 'agent',
      header: 'Agent',
      cell: (job) =>
        job.claimedByAgent === null ? (
          <span className="nx-hint">unclaimed</span>
        ) : (
          <span title={job.claimedAt ?? undefined}>{job.claimedByAgent}</span>
        ),
    },
    {
      key: 'lease',
      header: 'Lease',
      cell: (job) => <LeaseCell leaseExpiresAt={job.leaseExpiresAt} nowIso={nowIso} />,
    },
    {
      key: 'attempts',
      header: 'Attempts',
      numeric: true,
      cell: (job) => (
        <AttemptsText attemptCount={job.attemptCount} maxAttempts={job.maxAttempts} />
      ),
    },
    {
      key: 'created',
      header: 'Created',
      mono: true,
      cell: (job) => <TimestampText value={job.createdAt} />,
    },
    {
      key: 'updated',
      header: 'Updated',
      mono: true,
      cell: (job) => <TimestampText value={job.updatedAt} />,
    },
    {
      key: 'actions',
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: '132px',
      /*
       * The authorized actions, and only those: retry (FAILED / CANCELLED), cancel, release a
       * stale claim, open the entity. There is deliberately no "Mark complete" control here,
       * and `agent-job-forms.tsx` has no operation that could produce one.
       */
      cell: (job) => (
        <AgentJobRowActions
          action={runAgentJobOperationAction}
          jobId={job.id}
          businessId={business.id}
          businessSlug={business.key}
          status={job.status}
          leaseExpiresAt={job.leaseExpiresAt}
          nowIso={nowIso}
          leadHref={job.leadId === null ? null : `/b/${business.key}/leads/${job.leadId}`}
          canAct={canManageJobs}
        />
      ),
    },
  ];

  const filtered = status !== null || jobType !== null || staleOnly;

  /**
   * A stale filter combined with a status that cannot be stale.
   *
   * A stale claim is a RUNNING job whose lease lapsed, so asking for "stale" and "Complete"
   * together matches nothing. That is a contradiction in the query rather than an empty queue,
   * and the empty state says which one it is instead of leaving the operator to guess.
   */
  const staleStatusContradiction = staleOnly && status !== null && status !== 'RUNNING';

  return (
    <>
      <PageHead
        subtitle={`Durable research and enrichment work for ${business.name}: created here, by chained planning, or by an agent through MCP — claimed, leased and reaped in the database.`}
        actions={
          <ReleaseStaleClaimsForm
            action={runAgentJobOperationAction}
            businessId={business.id}
            businessSlug={business.key}
            staleCount={staleCount}
            canAct={canManageJobs}
          />
        }
      >
        Agent Jobs
      </PageHead>

      {/*
        The five buckets, in the spec's order and with no sixth invented. A zero here is a fact
        about the queue, not a missing number.
      */}
      <Grid cols={4}>
        <Stat value={summary.OPEN} label="Open" meta="claimable now" />
        <Stat value={summary.RUNNING} label="Running" meta="held under a lease" />
        <Stat
          value={summary.WAITING_AI}
          label="Waiting AI"
          meta="evidence staged, extraction pending"
        />
        <Stat value={summary.FAILED} label="Failed" meta="terminal until retried" />
        <Stat value={doneToday} label="Done today" meta="completed since midnight (database time)" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="indigo" title="Completion is not a manual action">
        A job becomes <strong>Complete</strong> only when the extraction pipeline has validated
        the staged evidence, committed the structured facts and deleted the raw body — the
        database refuses the transition while that evidence still exists, and{' '}
        <code>agent_jobs</code> has no update policy at all. This screen can create, retry,
        cancel and release a lease; it has no way to complete a job, by design (§41.3, §70.4).
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="Filters"
        actions={<Chip>{`${String(total)} job${total === 1 ? '' : 's'}`}</Chip>}
      >
        <AgentJobsFilterForm
          basePath={basePath}
          current={{ status, jobType, staleOnly }}
          pageSize={query.pageSize === undefined ? null : pageSize}
        />
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />

      <Card title="Queue">
        <DataTable
          columns={columns}
          rows={jobPage.jobs}
          rowKey={(job) => job.id}
          caption="Agent jobs visible to you in this business"
          empty={
            staleOnly ? (
              <EmptyState
                title={
                  staleStatusContradiction ? 'No stale leases with that status' : 'No stale leases'
                }
                body={
                  staleStatusContradiction
                    ? 'A stale claim is a RUNNING job whose lease has lapsed, so filtering the stale set by another status can never match. Clear the status filter to see the claims waiting to be released.'
                    : 'Every claimed job is inside its lease. Releasing a stale claim is only needed when an agent died mid-job, so this being empty is the healthy state.'
                }
                action={
                  <a className="nx-btn nx-btn--secondary" href={basePath}>
                    Show the whole queue
                  </a>
                }
              />
            ) : filtered ? (
              <EmptyState
                title="No jobs match these filters"
                body="No job in this business has that status and type. Widen the filters to see the queue."
                action={
                  <a className="nx-btn nx-btn--secondary" href={basePath}>
                    Reset filters
                  </a>
                }
              />
            ) : (
              <EmptyState
                title="No agent jobs yet"
                body="Jobs are created automatically when a lead needs company research, signals or an AI context pack, and by an agent through nexus.create_agent_job. An operator can also create one by hand below."
                action={
                  canManageJobs ? undefined : (
                    <span className="nx-hint">
                      Creating a job needs the queue capability, which this account does not hold
                      in this business.
                    </span>
                  )
                }
              />
            )
          }
        />

        <div className="nx-card__footer">
          <span className="nx-hint">
            {total === 0
              ? 'No jobs to page through'
              : `Showing ${String(offset + 1)}–${String(
                  offset + jobPage.jobs.length,
                )} of ${String(total)} · page ${String(page)} of ${String(totalPages)} · ${String(
                  pageSize,
                )} per page`}
          </span>
          <Row>
            {[10, 25, 50, 100].map((size) => (
              <a
                key={size}
                className="nx-btn nx-btn--ghost nx-btn--sm"
                href={filterHref(basePath, query, { set: { [PAGE_SIZE_PARAM]: String(size) } })}
                aria-current={size === pageSize ? 'true' : undefined}
              >
                {String(size)}/page
              </a>
            ))}
            {page > 1 && (
              <a
                className="nx-btn nx-btn--secondary nx-btn--sm"
                href={pageHref(basePath, query, page - 1)}
              >
                Previous
              </a>
            )}
            {page < totalPages && (
              <a
                className="nx-btn nx-btn--secondary nx-btn--sm"
                href={pageHref(basePath, query, page + 1)}
              >
                Next
              </a>
            )}
          </Row>
        </div>
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid split>
        <Card title="How a job flows">
          <Stack size="sm">
            <span>
              <strong>OPEN → RUNNING</strong> — an agent whose declared capabilities are a
              superset of the job&rsquo;s claims it and starts a lease.
            </span>
            <span>
              <strong>RUNNING → WAITING AI</strong> — the agent submits evidence, which is
              hashed and staged; the job then waits for extraction.
            </span>
            <span>
              <strong>WAITING AI → COMPLETE</strong> — extraction, validation, the structured
              commit and raw deletion, in that order. Only the processor may perform it.
            </span>
            <span className="nx-hint">
              A lease that lapses returns the job to OPEN, or fails it once no attempts remain.
            </span>
          </Stack>
        </Card>

        <Card title="Create a job">
          <CreateAgentJobForm
            action={createAgentJobAction}
            businessId={business.id}
            businessSlug={business.key}
            canCreate={canManageJobs}
            leads={leadPage.items.map((lead) => ({
              value: lead.id,
              label:
                lead.companyName === null
                  ? lead.personName
                  : `${lead.personName} · ${lead.companyName}`,
            }))}
          />
        </Card>
      </Grid>
    </>
  );
}

/* ------------------------------------------------------- dependent reads -- */

interface EventNote {
  readonly eventType: string;
  readonly note: string | null;
}

/**
 * The newest event per job, for the rows on this page.
 *
 * `agent_job_events` is append-only, so "newest" is the whole history this needs. Two jobs in
 * one statement, via `distinct on` — not two queries.
 */
async function lastEventNotes(
  actor: Actor,
  jobIds: readonly string[],
): Promise<ReadonlyMap<string, EventNote>> {
  if (jobIds.length === 0) return new Map();

  const rows = await withActor(actor, async (sql) =>
    sql.query<{ job_id: string; event_type: string; note: string | null }>(
      `select distinct on (job_id) job_id, event_type, note
         from public.agent_job_events
        where job_id = any($1::uuid[])
        order by job_id, created_at desc`,
      [[...jobIds]],
    ),
  );

  const notes = new Map<string, EventNote>();
  for (const row of rows.rows) {
    notes.set(String(row.job_id), { eventType: row.event_type, note: row.note });
  }
  return notes;
}

/**
 * `DONE TODAY`: COMPLETE jobs whose `completed_at` falls on today's date.
 *
 * Read directly here because it is not one of the repository's aggregates, and it is the
 * definition §70.2 gives — a job completed since midnight in the database's own day, not a
 * rolling 24 hours. A repository wrapper should replace this read; until then the SQL is a
 * parameterised count and nothing is fabricated.
 */
async function completedToday(actor: Actor, businessId: string): Promise<number> {
  const rows = await withActor(actor, async (sql) =>
    sql.query<{ n: number }>(
      `select count(*)::int as n
         from public.agent_jobs
        where business_id = $1
          and status = 'COMPLETE'
          and completed_at >= current_date`,
      [businessId],
    ),
  );
  return asNumber(rows.rows[0]?.n, 0);
}

/**
 * How many claims the reaper would release in this business.
 *
 * The reaper's own predicate — a RUNNING job whose lease has lapsed — so the count on the
 * button and the set the button actually returns to the queue cannot disagree.
 */
async function staleClaimCount(actor: Actor, businessId: string): Promise<number> {
  const rows = await withActor(actor, async (sql) =>
    sql.query<{ n: number }>(
      `select count(*)::int as n
         from public.agent_jobs
        where business_id = $1
          and status = 'RUNNING'
          and lease_expires_at is not null
          and lease_expires_at < now()`,
      [businessId],
    ),
  );
  return asNumber(rows.rows[0]?.n, 0);
}

/**
 * The "only stale leases" page of the queue.
 *
 * `listAgentJobs` in the repository has no stale-lease filter, and filtering the *page* it
 * returned would make the visible rows disagree with the total and the pager — exactly the
 * defect §70's "every job is reachable" rules out. So this is the same projection with the
 * reaper's predicate added, bounded and paged in SQL. It should be deleted the moment
 * `listAgentJobs` accepts a `staleOnly` parameter.
 */
async function listStaleAgentJobs(
  viewer: Viewer,
  params: {
    readonly businessId: string;
    readonly status: AgentJobStatus | null;
    readonly jobType: AgentJobType | null;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<{ jobs: readonly AgentJobRecord[]; total: number }> {
  const rows = await withActor(viewer.actor, async (sql) =>
    sql.query<StaleJobRow>(
      `select q.*, count(*) over () as total_count
         from (
           select j.id, j.business_id, j.lead_id, j.person_id, j.company_id, j.job_type,
                  j.priority, j.status, j.instructions, j.required_capabilities,
                  j.created_by_type, j.claimed_by_agent, j.claimed_at, j.lease_expires_at,
                  j.last_heartbeat_at, j.attempt_count, j.max_attempts, j.last_error_code,
                  j.dedupe_key, j.reason, j.created_at, j.updated_at, j.completed_at,
                  coalesce(p.full_name, c.name) as entity_label
             from public.agent_jobs j
             left join public.leads l on l.id = j.lead_id
             left join public.people p on p.id = coalesce(j.person_id, l.person_id)
             left join public.companies c on c.id = coalesce(j.company_id, l.company_id)
            where j.business_id = $1
              and j.status = 'RUNNING'
              and j.lease_expires_at is not null
              and j.lease_expires_at < now()
              -- The status filter is honoured even though a stale claim is always RUNNING, so
              -- "stale + Complete" returns nothing and the empty state can say why, rather
              -- than quietly ignoring the filter the operator set.
              and ($2::text is null or j.status = $2)
              and ($3::text is null or j.job_type = $3)
            order by
              case j.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
              j.lease_expires_at,
              j.created_at desc
            limit $4 offset $5
         ) q`,
      [params.businessId, params.status, params.jobType, params.limit, params.offset],
    ),
  );

  const jobs = rows.rows.map((row) => toJobRecord(row));
  return { jobs, total: asNumber(rows.rows[0]?.total_count, jobs.length) };
}

/**
 * The row shape of the stale-lease read.
 *
 * Declared as a type alias rather than an interface on purpose: `SqlExecutor.query<T extends
 * Row>` constrains `T` to `Record<string, unknown>`, and a named *interface* does not get the
 * implicit index signature that an object type literal does — an interface here would not
 * compile. The same reason every repository in the app writes its row type inline.
 */
type StaleJobRow = {
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
  entity_label: string | null;
  total_count: number;
};

/**
 * The repository's `mapJob`, restated for the stale-lease read above.
 *
 * Every field `AgentJobRecord` declares is mapped, so the two reads cannot silently drift into
 * different shapes — a divergence would surface as a missing column on one filter and not the
 * other, which is the sort of defect a screen like this hides well.
 */
function toJobRecord(row: StaleJobRow): AgentJobRecord {
  const known = (value: string, allowed: readonly string[], fallback: string): string =>
    allowed.includes(value) ? value : fallback;

  return {
    id: String(row.id),
    businessId: String(row.business_id),
    leadId: row.lead_id === null ? null : String(row.lead_id),
    personId: row.person_id === null ? null : String(row.person_id),
    companyId: row.company_id === null ? null : String(row.company_id),
    jobType: known(row.job_type, AGENT_JOB_TYPES, 'OTHER') as AgentJobType,
    priority: known(row.priority, AGENT_JOB_PRIORITIES, 'normal') as AgentJobPriority,
    status: known(row.status, AGENT_JOB_STATUSES, 'OPEN') as AgentJobStatus,
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
    entityLabel: row.entity_label,
  };
}
