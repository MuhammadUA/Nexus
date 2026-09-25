/**
 * GET /api/v1/companion/icps?businessId=<uuid>
 */
import { companionIcps } from '@/lib/repo/companion';

import { authorizeUser, jsonError, jsonOk } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const businessId = new URL(request.url).searchParams.get('businessId') ?? '';
  if (!UUID.test(businessId)) return jsonError('A valid businessId is required.', 400);

  // RLS on `icps` refuses a business the caller cannot see, so no extra check is
  // needed here — and none should be added, or the two could disagree.
  const icps = await companionIcps(auth.context.actor, businessId);
  return jsonOk({ icps });
}
