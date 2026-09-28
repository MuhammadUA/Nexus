import { notFound, redirect } from 'next/navigation';

import { canonicalLeadPath } from '@/lib/lead-links';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';

export const dynamic = 'force-dynamic';

/**
 * Alias: `/leads/:id/edit` → `/b/:slug/leads/:id/edit`.
 *
 * This path was the physical Edit Lead page before the routes were reconciled. It is kept — rather
 * than deleted — so a link or bookmark from the Preview keeps working, and it is declared in
 * `ROUTE_PERMISSIONS` as an alias so the inventory can see that it is not a second implementation.
 *
 * The guard runs before the redirect and uses the canonical route's requirement, so an operator
 * without `lead.update` is refused here exactly as they would be there: an alias must not be a way
 * around the screen it points at.
 */
export default async function LegacyEditLeadAlias({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<never> {
  const { id } = await params;
  const context = await loadViewerContext();
  // The alias's own requirement, which carries the same permission as the canonical screen it
  // redirects to — so this path is refused for an operator who could not open that screen either.
  requireRouteAccess(context, { route: '/leads/:leadId/edit' });

  const path = await canonicalLeadPath(context.viewer.actor, id);
  // An invisible lead is indistinguishable from a non-existent one.
  if (path === null) notFound();

  redirect(`${path}/edit`);
}
