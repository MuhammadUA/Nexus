import type { ReactNode } from 'react';

import { routePermissionsFor } from '@nexus/core';
import { notFound } from 'next/navigation';

import { Shell } from '@/components/shell';
import { canAccessRoute } from '@/lib/route-guard';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * One operational surface of the business secondary navigation (spec §73.2).
 *
 * `path` is the link; `declaredRoute` is the pattern `ROUTE_PERMISSIONS` should carry for it,
 * and `fallbackRoute` is the declared requirement to judge it by while that entry is missing.
 * The matrix in `packages/core` is owned by another agent and is being extended for V1.2, and
 * the guard fails closed on a route it has no entry for — which would make two of these screens
 * unreachable rather than merely ungated. Judging them by the section they belong to is the
 * narrowest correct answer available today, and `routePermissionsFor` is consulted first, so
 * each entry follows the matrix the moment it exists.
 *
 * Two of the six are not business-scoped (`/identities` and `/my-access` are account-level
 * screens), so they are judged against the viewer's union of grants exactly as their own routes
 * are.
 */
interface OperationalSurface {
  readonly label: string;
  /** The href, with `{slug}` substituted at render. */
  readonly path: string;
  /** The route pattern this screen declares in `ROUTE_PERMISSIONS`. */
  readonly declaredRoute: string;
  /** The declared requirement to fall back to while the matrix has no entry for it. */
  readonly fallbackRoute: string | null;
  /** True when the route belongs to the business and is judged against its grant alone. */
  readonly scoped: boolean;
}

/**
 * The operational surfaces, in the order they render.
 *
 * **AI comes first on purpose.** It is the sixth Business Setup tab (§72.1: … Knowledge,
 * Signals, AI), and AppShell appends these entries after the active destination's own tabs, so
 * putting AI first is what places it directly after Signals instead of after the five unrelated
 * surfaces.
 *
 * **Agent Jobs is here rather than in `ADMIN_NAV`** because §70.1 places it under Integrations /
 * Automation and §73.3 forbids a new top-level sidebar entry. **Channel Accounts** is the
 * re-vocabularised Outreach Identities screen (`/identities`, per the V1.2 acceptance checklist
 * §7): on Team & Accounts the same href is already a nested module, so it is deduplicated there
 * and appears under its operational name everywhere else. Every entry here corresponds to a
 * route that exists — the list is checkable, and a link to a screen that does not exist would be
 * worse than a missing tab.
 */
const OPERATIONAL_SURFACES: readonly OperationalSurface[] = [
  {
    label: 'AI',
    path: '/b/{slug}/setup/ai',
    declaredRoute: '/b/:businessSlug/setup/ai',
    fallbackRoute: '/b/:businessSlug/setup',
    scoped: true,
  },
  {
    label: 'Agent Jobs',
    path: '/b/{slug}/agent-jobs',
    declaredRoute: '/b/:businessSlug/agent-jobs',
    fallbackRoute: '/b/:businessSlug/automations',
    scoped: true,
  },
  {
    label: 'Channel Accounts',
    path: '/identities',
    declaredRoute: '/identities',
    fallbackRoute: null,
    scoped: false,
  },
  {
    label: 'Automations',
    path: '/b/{slug}/automations',
    declaredRoute: '/b/:businessSlug/automations',
    fallbackRoute: null,
    scoped: true,
  },
  {
    label: 'Imports',
    path: '/b/{slug}/lead-sources/import',
    declaredRoute: '/b/:businessSlug/lead-sources/import',
    fallbackRoute: null,
    scoped: true,
  },
  {
    label: 'Access',
    path: '/my-access',
    declaredRoute: '/my-access',
    fallbackRoute: null,
    scoped: false,
  },
];

/**
 * Business-scoped layout: `/b/[slug]/...`.
 *
 * The slug is resolved against the businesses the viewer can actually see, so an
 * inaccessible business 404s exactly like a non-existent one. Resolving it here also
 * lets the sidebar bind the slug into its routes.
 *
 * It also resolves the business secondary navigation. That happens here rather than in the
 * shell because the decision needs the viewer context — a link to a screen the viewer may not
 * open must not be rendered as if it worked — and the shell is a client component.
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

  const secondaryNav = OPERATIONAL_SURFACES.filter((surface) => {
    const declared = routePermissionsFor(surface.declaredRoute);
    const route = declared === null ? (surface.fallbackRoute ?? surface.declaredRoute) : surface.declaredRoute;
    return canAccessRoute(context, {
      route,
      ...(surface.scoped ? { businessId: business.id } : {}),
    });
  }).map((surface) => ({ label: surface.label, href: surface.path.replace('{slug}', business.key) }));

  return (
    <Shell
      surface={context.viewer.role === 'admin' ? 'admin' : 'user'}
      nav={context.nav}
      secondaryNav={secondaryNav}
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
