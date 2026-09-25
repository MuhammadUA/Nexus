/**
 * GET /api/v1/companion/today — the panel's Today queue.
 *
 * Delegates to the same `get_today_queue` projection the web My Day screen uses, so
 * the two surfaces can never disagree about what is due.
 */
import { getTodayQueue, TODAY_CATEGORIES, type TodayCategory } from '@/lib/repo/today';

import { authorizeUser, jsonError, jsonOk } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const businessId = params.get('businessId') ?? '';
  const userId = params.get('userId') ?? auth.context.userId;

  if (!UUID.test(businessId)) return jsonError('A valid businessId is required.', 400);
  if (!UUID.test(userId)) return jsonError('A valid userId is required.', 400);

  // Only an admin or a business manager may read another user's queue; the database
  // function enforces that, so this is a passthrough rather than a duplicate check.
  const requested = (params.get('categories') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is TodayCategory => (TODAY_CATEGORIES as readonly string[]).includes(entry));

  const items = await getTodayQueue(auth.context.actor, auth.context.userId, {
    businessId,
    bucket: 'today',
    ...(requested.length === 0 ? {} : { categories: requested }),
    ...(userId === auth.context.userId ? {} : { userId }),
  });

  return jsonOk({ items });
}
