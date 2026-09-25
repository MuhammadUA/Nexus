/**
 * POST /api/v1/companion/mark-connection-sent
 * POST /api/v1/companion/mark-message-sent
 * POST /api/v1/companion/capture-reply
 * POST /api/v1/companion/snooze
 * POST /api/v1/companion/reactivate
 * POST /api/v1/companion/capture-profile
 *
 * All six are thin, validated passthroughs to the same repository functions the web
 * app uses, so the Companion and the browser app cannot diverge in behaviour. The
 * database RPCs enforce the invariants (immutability, DNC suppression, sequence
 * pause), and RLS enforces who may write.
 */
import { z } from 'zod';

import { REPLY_OUTCOMES } from '@nexus/core';

import { loadViewer } from '@/lib/actor';
import {
  captureReply,
  markConnectionSent,
  markMessageSent,
  snoozeLead,
  startReactivation,
} from '@/lib/repo/leads';
import { submitProfileCapture } from '@/lib/repo/profile-capture';

import { authorizeUser, jsonError, jsonOk, parseBody } from '../../../_lib/http';

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

const schemas = {
  'mark-connection-sent': z.object({
    leadId: uuid,
    identityId: uuid,
    withNote: z.boolean(),
  }),
  'mark-message-sent': z.object({
    messageInstanceId: uuid,
    identityId: uuid,
  }),
  'capture-reply': z.object({
    leadId: uuid,
    // The exact inbound text, stored verbatim. Bounded only to protect the database.
    exactText: z.string().min(1).max(20_000),
    outcome: z.enum(REPLY_OUTCOMES),
    note: z.string().max(4000).nullable(),
  }),
  snooze: z.object({
    leadId: uuid,
    until: z.string().datetime(),
    reason: z.string().max(1000).nullable(),
  }),
  reactivate: z.object({ leadId: uuid }),
  'capture-profile': z.object({
    leadId: uuid,
    linkedinUrl: z.string().trim().min(4).max(500),
    pastedContent: z.string().min(1).max(200_000),
  }),
} as const;

type Operation = keyof typeof schemas;

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly operation: string }> },
): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const { operation } = await context.params;
  if (!(operation in schemas)) return jsonError('Unknown operation.', 404);

  const viewer = await loadViewer(auth.context.actor);
  const key = operation as Operation;

  try {
    switch (key) {
      case 'mark-connection-sent': {
        const parsed = await parseBody(request, schemas[key]);
        if (!parsed.ok) return parsed.response;
        const result = await markConnectionSent(
          viewer,
          parsed.data.leadId,
          parsed.data.identityId,
          parsed.data.withNote,
        );
        return result.ok ? jsonOk({ ok: true }) : jsonError(result.error ?? 'That did not work.', 400);
      }

      case 'mark-message-sent': {
        const parsed = await parseBody(request, schemas[key]);
        if (!parsed.ok) return parsed.response;
        const result = await markMessageSent(viewer, parsed.data.messageInstanceId, parsed.data.identityId);
        return result.ok ? jsonOk({ ok: true }) : jsonError(result.error ?? 'That did not work.', 400);
      }

      case 'capture-reply': {
        const parsed = await parseBody(request, schemas[key]);
        if (!parsed.ok) return parsed.response;
        const result = await captureReply(viewer, {
          leadId: parsed.data.leadId,
          exactText: parsed.data.exactText,
          outcome: parsed.data.outcome,
          note: parsed.data.note,
        });
        return result.ok ? jsonOk({ ok: true }) : jsonError(result.error ?? 'That did not work.', 400);
      }

      case 'snooze': {
        const parsed = await parseBody(request, schemas[key]);
        if (!parsed.ok) return parsed.response;
        const result = await snoozeLead(viewer, {
          leadId: parsed.data.leadId,
          until: parsed.data.until,
          reason: parsed.data.reason,
        });
        return result.ok ? jsonOk({ ok: true }) : jsonError(result.error ?? 'That did not work.', 400);
      }

      case 'reactivate': {
        const parsed = await parseBody(request, schemas[key]);
        if (!parsed.ok) return parsed.response;
        const result = await startReactivation(viewer, parsed.data.leadId);
        return result.ok ? jsonOk({ ok: true }) : jsonError(result.error ?? 'That did not work.', 400);
      }

      case 'capture-profile': {
        const parsed = await parseBody(request, schemas[key]);
        if (!parsed.ok) return parsed.response;
        // Updates the EXISTING lead and records evidence; never creates a second lead.
        const result = await submitProfileCapture(viewer, {
          leadId: parsed.data.leadId,
          linkedinUrl: parsed.data.linkedinUrl,
          pastedContent: parsed.data.pastedContent,
        });
        return result.ok ? jsonOk({ ok: true }) : jsonError(result.error ?? 'That did not work.', 400);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The request could not be completed.';
    return jsonError(message, 400);
  }
}
