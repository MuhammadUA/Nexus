import { notFound, redirect } from 'next/navigation';

import { canonicalLeadPath } from '@/lib/lead-links';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';

export const dynamic = 'force-dynamic';

/**
 * Alias: `/my-leads/:id/edit` → `/b/:slug/leads/:id/edit`.
 *
 * The user surface keeps its own `/my-*` address — the My Leads list links here, so a user never
 * has to know a business slug — and the screen itself is the one canonical Edit Lead page. Same
 * shape as `/my-leads/:id` → `/b/:slug/leads/:id`, which already worked this way.
 *
 * The guard runs first and requires `lead.update`, so the alias cannot be used to reach a screen
 * the viewer is not allowed to open.
 */
export default async function MyLeadEditAlias({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<never> {
  const { id } = await params;
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/my-leads/:leadId/edit' });

  const path = await canonicalLeadPath(context.viewer.actor, id);
  if (path === null) notFound();

  redirect(`${path}/edit`);
}
