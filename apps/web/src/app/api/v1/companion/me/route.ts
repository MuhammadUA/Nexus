/**
 * GET /api/v1/companion/me — the signed-in user, so the panel can confirm a token
 * is still valid without a full bootstrap.
 */
import { companionSession } from '@/lib/repo/companion';

import { authorizeUser, jsonOk } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const session = await companionSession(auth.context.actor, auth.context.userId);
  return jsonOk({ session });
}
