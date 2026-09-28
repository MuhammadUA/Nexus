/**
 * POST /api/v1/enrichment/company-job — ask for the company research this lead is
 * missing.
 *
 * Body: `{ lead_id }`.
 *
 * This is the *durable* request path (spec §35.2): it creates or reuses the chained
 * `RESEARCH_COMPANY` job rather than trying to research anything now. The plan comes
 * from the lead's stored facts (`planChainedJobs`), so calling it twice is a no-op
 * rather than a second copy of the same work, and the response says which of the two
 * happened for each job.
 */
import { z } from 'zod';

import { loadViewer, withActor } from '@/lib/actor';
import { requireScope, resolveCredential } from '@/lib/gateway';
import { chainJobsForLead } from '@/lib/repo/agent-jobs';

import { jsonError, jsonOk, parseBody } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const companyJobBodySchema = z.object({
  lead_id: z.string().uuid(),
});

export async function POST(request: Request): Promise<Response> {
  const credential = await resolveCredential(request.headers.get('authorization'));
  if (credential.kind === 'anonymous') return jsonError('Missing or invalid token.', 401);

  const parsed = await parseBody(request, companyJobBodySchema);
  if (!parsed.ok) return parsed.response;

  const businessId = await withActor(credential.actor, async (sql) => {
    const result = await sql.query<{ business_id: string }>(
      `select business_id from public.leads where id = $1 and deleted_at is null`,
      [parsed.data.lead_id],
    );
    return result.rows[0]?.business_id ?? null;
  });
  if (businessId === null) return jsonError('That lead could not be found.', 404, { reason: 'lead_not_visible' });

  // `jobs:create` is the same capability the database checks in
  // `nexus_job_scope_ok`, so the gate here and the gate there cannot disagree.
  const scope = requireScope(credential, 'jobs:create', businessId);
  if (!scope.ok) return jsonError(scope.error, scope.status, { reason: 'insufficient_scope' });

  const viewer = await loadViewer(credential.actor);

  try {
    const created = await chainJobsForLead(viewer, { businessId, leadId: parsed.data.lead_id });
    return jsonOk({
      ok: true,
      created: created.map((job) => ({
        job_id: job.jobId,
        created: job.created,
        job_type: job.jobType,
      })),
    });
  } catch {
    // `describeDbError` is not used here: a chaining refusal is a business outcome
    // and the sentence is fixed, so nothing about the schema reaches the client.
    return jsonError('The research job could not be created for this lead.', 403, {
      reason: 'job_creation_refused',
    });
  }
}
