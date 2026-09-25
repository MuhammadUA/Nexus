/**
 * GET /api/v1/companion/leads — the panel's lead list.
 */
import { listLeads } from '@/lib/repo/leads';

import { authorizeUser, clampLimit, jsonError, jsonOk } from '../../_lib/http';

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
  const limit = clampLimit(Number(params.get('limit') ?? ''), 50, 100);
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

  return jsonOk({
    total: page.total,
    leads: page.items.map((lead) => ({
      id: lead.id,
      personName: lead.personName,
      companyName: lead.companyName,
      jobTitle: lead.jobTitle,
      status: lead.status,
      isDnc: lead.isDnc,
      needsProfile: lead.needsProfile,
      linkedinUrl: lead.sourceUrl !== null && lead.sourceUrl.includes('linkedin.com') ? lead.sourceUrl : null,
      identityName: lead.identityName,
      nextActionType: lead.nextActionType,
      nextActionAt: lead.nextActionAt,
    })),
  });
}
