import { notFound, redirect } from 'next/navigation';

import { leadBusinessKey } from '@/lib/lead-links';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';

export const dynamic = 'force-dynamic';

/**
 * Alias: `/my-leads/:id/snooze` → `/snooze?lead=:id`.
 *
 * Same reasoning as the task alias: the matrix names the `:leadId` path, the screen is the Snooze &
 * Reschedule form bound to a lead through `?lead=`, and one implementation is the only way the two
 * stay in step. The lead is resolved through RLS first, so an invisible id 404s.
 */
export default async function MyLeadSnoozeAlias({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<never> {
  const { id } = await params;
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/my-leads/:leadId/snooze' });

  const businessKey = await leadBusinessKey(context.viewer.actor, id);
  if (businessKey === null) notFound();

  redirect(`/snooze?lead=${encodeURIComponent(id)}`);
}
