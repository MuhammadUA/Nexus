/**
 * POST /api/v1/companion/heartbeat — mark this browser session live.
 *
 * Matters because the concurrency check treats a session as active only while it has
 * heartbeated recently (`evaluateIdentityConcurrency` in `@nexus/core`). Without a
 * heartbeat, a profile closed uncleanly would block its identity forever.
 */
import { z } from 'zod';

import { touchBrowserSession } from '@/lib/repo/companion';

import { authorizeUser, jsonOk, parseBody } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(request, z.object({ installId: z.string().trim().min(8).max(120) }));
  if (!parsed.ok) return parsed.response;

  await touchBrowserSession(auth.context.actor, parsed.data.installId);
  return jsonOk({ ok: true });
}
