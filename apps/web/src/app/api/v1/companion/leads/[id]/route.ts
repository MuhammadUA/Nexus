/**
 * GET /api/v1/companion/leads/:id — the one canonical lead context.
 *
 * spec `companion_extension.shared_lead_detail`: "Leads/Today/Search all open the
 * same canonical lead context; no three independent detail implementations." This
 * endpoint is that context, and the panel's Leads, Today, Search, Connection Focus,
 * Follow-up Focus and Reply screens all render from it.
 */
import { getLead, getLeadTimeline } from '@/lib/repo/leads';
import { companionLeadDetail } from '@/lib/repo/companion';

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
  const [lead, detail, timeline] = await Promise.all([
    getLead(actor, id),
    companionLeadDetail(actor, id),
    getLeadTimeline(actor, id, 12),
  ]);

  // RLS makes an inaccessible lead indistinguishable from a missing one, which is
  // the intended behaviour: confirming existence would itself be a disclosure.
  if (lead === null || detail === null) return jsonError('That lead could not be found.', 404);

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
        linkedinUrl: lead.linkedinUrl ?? lead.sourceUrl,
        identityName: lead.identityName,
        nextActionType: lead.nextActionType,
        nextActionAt: lead.nextActionAt,
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
