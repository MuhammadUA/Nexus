/**
 * GET /api/v1/companion/today — the panel's Today queue.
 *
 * Delegates to the same `get_today_queue` projection the web My Day screen uses, so
 * the two surfaces can never disagree about what is due.
 */
import { getTodayQueue, TODAY_CATEGORIES, type TodayCategory } from '@/lib/repo/today';
import { describeDbError } from '@/lib/repo/common';

import { authorizeUser, jsonError, jsonOk } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Postgres codes that mean "the caller is not allowed to do this", as opposed to "the request was
 * malformed" or "something broke".
 *
 * `42501` is insufficient privilege / RLS refusal, `23001` is this project's own invariant code.
 */
function isPermissionRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === '42501' || code === '23001';
}

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

  let items: Awaited<ReturnType<typeof getTodayQueue>>;
  try {
    items = await getTodayQueue(auth.context.actor, auth.context.userId, {
      businessId,
      bucket: 'today',
      ...(requested.length === 0 ? {} : { categories: requested }),
      ...(userId === auth.context.userId ? {} : { userId }),
    });
  } catch (error) {
    /**
     * The database refuses a queue read that the caller is not entitled to (`42501`). Because this
     * route is a passthrough to the same function the web My Day screen uses, that refusal reached
     * the client as an unhandled exception — HTTP 500 with an empty body — which the Companion could
     * not distinguish from a server fault and would have retried.
     *
     * A permission refusal is a 403 with the database's own operator-facing explanation, so the panel
     * can say "you may not read this queue" rather than failing opaquely. Anything else is a genuine
     * fault and keeps propagating.
     */
    if (isPermissionRefusal(error)) return jsonError(describeDbError(error), 403);
    throw error;
  }

  return jsonOk({ items });
}
