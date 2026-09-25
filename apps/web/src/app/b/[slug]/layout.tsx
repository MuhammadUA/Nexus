import type { ReactNode } from 'react';

import { notFound } from 'next/navigation';

import { Shell } from '@/components/shell';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * Business-scoped layout: `/b/[slug]/...`.
 *
 * The slug is resolved against the businesses the viewer can actually see, so an
 * inaccessible business 404s exactly like a non-existent one. Resolving it here also
 * lets the sidebar bind the slug into its routes.
 */
export default async function BusinessLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);

  if (business === null) notFound();

  return (
    <Shell
      surface={context.viewer.role === 'admin' ? 'admin' : 'user'}
      nav={context.nav}
      businessSlug={business.key}
      businesses={context.switcher.map((option) => ({
        id: option.id,
        slug: option.slug,
        name: option.name,
      }))}
      userLabel={context.viewer.fullName ?? context.viewer.email ?? ''}
    >
      {children}
    </Shell>
  );
}
