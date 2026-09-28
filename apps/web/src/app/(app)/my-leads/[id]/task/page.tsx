import { notFound, redirect } from 'next/navigation';

import { leadBusinessKey } from '@/lib/lead-links';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';

export const dynamic = 'force-dynamic';

/**
 * Alias: `/my-leads/:id/task` → `/tasks/new?lead=:id`.
 *
 * `ROUTE_PERMISSIONS` names the user task screen as `/my-leads/:leadId/task`, and the screen
 * itself is the Create Task form bound to a lead through `?lead=`. Rather than a second copy of the
 * form — which would be a second place for the validation and the redirect to drift — the
 * `:leadId` path resolves the lead and forwards to the one implementation.
 *
 * The lead is resolved through RLS before the redirect, so an id the viewer cannot see is a 404
 * here rather than a bound form that would fail on submit.
 */
export default async function MyLeadTaskAlias({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<never> {
  const { id } = await params;
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/my-leads/:leadId/task' });

  const businessKey = await leadBusinessKey(context.viewer.actor, id);
  if (businessKey === null) notFound();

  redirect(`/tasks/new?lead=${encodeURIComponent(id)}`);
}
