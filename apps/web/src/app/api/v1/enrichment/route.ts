/**
 * POST /api/v1/enrichment — human-assisted profile enrichment.
 *
 * Body: `{ lead_id, linkedin_url, pasted_content, source_type?, source_url? }`.
 *
 * Auth: a user session, or a service token holding `profile:capture` **and** listing
 * the business the lead belongs to. The business is resolved from the lead rather
 * than accepted from the body, so a token cannot widen its own scope by naming
 * someone else's tenant.
 *
 * What comes back is the *structured* result: the fields that were applied, the
 * conflicts that need a decision, and the new enrichment state. The pasted body is
 * never echoed — not on success, not in an error, and not in a log line.
 */
import { z } from 'zod';

import { enrichProfileFromPaste } from '@/lib/ai/extract';
import { loadViewer, withActor } from '@/lib/actor';
import { requireScope, resolveCredential } from '@/lib/gateway';
import { loadLeadIntelligence } from '@/lib/repo/enrichment';

import { jsonError, jsonOk, parseBody } from '../_lib/http';

export const dynamic = 'force-dynamic';

const enrichmentBodySchema = z.object({
  lead_id: z.string().uuid(),
  linkedin_url: z.string().trim().min(1).max(2000),
  // 400k is the staging ceiling; a larger body is a validation failure here rather
  // than a database error later.
  pasted_content: z.string().min(1).max(400_000),
  source_type: z.string().trim().min(1).max(120).optional(),
  source_url: z.string().trim().max(2000).nullable().optional(),
});

/**
 * Maps a typed extraction failure onto an HTTP status.
 *
 * The `reason` is the stable machine code, so a client can branch on
 * `provider_not_configured` (a supported state, not a fault) without parsing a
 * sentence.
 */
function failureResponse(errorCode: string, message: string) {
  if (errorCode === 'lead_not_visible') return jsonError(message, 404, { reason: errorCode });
  if (errorCode === 'empty_payload') return jsonError(message, 400, { reason: errorCode });
  if (errorCode === 'raw_stage_failed') return jsonError(message, 400, { reason: errorCode });
  if (errorCode === 'commit_failed' || errorCode === 'raw_unreadable') {
    return jsonError('The profile could not be committed. Nothing was changed; the staged content was kept for a retry.', 500, {
      reason: errorCode,
    });
  }
  // Everything else is an extraction failure: the model was unavailable, refused,
  // or answered outside the required shape. Nothing was written.
  return jsonError(message, 422, { reason: errorCode });
}

export async function POST(request: Request): Promise<Response> {
  const credential = await resolveCredential(request.headers.get('authorization'));
  if (credential.kind === 'anonymous') return jsonError('Missing or invalid token.', 401);

  const parsed = await parseBody(request, enrichmentBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // RLS decides whether the lead exists for this actor, so "not found" and "not
  // yours" are the same answer and neither discloses a tenant.
  const businessId = await withActor(credential.actor, async (sql) => {
    const result = await sql.query<{ business_id: string }>(
      `select business_id from public.leads where id = $1 and deleted_at is null`,
      [body.lead_id],
    );
    return result.rows[0]?.business_id ?? null;
  });
  if (businessId === null) return jsonError('That lead could not be found.', 404, { reason: 'lead_not_visible' });

  const scope = requireScope(credential, 'profile:capture', businessId);
  if (!scope.ok) return jsonError(scope.error, scope.status, { reason: 'insufficient_scope' });

  const viewer = await loadViewer(credential.actor);
  const outcome = await enrichProfileFromPaste(viewer, {
    leadId: body.lead_id,
    linkedinUrl: body.linkedin_url,
    pastedContent: body.pasted_content,
    sourceType: body.source_type,
    sourceUrl: body.source_url ?? null,
  });

  if (!outcome.ok) return failureResponse(outcome.errorCode, outcome.error);

  // Read the state back from the row that was just advanced, rather than reporting
  // a state computed before the commit.
  const intelligence = await loadLeadIntelligence(viewer, outcome.leadId);

  return jsonOk({
    ok: true,
    lead_id: outcome.leadId,
    person_id: outcome.personId,
    company_id: outcome.companyId,
    applied: outcome.applied,
    review: outcome.review,
    raw_deleted: outcome.rawDeleted,
    run_id: outcome.runId,
    status: intelligence?.status ?? null,
    completeness_score: intelligence?.completenessScore ?? 0,
    missing_fields: intelligence?.missingFields ?? [],
    // Deliberately absent: the pasted content. It was staged, extracted and deleted.
  });
}
