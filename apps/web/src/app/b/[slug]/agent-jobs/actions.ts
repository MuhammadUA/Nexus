'use server';

/**
 * Server actions for the Agent Jobs screen (spec §70).
 *
 * Two actions, both independently authorized: a Server Action is a public HTTP endpoint
 * once it has been rendered anywhere, so it repeats its page's requirement and then the
 * queue's own capability before touching a row. `authorizeAction` answers "may this person
 * open the screen"; the capability check answers "may this person change the queue"; and
 * the database's `SECURITY DEFINER` functions assert both again, because RLS is the real
 * boundary and these two are what turn a refusal into a sentence.
 *
 * ---------------------------------------------------------------------------
 * THERE IS DELIBERATELY NO `complete` OPERATION IN THIS FILE.
 *
 * `agent_jobs` has a SELECT policy and no UPDATE policy at all, so no code here — and no
 * forged request — can set a status directly. The only path to `COMPLETE` is
 * `nexus_complete_agent_job`, which the extraction pipeline calls after extraction,
 * validation, the structured commit and raw deletion (§41.3), and which refuses while an
 * un-consumed staging row still exists. A "mark complete" action is therefore not omitted
 * for now; it is impossible by construction, and this comment is where a reader looking for
 * one will find the reason instead.
 * ---------------------------------------------------------------------------
 */
import { revalidatePath } from 'next/cache';
import {
  AGENT_JOB_PRIORITIES,
  AGENT_JOB_TYPES,
  routePermissionsFor,
  type AgentJobStatus,
} from '@nexus/core';
import { z } from 'zod';

import { withActor, type Viewer } from '@/lib/actor';
import { formString, formStringOrNull } from '@/lib/form-data';
import { cancelAgentJob, createAgentJob, getAgentJob, reapExpiredLeases } from '@/lib/repo/agent-jobs';
import { describeDbError } from '@/lib/repo/common';
import { authorizeAction } from '@/lib/route-guard';
import { loadViewerContext, type ViewerContext } from '@/lib/viewer-context';

export interface AgentJobActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const REFUSED: AgentJobActionResult = {
  ok: false,
  error: 'You do not have permission to change the agent job queue.',
};

/**
 * The route pattern this screen is judged against.
 *
 * `packages/core` owns the route → permission matrix and is being extended by the agent that
 * owns that package; `/b/:businessSlug/agent-jobs` is not in it yet. The guard fails closed on
 * a route it has no entry for — which is the correct behaviour, and would make this screen
 * unreachable — so until that entry lands the screen is judged by the requirement of the
 * section it lives in (§70.1 places Agent Jobs under Integrations / Automation).
 * `routePermissionsFor` is consulted first, so the moment the matrix gains the entry this
 * screen follows it with no change here. See the delivery report for the open item.
 */
const AGENT_JOBS_ROUTE: string =
  routePermissionsFor('/b/:businessSlug/agent-jobs') === null
    ? '/b/:businessSlug/automations'
    : '/b/:businessSlug/agent-jobs';

const uuid = z.string().uuid();
const slugSchema = z.string().trim().min(1).max(120);
const operationSchema = z.enum(['retry', 'cancel', 'release']);

const createSchema = z.object({
  businessId: uuid,
  businessSlug: slugSchema,
  jobType: z.enum(AGENT_JOB_TYPES),
  priority: z.enum(AGENT_JOB_PRIORITIES),
  leadId: z.union([uuid, z.literal('')]).nullish(),
  instructions: z.string().trim().max(2000).nullish(),
});

/**
 * The queue mutation capability, mirroring `public.nexus_job_scope_ok`.
 *
 * Admin, or a grant in *this* business that may manage leads — the same rule the database
 * applies. Kept beside the guard so the screen's controls and the actions behind them cannot
 * disagree about who may act.
 */
function canManageJobs(context: ViewerContext, businessId: string): boolean {
  if (context.viewer.role === 'admin') return true;
  return context.grants.some((grant) => grant.businessId === businessId && grant.canManageLeads);
}

/** An action refuses a business id that is not a uuid before it reaches the database. */
function businessIdOf(formData: FormData): string | null {
  const parsed = uuid.safeParse(formString(formData, 'businessId', ''));
  return parsed.success ? parsed.data : null;
}

/** `RESEARCH_COMPANY` and friends; anything else is not a job type this screen can create. */
export async function createAgentJobAction(
  _previous: AgentJobActionResult,
  formData: FormData,
): Promise<AgentJobActionResult> {
  const businessId = businessIdOf(formData);
  if (businessId === null) return { ok: false, error: 'That business could not be identified.' };

  const context = await loadViewerContext();
  const refusal = await authorizeAction(context, { route: AGENT_JOBS_ROUTE, businessId });
  if (refusal !== null) return refusal;
  if (!canManageJobs(context, businessId)) return REFUSED;

  const parsed = createSchema.safeParse({
    businessId,
    businessSlug: formString(formData, 'businessSlug', ''),
    jobType: formString(formData, 'jobType', 'OTHER'),
    priority: formString(formData, 'priority', 'normal'),
    leadId: formStringOrNull(formData, 'leadId'),
    instructions: formStringOrNull(formData, 'instructions'),
  });
  if (!parsed.success) {
    return { ok: false, error: 'Choose a job type and a priority; instructions are optional.' };
  }

  const leadId = parsed.data.leadId ?? null;

  try {
    const result = await createAgentJob(context.viewer, {
      businessId: parsed.data.businessId,
      jobType: parsed.data.jobType,
      priority: parsed.data.priority,
      leadId: leadId === '' ? null : leadId,
      instructions: parsed.data.instructions ?? null,
      dedupeKey: null,
      // Recorded on the row so a hand-made job is distinguishable from a chained one
      // (§70.6). The chained path states its own reason.
      reason: 'Created by an operator from the Agent Jobs screen.',
    });

    revalidatePath(`/b/${parsed.data.businessSlug}/agent-jobs`);

    return {
      ok: true,
      error: null,
      // `created: false` is a success: the requested state already held, because an
      // active job with this dedupe key was already in the queue.
      message: result.created
        ? 'Job created.'
        : 'An identical job is already in the queue; it was not duplicated.',
    };
  } catch (error) {
    return { ok: false, error: describeDbError(error, 'createAgentJobAction') };
  }
}

/**
 * Retry / cancel / release, dispatched on the `operation` field.
 *
 * One action rather than three so the row controls, the header button and the server share a
 * single vocabulary for what an operation is — and so there is exactly one place to read when
 * asking whether a job can be forced into a state it has not earned. It cannot: the three
 * operations below are the whole set, and none of them reaches `COMPLETE`.
 */
export async function runAgentJobOperationAction(
  _previous: AgentJobActionResult,
  formData: FormData,
): Promise<AgentJobActionResult> {
  const businessId = businessIdOf(formData);
  if (businessId === null) return { ok: false, error: 'That business could not be identified.' };

  const context = await loadViewerContext();
  const refusal = await authorizeAction(context, { route: AGENT_JOBS_ROUTE, businessId });
  if (refusal !== null) return refusal;
  if (!canManageJobs(context, businessId)) return REFUSED;

  const operation = operationSchema.safeParse(formString(formData, 'operation', ''));
  if (!operation.success) {
    return { ok: false, error: 'That operation is not available on an agent job.' };
  }

  const slug = slugSchema.safeParse(formString(formData, 'businessSlug', ''));
  const viewer = context.viewer;

  if (operation.data === 'release') {
    // The reaping path (§40). It returns a job whose lease lapsed to OPEN — or to FAILED
    // when no attempts remain — and writes a `lease_expired` event. It cannot complete a job.
    //
    // Scope note: `nexus_reap_expired_job_leases` takes no business filter, so it sweeps the
    // deployment and the count below is therefore the number released in total — which can
    // exceed the number this business had stale (the label on the button). The caller still has
    // to be an operator of the named business to get this far, and reaping is a repair rather
    // than a read, so nothing is disclosed either way. A business-scoped reaper belongs in the
    // repository wrapper, not in string-concatenated SQL here.
    try {
      const reaped = await reapExpiredLeases(viewer);
      if (slug.success) revalidatePath(`/b/${slug.data}/agent-jobs`);
      return {
        ok: true,
        error: null,
        message:
          reaped === 0
            ? 'No stale claims needed releasing.'
            : `${String(reaped)} stale claim${reaped === 1 ? '' : 's'} released back to the queue.`,
      };
    } catch (error) {
      return { ok: false, error: describeDbError(error, 'runAgentJobOperationAction:release') };
    }
  }

  const jobId = uuid.safeParse(formString(formData, 'jobId', ''));
  if (!jobId.success) return { ok: false, error: 'That job could not be identified.' };

  const job = await getAgentJob(viewer, jobId.data);
  if (job === null) return { ok: false, error: 'That job is no longer visible to you.' };
  // The row's own business decides, not the form's: a forged business id cannot move a job
  // out of the business the actor was authorized against.
  if (job.businessId !== businessId) {
    return { ok: false, error: 'That job is no longer visible to you.' };
  }

  if (operation.data === 'retry') {
    if (!retryable(job.status)) {
      return { ok: false, error: 'Only a failed or cancelled job can be retried.' };
    }
    try {
      await retryAgentJob(viewer, job.id, 'Retried by an operator from the Agent Jobs screen.');
      if (slug.success) revalidatePath(`/b/${slug.data}/agent-jobs`);
      return { ok: true, error: null, message: 'Job returned to the queue.' };
    } catch (error) {
      return { ok: false, error: describeDbError(error, 'runAgentJobOperationAction:retry') };
    }
  }

  // `cancel`
  if (job.status === 'COMPLETE') {
    return { ok: false, error: 'A completed job cannot be cancelled.' };
  }
  if (job.status === 'CANCELLED') {
    return { ok: false, error: 'That job is already cancelled.' };
  }

  try {
    await cancelAgentJob(viewer, job.id, 'Cancelled by an operator from the Agent Jobs screen.');
    if (slug.success) revalidatePath(`/b/${slug.data}/agent-jobs`);
    return { ok: true, error: null, message: 'Job cancelled.' };
  } catch (error) {
    return { ok: false, error: describeDbError(error, 'runAgentJobOperationAction:cancel') };
  }
}

/**
 * The two states an operator may put back on the queue.
 *
 * `nexus_retry_agent_job` refuses anything else with a `55006`, so this is a sentence rather
 * than the boundary; it exists so the common case does not need a caught database error.
 */
function retryable(status: AgentJobStatus): boolean {
  return status === 'FAILED' || status === 'CANCELLED';
}

/**
 * `public.nexus_retry_agent_job(job_id, reason)`.
 *
 * The repository module does not export a wrapper for this function yet, so it is called here
 * as a parameterised statement through `withActor`: the id and the reason are bound
 * parameters, never interpolated into SQL. When `retryAgentJob(viewer, jobId, reason?)` lands
 * in `@/lib/repo/agent-jobs`, this helper should be deleted and the call above pointed at it —
 * the function is `SECURITY DEFINER` and asserts the queue capability itself, so moving the
 * call changes nothing about who may retry.
 */
async function retryAgentJob(viewer: Viewer, jobId: string, reason: string): Promise<void> {
  await withActor(viewer.actor, async (sql) => {
    await sql.query(
      `select id, status, attempt_count from public.nexus_retry_agent_job($1, $2)`,
      [jobId, reason],
    );
  });
}

