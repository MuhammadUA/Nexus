import { redirect } from 'next/navigation';

import { withActor } from '@/lib/actor';
import { loadViewerContext, defaultBusiness } from '@/lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * `/my-leads/:id` alias.
 *
 * `ROUTE_PERMISSIONS` in `@nexus/core` names the user lead detail as
 * `/my-leads/:leadId`, but the screen itself is the one canonical lead context at
 * `/b/:slug/leads/:id` — spec `companion_extension.shared_lead_detail` insists there is
 * a single lead-detail implementation, and the admin surface already uses that path.
 *
 * This resolves which business actually owns the lead so the redirect lands in the
 * right context. RLS decides whether the viewer may see it at all: an inaccessible
 * lead resolves to `null`, and the redirect falls back to the viewer's first business
 * rather than confirming that the id exists.
 */
export default async function MyLeadAlias({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<never> {
  const { id } = await params;
  const context = await loadViewerContext();

  const businessSlug = await withActor(context.viewer.actor, async (sql) => {
    const result = await sql.query<{ key: string }>(
      `select b.key
         from public.leads l
         join public.businesses b on b.id = l.business_id
        where l.id = $1`,
      [id],
    );
    return result.rows[0]?.key ?? null;
  });

  const slug = businessSlug ?? defaultBusiness(context)?.key ?? null;
  if (slug === null) redirect('/my-leads');

  redirect(`/b/${slug}/leads/${id}`);
}
