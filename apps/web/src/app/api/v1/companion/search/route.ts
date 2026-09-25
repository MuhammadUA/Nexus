/**
 * GET /api/v1/companion/search?q=… — find a person or lead across every accessible
 * business.
 *
 * spec `companion_extension.search`: a Person with several business Lead contexts is
 * returned once per business so the operator must choose the right record rather than
 * being silently shown one.
 */
import { companionSearch } from '@/lib/repo/companion';

import { authorizeUser, clampLimit, jsonError, jsonOk } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const query = params.get('q') ?? '';
  if (query.trim().length === 0) return jsonError('Enter a LinkedIn URL, name or company.', 400);

  const limit = clampLimit(Number(params.get('limit') ?? ''), 25, 50);
  const results = await companionSearch(auth.context.actor, query, limit);
  return jsonOk({ results });
}
