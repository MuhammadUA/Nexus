import { redirect } from 'next/navigation';

import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';

export const dynamic = 'force-dynamic';

/**
 * Alias: `/team/:id/permissions` → `/team/:id`.
 *
 * The user detail screen *is* the permissions screen: it shows the account, its businesses, its
 * grants and the permission matrix, so there is no separate page to build and nothing is lost by
 * pointing the tab at the detail. The Team tab in `ADMIN_NAV` links here, and the anchor keeps the
 * permissions section in view.
 *
 * The guard is the detail screen's own requirement, so the alias cannot be used to reach a screen
 * the viewer may not open.
 */
export default async function TeamPermissionsAlias({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<never> {
  const { id } = await params;
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/team/:userId/permissions' });

  // The destination resolves the user and 404s when it is not visible to this viewer, so the alias
  // does not need a second lookup — it only has to refuse the route it does not have permission for.
  redirect(`/team/${encodeURIComponent(id)}#permissions`);
}
