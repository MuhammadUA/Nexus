/**
 * GET /api/v1/companion/leads — the panel's lead list.
 *
 * Each row carries the V1.2 enrichment indicator (spec §36): the pipeline state from
 * `public.lead_enrichment` and its `completeness_score` as the intelligence
 * percentage. Both are read, never computed here — a second derivation would
 * disagree with the pipeline that owns the number and with the AI context built
 * from it — and a lead with no enrichment row is reported as `MINIMAL` / 0 rather
 * than omitted.
 *
 * A row that has no profile URL yet also carries the deterministic "Find LinkedIn"
 * Google URL built by `@nexus/core`'s `searchLinks`, so the panel's fallback is the
 * same search the enrichment pipeline would run.
 */
import { listLeads } from '@/lib/repo/leads';
import { companionEnrichmentFor, findLinkedInSearchUrl } from '@/lib/repo/companion';

import { authorizeUser, clampLimit, jsonError, jsonOk, optionalLimit } from '../../_lib/http';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const businessId = params.get('businessId') ?? '';
  if (!UUID.test(businessId)) return jsonError('A valid businessId is required.', 400);

  const icpId = params.get('icpId') ?? '';
  const status = params.get('status') ?? '';
  const search = params.get('search') ?? '';
  // `optionalLimit` keeps an ABSENT limit at the 50-row default; reading it as `Number('')` clamped
  // the list to a single row while still reporting the full `total`.
  const limit = clampLimit(optionalLimit(params.get('limit')), 50, 100);
  const offset = Number(params.get('offset') ?? '0');

  const page = await listLeads(
    auth.context.actor,
    {
      businessId,
      ...(UUID.test(icpId) ? { icpId } : {}),
      ...(status.length > 0 ? { status } : {}),
      ...(search.trim().length > 0 ? { search } : {}),
      sort: 'next_action',
    },
    { limit, offset: Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0 },
  );

  // One extra read for the page's leads, rather than a join inside another agent's
  // list repository: `listLeads` is the canonical list projection and must not grow a
  // Companion-specific column set.
  const enrichment = await companionEnrichmentFor(
    auth.context.actor,
    page.items.map((lead) => lead.id),
  );

  return jsonOk({
    total: page.total,
    leads: page.items.map((lead) => {
      const indicator = enrichment.get(lead.id);
      const linkedinUrl =
        lead.sourceUrl !== null && lead.sourceUrl.includes('linkedin.com') ? lead.sourceUrl : null;
      return {
        id: lead.id,
        personName: lead.personName,
        companyName: lead.companyName,
        jobTitle: lead.jobTitle,
        status: lead.status,
        isDnc: lead.isDnc,
        needsProfile: lead.needsProfile,
        linkedinUrl,
        identityName: lead.identityName,
        nextActionType: lead.nextActionType,
        nextActionAt: lead.nextActionAt,
        enrichmentStatus: indicator?.status ?? 'MINIMAL',
        intelligence: indicator?.intelligence ?? 0,
        missingFields: indicator?.missingFields ?? [],
        findLinkedInUrl: findLinkedInSearchUrl({
          fullName: lead.personName,
          companyName: lead.companyName,
          linkedinUrl,
        }),
      };
    }),
  });
}
