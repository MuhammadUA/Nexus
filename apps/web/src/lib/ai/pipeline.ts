/**
 * The AI processor: one bounded, idempotent pass over the work that needs a model.
 *
 * The order is fixed and each step is bounded:
 *
 *   1. reap expired agent leases — no job stays `RUNNING` because an agent died;
 *   2. sweep the raw TTL — an abandoned body lives at most one interval past expiry;
 *   3. claim a bounded batch of `WAITING_AI` work (lease-guarded and skip-locked, so
 *      two processors never extract the same evidence);
 *   4. process each claimed job in its own right: extract, validate, commit,
 *      verify, **delete the raw row**, then complete the job;
 *   5. continue the chain from the facts that now exist.
 *
 * Two properties are what make it safe to call repeatedly — which is exactly what a
 * Vercel Cron target has to be:
 *
 *   * **a failure on one job never aborts the batch.** Each job is isolated, and a
 *     cleanup failure is recorded as an error code rather than raised (§34.3).
 *   * **a job with no staged evidence is failed with a typed code and never reaches
 *     a provider.** There is nothing to extract, and paying for a call to find that
 *     out would be the wrong way round.
 */
import 'server-only';

import { withActor, type Viewer } from '../actor';
import { asIso } from '../repo/common';
import { getOrBuildContextPack } from './context-pack';
import { commitCompanyResearch } from './extract';
import { cleanupExpiredRaw } from '../repo/raw-staging';
import { chainJobsForLead, completeAgentJob, failAgentJob, reapExpiredLeases } from '../repo/agent-jobs';
import type { AiProvider } from './types';

export interface ProcessorReport {
  readonly reapedLeases: number;
  readonly cleanedRaw: number;
  readonly jobsClaimed: number;
  readonly jobsCompleted: number;
  readonly jobsFailed: number;
  readonly rawDeleted: number;
  readonly errors: readonly string[];
}

type ClaimedJob = {
  job_id: string;
  business_id: string;
  job_type: string;
  lead_id: string | null;
  person_id: string | null;
  company_id: string | null;
  attempt_count: number;
  lease_expires_at: unknown;
}

export interface ProcessAiQueueOptions {
  /** Null or absent means "every business this actor may sweep". */
  readonly businessId?: string | null;
  readonly limit?: number;
  readonly provider?: AiProvider;
  /**
   * The run's reference instant, used to prefix error entries so a log of several
   * runs is ordered. The database clock stays authoritative for leases and TTL:
   * a caller-supplied time must never decide whether a lease has expired.
   */
  readonly now?: Date;
}

/** Job types this processor can actually finish. */
const COMPANY_PROCESSOR_TYPES: ReadonlySet<string> = new Set([
  'RESEARCH_COMPANY',
  'RESEARCH_SIGNALS',
  'RESEARCH_PERSON',
]);

export async function processAiQueue(
  viewer: Viewer,
  options: ProcessAiQueueOptions = {},
): Promise<ProcessorReport> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 5), 25));
  const businessId = options.businessId ?? null;
  const errors: string[] = [];

  const report = {
    reapedLeases: 0,
    cleanedRaw: 0,
    jobsClaimed: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    rawDeleted: 0,
  };

  // ---- 1. expired leases ----------------------------------------------------
  try {
    report.reapedLeases = await reapExpiredLeases(viewer);
  } catch {
    errors.push(`${now.toISOString()} reap_expired_leases_failed`);
  }

  // ---- 2. raw TTL sweep ----------------------------------------------------
  try {
    report.cleanedRaw = await cleanupExpiredRaw(viewer, 200);
  } catch {
    // Cleanup never fails the processor: it is housekeeping, and a job path that
    // aborts because a sweep failed would lose work for no reason.
    errors.push(`${now.toISOString()} raw_cleanup_failed`);
  }

  // ---- 3. claim a bounded batch -------------------------------------------
  let claimed: readonly ClaimedJob[] = [];
  try {
    claimed = await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<ClaimedJob>(
        `select job_id, business_id, job_type, lead_id, person_id, company_id,
                attempt_count, lease_expires_at
           from public.nexus_claim_ai_work($1, $2, 600)`,
        [limit, businessId],
      );
      return result.rows;
    });
  } catch {
    errors.push(`${now.toISOString()} claim_ai_work_failed`);
    return { ...report, errors };
  }
  report.jobsClaimed = claimed.length;

  // ---- 4. process each job -------------------------------------------------
  for (const job of claimed) {
    const jobId = String(job.job_id);
    const jobBusinessId = String(job.business_id);
    const jobType = job.job_type;

    try {
      if (COMPANY_PROCESSOR_TYPES.has(jobType)) {
        const outcome = await commitCompanyResearch(viewer, {
          jobId,
          agent: 'ai_processor',
          // Deliberately empty: the job is already `WAITING_AI`, so the staged row
          // is the authoritative body and this value is ignored. Passing anything
          // else would invite a body to come from somewhere other than staging.
          payload: '',
          provider: options.provider,
        });

        if (outcome.ok) {
          report.jobsCompleted += 1;
          if (outcome.rawDeleted) report.rawDeleted += 1;
          // ---- 5. continue the chain from the facts that now exist -----------
          if (job.lead_id !== null) {
            await chainJobsForLead(viewer, { businessId: jobBusinessId, leadId: String(job.lead_id) });
          }
        } else {
          report.jobsFailed += 1;
          errors.push(`${now.toISOString()} ${jobType} ${outcome.errorCode}`);
        }
        continue;
      }

      if (jobType === 'BUILD_CONTEXT' && job.lead_id !== null) {
        const built = await getOrBuildContextPack(viewer, String(job.lead_id), {
          provider: options.provider,
        });
        if (!built.ok) {
          report.jobsFailed += 1;
          errors.push(`${now.toISOString()} BUILD_CONTEXT context_build_failed`);
          continue;
        }
        await completeAgentJob(viewer, { jobId });
        report.jobsCompleted += 1;
        continue;
      }

      // A type with no processor should not have reached `WAITING_AI`. Failing it
      // makes the gap visible in the queue instead of leaving it to be re-claimed
      // on every pass forever.
      await failAgentJob(viewer, {
        jobId,
        agent: 'ai_processor',
        errorCode: 'no_processor_for_job_type',
        retryable: false,
      });
      report.jobsFailed += 1;
      errors.push(`${now.toISOString()} ${jobType} no_processor_for_job_type`);
    } catch (error) {
      // One job's failure is never the batch's failure.
      report.jobsFailed += 1;
      errors.push(
        `${now.toISOString()} ${jobType} processor_error ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  return { ...report, errors };
}

/**
 * The staged raw ids currently leased to the processor, for an operator view.
 *
 * Metadata only, and deliberately not the payload: there is no read path in the
 * product that returns a staged body (spec §32.5, §43.3).
 */
export async function listProcessorLeases(
  viewer: Viewer,
  limit = 50,
): Promise<readonly { jobId: string; businessId: string; jobType: string; leaseExpiresAt: string | null }[]> {
  return withActor(viewer.actor, async (sql) => {
    const result = await sql.query<{
      id: string;
      business_id: string;
      job_type: string;
      lease_expires_at: unknown;
    }>(
      `select id, business_id, job_type, lease_expires_at
         from public.agent_jobs
        where status = 'WAITING_AI' and claimed_by_agent = 'ai_processor'
        order by lease_expires_at nulls first
        limit $1`,
      [Math.max(1, Math.trunc(limit))],
    );
    return result.rows.map((row) => ({
      jobId: String(row.id),
      businessId: String(row.business_id),
      jobType: row.job_type,
      leaseExpiresAt: asIso(row.lease_expires_at),
    }));
  });
}
