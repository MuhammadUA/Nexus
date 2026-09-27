import type { ReactNode } from 'react';

import { redirect } from 'next/navigation';

import { currentViewer } from '@/lib/current-viewer';
import { listBusinesses } from '@/lib/repo/businesses';

export const dynamic = 'force-dynamic';

/**
 * The workspace entry point.
 *
 * An administrator lands on the business **Overview** (Figma A02 — the stat cards, team activity,
 * lead health and recent activity composition), not on My Day. My Day is the *user* surface: it is
 * a personal work queue, and serving it at `/` gave an admin a task list where the frame specifies a
 * business roll-up. A standard user still lands on My Day, which is their intended home.
 *
 * A viewer with no business at all is sent to My Day rather than into a redirect loop, because there
 * is no business-scoped Overview to show them; the business list screens explain the empty state.
 */
export default async function HomePage(): Promise<ReactNode> {
  const viewer = await currentViewer();
  if (viewer === null) redirect('/login');

  if (viewer.role === 'admin') {
    const businesses = await listBusinesses(viewer.actor);
    const first = businesses[0];
    if (first !== undefined) redirect(`/b/${first.key}/overview`);
  }

  redirect('/my-day');
}
