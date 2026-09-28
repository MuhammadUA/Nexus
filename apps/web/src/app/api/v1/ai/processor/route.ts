/**
 * POST /api/v1/ai/processor — run one bounded pass of the AI queue.
 *
 * **This is the future Vercel Cron target.** It is safe to call repeatedly: the
 * claim is lease-guarded and skip-locked, every step is idempotent, and a failure on
 * one job never aborts the batch (see `lib/ai/pipeline.ts`). A cron entry can point
 * at it with a service token holding `jobs:submit`, or with nothing at all once the
 * deployment uses an OIDC-authenticated cron identity mapped to an admin session.
 *
 * Body: `{ business_id?, limit? }`. Omitting `business_id` sweeps every business the
 * caller may sweep, which is a deployment-level operation and is therefore refused
 * for a manager: only an admin session or a scoped service token may do it.
 */
import { z } from 'zod';

import { processAiQueue } from '@/lib/ai/pipeline';
import { loadViewer, type Viewer } from '@/lib/actor';
import { requireScope, resolveCredential, type Credential } from '@/lib/gateway';

import { jsonError, jsonOk, parseBody } from '../../_lib/http';

export const dynamic = 'force-dynamic';
// A sweep talks to a model, so it must never be statically rendered or cached.
export const maxDuration = 300;

const processorBodySchema = z.object({
  business_id: z.string().uuid().nullable().optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

/**
 * Authorises the caller.
 *
 * A user session must be an administrator or a manager — the processor changes
 * enrichment state for a whole business — and a service token must hold
 * `jobs:submit` for the business it names.
 */
async function authorize(
  credential: Credential,
  businessId: string | null,
): Promise<{ ok: true; viewer: Viewer } | { ok: false; response: ReturnType<typeof jsonError> }> {
  if (credential.kind === 'anonymous') {
    return { ok: false, response: jsonError('Missing or invalid token.', 401) };
  }

  if (credential.kind === 'service') {
    const scope = requireScope(credential, 'jobs:submit', businessId ?? undefined);
    if (!scope.ok) {
      return { ok: false, response: jsonError(scope.error, scope.status, { reason: 'insufficient_scope' }) };
    }
    return { ok: true, viewer: await loadViewer(credential.actor) };
  }

  const viewer = await loadViewer(credential.actor);
  if (viewer.role !== 'admin' && viewer.role !== 'manager') {
    return {
      ok: false,
      response: jsonError('Only an administrator or a manager may run the AI processor.', 403, {
        reason: 'insufficient_role',
      }),
    };
  }
  if (businessId === null && viewer.role !== 'admin') {
    return {
      ok: false,
      response: jsonError(
        'A manager must name the business to process.',
        400,
        { reason: 'business_required' },
      ),
    };
  }
  return { ok: true, viewer };
}

export async function POST(request: Request): Promise<Response> {
  const credential = await resolveCredential(request.headers.get('authorization'));

  const parsed = await parseBody(request, processorBodySchema);
  if (!parsed.ok) return parsed.response;
  const businessId = parsed.data.business_id ?? null;

  const authorized = await authorize(credential, businessId);
  if (!authorized.ok) return authorized.response;

  const report = await processAiQueue(authorized.viewer, {
    businessId,
    limit: parsed.data.limit ?? 5,
  });

  return jsonOk({ ok: true, ...report });
}
