/**
 * GET /api/v1/ai/usage — what AI work has cost, by day and task.
 *
 * Read-only, and derived entirely from `ai_runs` (the append-only ledger). The
 * ledger has no column for a request or a response body, so this endpoint cannot
 * return one even by accident — which is the property that makes an operator usage
 * view safe to expose.
 *
 * Query: `?business_id=<uuid>`. Auth: a user session, or a service token holding
 * `ai:read` for that business.
 */
import { resolveCredential, requireScope } from '@/lib/gateway';
import { withActor } from '@/lib/actor';
import { asNumber } from '@/lib/repo/common';

import { jsonError, jsonOk, optionalLimit } from '../../_lib/http';

export const dynamic = 'force-dynamic';

type UsageRow = {
  business_id: string;
  day: unknown;
  task: string;
  runs: number | string | bigint;
  cache_hits: number | string | bigint;
  failures: number | string | bigint;
  tokens_in: number | string | bigint;
  tokens_out: number | string | bigint;
  estimated_cost_usd: number | string | null;
  avg_duration_ms: number | string | null;
}

/** A `date` reaches the driver as a string in PGlite and a `Date` through `pg`. */
function asDay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10);
  return '';
}

export async function GET(request: Request): Promise<Response> {
  const credential = await resolveCredential(request.headers.get('authorization'));
  if (credential.kind === 'anonymous') return jsonError('Missing or invalid token.', 401);

  const url = new URL(request.url);
  const businessId = (url.searchParams.get('business_id') ?? '').trim();
  if (businessId.length === 0) {
    return jsonError('business_id is required.', 400, { reason: 'business_required' });
  }

  const scope = requireScope(credential, 'ai:read', businessId);
  if (!scope.ok) return jsonError(scope.error, scope.status, { reason: 'insufficient_scope' });

  const limit = optionalLimit(url.searchParams.get('limit')) ?? 200;

  try {
    const data = await withActor(credential.actor, async (sql) => {
      // One transaction, so "today" and the rows that are flagged against it come
      // from the same clock. A client-side date could disagree with the server's.
      const today = await sql.query<{ today: unknown }>(`select current_date as today`);
      const todayText = asDay(today.rows[0]?.today);

      const rows = await sql.query<UsageRow>(
        `select business_id, day, task, runs, cache_hits, failures, tokens_in, tokens_out,
                estimated_cost_usd, avg_duration_ms
           from public.ai_usage_daily
          where business_id = $1
          order by day desc, task
          limit $2`,
        [businessId, Math.min(Math.max(Math.trunc(limit), 1), 1000)],
      );

      return { todayText, rows: rows.rows };
    });

    const rows = data.rows.map((row) => ({
      business_id: String(row.business_id),
      day: asDay(row.day),
      task: row.task,
      runs: asNumber(row.runs, 0),
      cache_hits: asNumber(row.cache_hits, 0),
      failures: asNumber(row.failures, 0),
      tokens_in: asNumber(row.tokens_in, 0),
      tokens_out: asNumber(row.tokens_out, 0),
      estimated_cost_usd: asNumber(row.estimated_cost_usd, 0),
      avg_duration_ms: asNumber(row.avg_duration_ms, 0),
    }));

    const todayRows = rows.filter((row) => row.day === data.todayText);

    return jsonOk({
      business_id: businessId,
      day: data.todayText,
      rows,
      today: {
        runs: todayRows.reduce((sum, row) => sum + row.runs, 0),
        cache_hits: todayRows.reduce((sum, row) => sum + row.cache_hits, 0),
        failures: todayRows.reduce((sum, row) => sum + row.failures, 0),
        tokens_in: todayRows.reduce((sum, row) => sum + row.tokens_in, 0),
        tokens_out: todayRows.reduce((sum, row) => sum + row.tokens_out, 0),
        estimated_cost_usd: todayRows.reduce((sum, row) => sum + row.estimated_cost_usd, 0),
      },
    });
  } catch {
    // The view is `security_invoker`, so a business the actor cannot see simply
    // yields nothing; reaching here means the projection itself failed.
    return jsonError('AI usage could not be read right now.', 503, { reason: 'usage_unavailable' });
  }
}
