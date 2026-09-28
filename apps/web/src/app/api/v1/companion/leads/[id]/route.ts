/**
 * GET /api/v1/companion/leads/:id — the one canonical lead context.
 *
 * spec `companion_extension.shared_lead_detail`: "Leads/Today/Search all open the
 * same canonical lead context; no three independent detail implementations." This
 * endpoint is that context, and the panel's Leads, Today, Search, Connection Focus,
 * Follow-up Focus and Reply screens all render from it.
 *
 * It carries the V1.2 enrichment indicator as well (spec §36), read from
 * `public.lead_enrichment` rather than recomputed, plus the deterministic
 * "Find LinkedIn" URL for a lead that has no profile yet. That matters most here: after
 * a minimal capture the panel lands on this screen, and the operator's next step is
 * exactly that search.
 */
import { getLead, getLeadTimeline } from '@/lib/repo/leads';
import { companionEnrichment, companionLeadDetail, findLinkedInSearchUrl } from '@/lib/repo/companion';

import { authorizeUser, jsonError, jsonOk } from '../../../_lib/http';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const auth = await authorizeUser(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  if (!UUID.test(id)) return jsonError('That lead could not be found.', 404);

  const actor = auth.context.actor;
  const [lead, detail, timeline, enrichment] = await Promise.all([
    getLead(actor, id),
    companionLeadDetail(actor, id),
    getLeadTimeline(actor, id, 12),
    companionEnrichment(actor, id),
  ]);

  // RLS makes an inaccessible lead indistinguishable from a missing one, which is
  // the intended behaviour: confirming existence would itself be a disclosure.
  if (lead === null || detail === null) return jsonError('That lead could not be found.', 404);

  const linkedinUrl = lead.linkedinUrl ?? lead.sourceUrl;

  return jsonOk({
    detail: {
      lead: {
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
        enrichmentStatus: enrichment.status,
        intelligence: enrichment.intelligence,
        missingFields: enrichment.missingFields,
        findLinkedInUrl: findLinkedInSearchUrl({
          fullName: lead.personName,
          companyName: lead.companyName,
          location: lead.location ?? null,
          linkedinUrl,
        }),
      },
      currentMessage: detail.currentMessage,
      // Compact history only — spec `followup_focus`: "Do not show every message
      // expanded."
      recentHistory: timeline.slice(0, 5).map((entry) => ({
        id: entry.id,
        at: entry.at,
        kind: entry.kind,
        body: entry.body,
        summary: entry.summary,
      })),
      sequence: {
        ...detail.sequence,
        priorSteps: detail.priorSteps,
      },
    },
  });
}
