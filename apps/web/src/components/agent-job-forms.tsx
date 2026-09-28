'use client';

/**
 * Presentation and controls for the Agent Jobs screen (spec §70).
 *
 * Why the mapping lives here rather than in the page: a non-component export of a
 * `'use client'` module cannot be *called* from a Server Component — it may only be rendered
 * as a component or passed as a prop. So every fact that needs a decision (status → accent,
 * lease → live/expired, instant → text) is exposed as a small presentational component, and
 * the page keeps the column list, the reads and the guards. There is therefore exactly one
 * definition of "what FAILED looks like" and one of "when is a lease expired", which is what
 * stops the summary strip, the table and the row controls from drifting apart.
 *
 * Two properties this module is responsible for:
 *
 *   1. **There is no `complete` operation, and there cannot be one.** The operation list is a
 *      closed union (`JobRowOperation`), `rowOperationsFor` is the only producer of it, and
 *      `actions.ts` refuses anything outside it. A job reaches `COMPLETE` only through the
 *      extraction pipeline's verified commit (§41.3); `agent_jobs` has no UPDATE policy at
 *      all, so this is the absence of a path rather than the absence of a button.
 *   2. **Status is never carried by colour alone** (§75.2): every chip renders a word.
 */
import { useActionState, type ReactElement } from 'react';

import {
  AGENT_JOB_PRIORITIES,
  AGENT_JOB_STATUSES,
  AGENT_JOB_TYPES,
  type AgentJobPriority,
  type AgentJobStatus,
  type AgentJobType,
} from '@nexus/core';
import { Alert, Button, Chip, Field, Select, Stack, TextArea, type AccentName } from '@nexus/ui';

import type { AgentJobActionResult } from '@/app/b/[slug]/agent-jobs/actions';

/* ------------------------------------------------------------- helpers --- */

/**
 * The operations an operator may perform on a job row.
 *
 * Deliberately closed and deliberately short. `complete` is not a member, and no status maps
 * onto it: see the module comment above and `rowOperationsFor` below.
 */
export const JOB_ROW_OPERATIONS = ['retry', 'cancel', 'release'] as const;
export type JobRowOperation = (typeof JOB_ROW_OPERATIONS)[number];

const STATUS_LABELS: Readonly<Record<AgentJobStatus, string>> = {
  OPEN: 'Open',
  RUNNING: 'Running',
  WAITING_AI: 'Waiting AI',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/**
 * Status → accent, using only the published accent semantics.
 *
 * cyan = queued/new, indigo = in flight (structural emphasis), amber = waiting on something,
 * green = done, red = needs attention, neutral = terminal and quiet.
 */
const STATUS_ACCENTS: Readonly<Record<AgentJobStatus, AccentName>> = {
  OPEN: 'cyan',
  RUNNING: 'indigo',
  WAITING_AI: 'amber',
  COMPLETE: 'green',
  FAILED: 'red',
  CANCELLED: 'neutral',
};

export function jobStatusLabel(status: AgentJobStatus): string {
  return STATUS_LABELS[status];
}

export function jobStatusAccent(status: AgentJobStatus): AccentName {
  return STATUS_ACCENTS[status];
}

/** Priority → accent. `low`/`normal` stay neutral so urgency keeps its meaning. */
export function jobPriorityAccent(priority: AgentJobPriority): AccentName {
  switch (priority) {
    case 'urgent':
      return 'red';
    case 'high':
      return 'amber';
    default:
      return 'neutral';
  }
}

/** `RESEARCH_COMPANY` → `Research company`, so the table reads as prose. */
export function humaniseJobType(jobType: AgentJobType): string {
  const lower = jobType.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** A retry is offered only for the two terminal-but-recoverable states. */
export function canRetry(status: AgentJobStatus): boolean {
  return status === 'FAILED' || status === 'CANCELLED';
}

/** Cancelling is offered while the job still has work ahead of it. */
export function canCancel(status: AgentJobStatus): boolean {
  return status === 'OPEN' || status === 'RUNNING' || status === 'WAITING_AI';
}

/**
 * The operations this row offers, in display order.
 *
 * Note what cannot be returned: `complete`. A terminal job offers retry and nothing else, and
 * a successful job offers no operation at all.
 */
export function rowOperationsFor(
  status: AgentJobStatus,
  leaseExpired: boolean,
): readonly JobRowOperation[] {
  const offered: JobRowOperation[] = [];
  if (canRetry(status)) offered.push('retry');
  // A stale claim is only meaningful on a claimed job: releasing a job whose lease has not
  // lapsed would take work away from an agent that is still working.
  if (leaseExpired && status === 'RUNNING') offered.push('release');
  if (canCancel(status)) offered.push('cancel');
  return offered;
}

/** Lease state as a closed union: absent, live, or lapsed. */
export function leaseState(
  leaseExpiresAt: string | null,
  now: Date,
): 'none' | 'live' | 'expired' {
  if (leaseExpiresAt === null || leaseExpiresAt.length === 0) return 'none';
  const expires = new Date(leaseExpiresAt);
  if (Number.isNaN(expires.getTime())) return 'none';
  return expires.getTime() <= now.getTime() ? 'expired' : 'live';
}

/** `10m` / `2h 5m` / `3d 4h` — coarse on purpose: a lease is minutes, not seconds. */
export function minutesLabel(minutes: number): string {
  const whole = Math.max(Math.floor(Math.abs(minutes)), 0);
  if (whole < 60) return `${String(whole)}m`;
  const hours = Math.floor(whole / 60);
  if (hours < 24) return `${String(hours)}h ${String(whole % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

/** The lease's detail text. Never a colour-only signal: it states the state in words. */
export function leaseDetail(leaseExpiresAt: string | null, now: Date): string {
  const state = leaseState(leaseExpiresAt, now);
  if (state === 'none' || leaseExpiresAt === null) return 'no lease';
  const deltaMinutes = (new Date(leaseExpiresAt).getTime() - now.getTime()) / 60_000;
  return state === 'expired'
    ? `expired ${minutesLabel(deltaMinutes)} ago`
    : `expires in ${minutesLabel(deltaMinutes)}`;
}

/** `2026-02-03T09:41:07.000Z` → `2026-02-03 09:41`, matching the other screens. */
export function shortTimestamp(value: string | null): string {
  if (value === null || value.length === 0) return '—';
  return value.slice(0, 16).replace('T', ' ');
}

/* ------------------------------------------------------ cell components -- */

export function JobPriorityChip({ priority }: { readonly priority: AgentJobPriority }): ReactElement {
  return (
    <Chip accent={jobPriorityAccent(priority)} dataState={priority}>
      {priority}
    </Chip>
  );
}

export function JobTypeChip({ jobType }: { readonly jobType: AgentJobType }): ReactElement {
  return (
    <span title={jobType}>
      <Chip accent="indigo">{humaniseJobType(jobType)}</Chip>
    </span>
  );
}

/**
 * Status, the typed failure code, and the newest event's note (§70.5).
 *
 * A failed job shows `last_error_code` and what last happened to it — never a raw upstream
 * message, which the ledger and the event log do not store either.
 */
export function JobStatusCell({
  status,
  lastErrorCode,
  eventType,
  note,
}: {
  readonly status: AgentJobStatus;
  readonly lastErrorCode: string | null;
  readonly eventType: string | null;
  readonly note: string | null;
}): ReactElement {
  return (
    <div className="nx-stack nx-stack--sm">
      <div className="nx-row nx-row--wrap">
        <Chip accent={jobStatusAccent(status)} dataState={status}>
          {jobStatusLabel(status)}
        </Chip>
        {status === 'FAILED' && lastErrorCode !== null && (
          <Chip accent="red" dataState={lastErrorCode}>
            {lastErrorCode}
          </Chip>
        )}
      </div>
      {eventType !== null && (
        <span className="nx-hint">
          {note === null ? eventType : `${eventType} · ${note}`}
        </span>
      )}
    </div>
  );
}

/**
 * The lease, with an explicit *expired* state (§70.3).
 *
 * `nowIso` is supplied by the server so the first paint and the hydrated render agree; a
 * client-side `new Date()` here would produce two different strings for the same row.
 */
export function LeaseCell({
  leaseExpiresAt,
  nowIso,
}: {
  readonly leaseExpiresAt: string | null;
  readonly nowIso: string;
}): ReactElement {
  const now = new Date(nowIso);
  const state = leaseState(leaseExpiresAt, now);
  return (
    <div className="nx-stack nx-stack--sm">
      <span className="nx-table__mono">{shortTimestamp(leaseExpiresAt)}</span>
      {state === 'expired' ? (
        <Chip accent="red" dataState="expired">
          {leaseDetail(leaseExpiresAt, now)}
        </Chip>
      ) : (
        <span className="nx-hint">{leaseDetail(leaseExpiresAt, now)}</span>
      )}
    </div>
  );
}

export function TimestampText({ value }: { readonly value: string | null }): ReactElement {
  return <span className="nx-table__mono">{shortTimestamp(value)}</span>;
}

/** `3 / 3` — read as an attempt budget, not as a fraction to be computed. */
export function AttemptsText({
  attemptCount,
  maxAttempts,
}: {
  readonly attemptCount: number;
  readonly maxAttempts: number;
}): ReactElement {
  return (
    <span className="nx-table__mono">{`${String(attemptCount)} / ${String(maxAttempts)}`}</span>
  );
}

/* --------------------------------------------------------------- forms --- */

const IDLE: AgentJobActionResult = { ok: false, error: null };

/** The outcome of a form post, announced inline rather than silently swallowed. */
function Outcome({ state }: { readonly state: AgentJobActionResult }): ReactElement | null {
  if (state.error !== null) {
    return (
      <Alert accent="red" role="alert">
        {state.error}
      </Alert>
    );
  }
  if (state.message !== undefined) {
    return (
      <Alert accent={state.ok ? 'green' : 'amber'} role="status">
        {state.message}
      </Alert>
    );
  }
  return null;
}

export interface AgentJobLeadOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Create a job by hand.
 *
 * A hand-made job is the exception — most jobs are chained from a lead's stored facts — so the
 * form asks for the minimum the database needs and lets the operator attach a lead when the
 * work is about one person.
 */
export function CreateAgentJobForm({
  action,
  businessId,
  businessSlug,
  leads,
  canCreate,
}: {
  readonly action: (
    previous: AgentJobActionResult,
    formData: FormData,
  ) => Promise<AgentJobActionResult>;
  readonly businessId: string;
  readonly businessSlug: string;
  readonly leads: readonly AgentJobLeadOption[];
  readonly canCreate: boolean;
}): ReactElement {
  const [state, formAction, pending] = useActionState(action, IDLE);

  if (!canCreate) {
    return (
      <p className="nx-hint">
        Creating a job needs the same capability the queue asserts for a mutation: an
        administrator, or a person who can manage leads in this business.
      </p>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <input type="hidden" name="operation" value="create" />
      <Stack size="sm">
        <Field label="Job type" htmlFor="job-type" required>
          <Select
            id="job-type"
            name="jobType"
            defaultValue="RESEARCH_COMPANY"
            options={AGENT_JOB_TYPES.map((value) => ({ value, label: humaniseJobType(value) }))}
          />
        </Field>

        <Field label="Priority" htmlFor="job-priority" required>
          <Select
            id="job-priority"
            name="priority"
            defaultValue="normal"
            options={AGENT_JOB_PRIORITIES.map((value) => ({ value, label: value }))}
          />
        </Field>

        <Field
          label="Lead"
          htmlFor="job-lead"
          hint="Optional. A job with no lead is queue work that is not about one person."
        >
          <Select
            id="job-lead"
            name="leadId"
            defaultValue=""
            placeholder="No lead"
            options={leads.map((lead) => ({ value: lead.value, label: lead.label }))}
          />
        </Field>

        <Field
          label="Instructions"
          htmlFor="job-instructions"
          hint="Short operator text for the agent. Never paste a raw profile or research body here: staged evidence has its own lifecycle, and a short note must not outlive it."
        >
          <TextArea id="job-instructions" name="instructions" defaultValue="" rows={3} />
        </Field>

        <Outcome state={state} />

        <Button type="submit" variant="primary" busy={pending}>
          Create job
        </Button>
      </Stack>
    </form>
  );
}

/**
 * The per-row operation controls.
 *
 * One shared action handles retry/cancel/release and dispatches on the `operation` field, so
 * the row controls, the header button and the server cannot disagree about what an operation
 * is called. The lease is judged here from the same helper the lease cell uses, which is why
 * "Release claim" appears exactly when the cell says *expired*.
 */
export function AgentJobRowActions({
  action,
  jobId,
  businessId,
  businessSlug,
  status,
  leaseExpiresAt,
  nowIso,
  leadHref,
  canAct,
}: {
  readonly action: (
    previous: AgentJobActionResult,
    formData: FormData,
  ) => Promise<AgentJobActionResult>;
  readonly jobId: string;
  readonly businessId: string;
  readonly businessSlug: string;
  readonly status: AgentJobStatus;
  readonly leaseExpiresAt: string | null;
  readonly nowIso: string;
  readonly leadHref: string | null;
  readonly canAct: boolean;
}): ReactElement {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const leaseExpired = leaseState(leaseExpiresAt, new Date(nowIso)) === 'expired';
  const operations = canAct ? rowOperationsFor(status, leaseExpired) : [];

  const label = (operation: JobRowOperation): string =>
    operation === 'retry' ? 'Retry' : operation === 'release' ? 'Release claim' : 'Cancel';

  return (
    <div className="nx-stack nx-stack--sm">
      {leadHref !== null && (
        <a className="nx-btn nx-btn--ghost nx-btn--sm" href={leadHref}>
          Open
        </a>
      )}

      {operations.map((operation) => (
        <form key={operation} action={formAction}>
          <input type="hidden" name="operation" value={operation} />
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="businessSlug" value={businessSlug} />
          <button
            className="nx-btn nx-btn--secondary nx-btn--sm"
            type="submit"
            disabled={pending}
            title={`${label(operation)} job ${jobId}`}
          >
            {label(operation)}
          </button>
        </form>
      ))}

      {state.error !== null && (
        <span className="nx-error" role="alert">
          {state.error}
        </span>
      )}
      {state.error === null && state.message !== undefined && (
        <span className="nx-hint" role="status">
          {state.message}
        </span>
      )}
    </div>
  );
}

/**
 * Release every stale claim in this business.
 *
 * This is the reaping path (§40): it returns a `RUNNING` job whose lease has lapsed to `OPEN`
 * — or to `FAILED` when no attempts remain — and writes a `lease_expired` event. It cannot
 * mark anything complete.
 */
export function ReleaseStaleClaimsForm({
  action,
  businessId,
  businessSlug,
  staleCount,
  canAct,
}: {
  readonly action: (
    previous: AgentJobActionResult,
    formData: FormData,
  ) => Promise<AgentJobActionResult>;
  readonly businessId: string;
  readonly businessSlug: string;
  readonly staleCount: number;
  readonly canAct: boolean;
}): ReactElement {
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="nx-stack nx-stack--sm">
      <input type="hidden" name="operation" value="release" />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="businessSlug" value={businessSlug} />
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        busy={pending}
        disabled={!canAct || staleCount === 0}
        title={
          canAct
            ? 'Return every job whose lease has lapsed to the queue'
            : 'Releasing a stale claim needs the queue mutation capability'
        }
      >
        {staleCount === 0
          ? 'No stale claims'
          : `Release ${String(staleCount)} stale claim${staleCount === 1 ? '' : 's'}`}
      </Button>
      {state.error !== null && (
        <span className="nx-error" role="alert">
          {state.error}
        </span>
      )}
      {state.error === null && state.message !== undefined && (
        <span className="nx-hint" role="status">
          {state.message}
        </span>
      )}
    </form>
  );
}

/**
 * The queue filters.
 *
 * A plain GET form: filters live in the URL, so a filtered queue is shareable and survives a
 * reload. The labels come from the same helpers the table uses, so the option an operator
 * picks and the chip they then see are the same word.
 */
export function AgentJobsFilterForm({
  basePath,
  current,
  pageSize,
}: {
  readonly basePath: string;
  readonly current: {
    readonly status: AgentJobStatus | null;
    readonly jobType: AgentJobType | null;
    readonly staleOnly: boolean;
  };
  readonly pageSize: number | null;
}): ReactElement {
  return (
    <form className="nx-row nx-row--wrap" action={basePath} method="get">
      {/*
        The row layout comes from the existing `nx-row` utilities rather than a new class: the
        filter bar must look like the other filter bars in the product, and `nx-inline-form`
        (used elsewhere for the same job) has no rule in the design system.
      */}
      {/* Only carry the page size when the URL set one, so the default stays out of the URL. */}
      {pageSize === null ? null : <input type="hidden" name="pageSize" value={String(pageSize)} />}

      <Field label="Status" htmlFor="jobs-status">
        <Select
          id="jobs-status"
          name="status"
          defaultValue={current.status ?? ''}
          placeholder="All statuses"
          options={AGENT_JOB_STATUSES.map((value) => ({ value, label: jobStatusLabel(value) }))}
        />
      </Field>

      <Field label="Job type" htmlFor="jobs-type">
        <Select
          id="jobs-type"
          name="jobType"
          defaultValue={current.jobType ?? ''}
          placeholder="All types"
          options={AGENT_JOB_TYPES.map((value) => ({ value, label: humaniseJobType(value) }))}
        />
      </Field>

      <Field
        label="Only stale leases"
        htmlFor="jobs-stale"
        hint="A stale claim is a RUNNING job whose lease has lapsed — exactly what the reaper returns to the queue."
      >
        <input
          id="jobs-stale"
          type="checkbox"
          name="stale"
          value="1"
          defaultChecked={current.staleOnly}
        />
      </Field>

      <div className="nx-row">
        <button className="nx-btn nx-btn--secondary" type="submit">
          Apply filters
        </button>
        <a className="nx-btn nx-btn--ghost" href={basePath}>
          Reset
        </a>
      </div>
    </form>
  );
}
