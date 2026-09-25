/**
 * POST /api/v1/ingest — the scoped REST ingest endpoint for external agents.
 *
 * spec `api_contract.external_ingest.required_envelope`:
 *   source_client, business_key_or_id, payload_type, payload, idempotency_key,
 *   observed_at
 *
 * spec `api_contract.external_ingest.pipeline`:
 *   validate -> normalize -> dedupe -> persist source evidence -> apply
 *   business/ICP rules -> create/update candidate/lead -> assignment -> optional
 *   sequence enrollment -> audit
 *
 * Idempotency is enforced by a unique index
 * (`ingest_requests (source_client, business_id, idempotency_key)`), so a retried
 * call returns the original outcome instead of creating a second lead. Every payload
 * is schema-validated with `ingestEnvelopeSchema` before any write, and the stored
 * result records which pipeline stages ran so a caller can see exactly what happened.
 */
import { ingestEnvelopeSchema } from '@nexus/core';

import { withActor } from '@/lib/actor';
import { requireScope, resolveCredential } from '@/lib/gateway';
import { submitIngest } from '@/lib/repo/ingest';

import { jsonError, jsonOk } from '../_lib/http';

export const dynamic = 'force-dynamic';

/** Only these payload types may be submitted by an external client. */
const ALLOWED_PAYLOAD_TYPES = new Set(['candidate', 'signal', 'source_evidence', 'reply', 'research', 'rfp']);

export async function POST(request: Request): Promise<Response> {
  const credential = await resolveCredential(request.headers.get('authorization'));
  if (credential.kind === 'anonymous') {
    return jsonError('Missing or invalid token.', 401);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Expected a JSON body.', 400);
  }

  const parsed = ingestEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '';
    return jsonError(
      `Invalid ingest envelope${path.length > 0 ? ` at ${path}` : ''}: ${first?.message ?? 'unknown error'}`,
      400,
    );
  }

  const envelope = parsed.data;
  if (!ALLOWED_PAYLOAD_TYPES.has(envelope.payload_type)) {
    return jsonError(`payload_type ${envelope.payload_type} is not accepted by this endpoint.`, 400);
  }

  // Resolve the business first, because the scope check needs its id.
  const business = await withActor(credential.actor, async (sql) => {
    const result = await sql.query<{ id: string }>(
      `select id from public.businesses where (key = $1 or id::text = $1) and deleted_at is null limit 1`,
      [envelope.business_key_or_id],
    );
    return result.rows[0]?.id ?? null;
  });

  if (business === null) {
    // Deliberately indistinguishable from "not permitted": confirming that a business
    // exists outside the token's scope would itself be a disclosure.
    return jsonError('Unknown business, or this token is not scoped to it.', 404);
  }

  const scopeCheck = requireScope(credential, 'ingest:write', business);
  if (!scopeCheck.ok) return jsonError(scopeCheck.error, scopeCheck.status);

  try {
    const outcome = await submitIngest(credential.actor, {
      sourceClient: envelope.source_client,
      businessId: business,
      payloadType: envelope.payload_type,
      payload: envelope.payload,
      idempotencyKey: envelope.idempotency_key,
      // `zDate` normalises to a Date; the repository and the column both want a string.
      observedAt: envelope.observed_at.toISOString(),
      businessKeyOrId: envelope.business_key_or_id,
    });

    // A duplicate is a success: the caller asked for a state, and that state holds.
    return jsonOk(
      {
        idempotent: outcome.idempotent,
        stages: outcome.stages,
        ...(outcome.leadId === undefined ? {} : { leadId: outcome.leadId }),
        ...(outcome.personId === undefined ? {} : { personId: outcome.personId }),
        ...(outcome.companyId === undefined ? {} : { companyId: outcome.companyId }),
        ...(outcome.duplicateCandidateId === undefined
          ? {}
          : { duplicateCandidateId: outcome.duplicateCandidateId }),
      },
      outcome.idempotent ? 200 : 201,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The payload could not be ingested.';
    return jsonError(message, 400);
  }
}
