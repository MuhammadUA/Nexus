/**
 * Per-request viewer context: who is looking, what they may do, and which
 * businesses they can see.
 *
 * Resolved once per layout render and passed down, so a page never re-derives
 * permissions from a partial source. Navigation and control visibility both read
 * this, which is what keeps a route from appearing without the permission that
 * gates it.
 */
import 'server-only';

import {
  ADMIN_NAV,
  ADMIN_PERMISSIONS,
  USER_NAV,
  effectivePermissions,
  visibleNavItems,
  type Actor as CoreActor,
  type Permission,
  type UserBusinessGrant,
} from '@nexus/core';

import type { Viewer } from './actor';
import { listBusinesses, listUserGrants, switcherOptions, type Business, type BusinessSwitcherOption } from './repo/businesses';
import { requireViewer } from './current-viewer';

export interface NavSection {
  readonly group: string;
  readonly items: readonly { readonly label: string; readonly route: string; readonly permission: Permission | null }[];
}

export interface ViewerContext {
  readonly viewer: Viewer;
  readonly permissions: ReadonlySet<Permission>;
  readonly businesses: readonly Business[];
  readonly switcher: readonly BusinessSwitcherOption[];
  readonly grants: readonly UserBusinessGrant[];
  readonly nav: readonly NavSection[];
}

/** Grants in the shape `@nexus/core`'s permission helpers expect. */
function toCoreGrants(
  rows: Awaited<ReturnType<typeof listUserGrants>>,
): readonly UserBusinessGrant[] {
  return rows.map((row) => ({
    businessId: row.businessId,
    accessLevel: row.accessLevel,
    canManageLeads: row.canManageLeads,
    canUseLeadSources: row.canUseLeadSources,
    canUseProfileQueue: row.canUseProfileQueue,
    canDeleteLeads: row.canDeleteLeads,
    ...(row.leadScope === null ? {} : { leadScope: row.leadScope }),
  }));
}

/**
 * Loads the context for the signed-in viewer, redirecting to the login screen when
 * there is none.
 */
export async function loadViewerContext(): Promise<ViewerContext> {
  const viewer = await requireViewer();

  const [businesses, grants] = await Promise.all([
    listBusinesses(viewer.actor),
    viewer.userId === null ? Promise.resolve([]) : listUserGrants(viewer.actor, viewer.userId),
  ]);

  const coreGrants = toCoreGrants(grants);

  // The viewer's role is authoritative for what they may do *anywhere*; a grant
  // refines it per business.
  //
  // A user with several grants gets the union, because the sidebar must not hide a
  // screen the operator can legitimately reach in one of their businesses. Anything
  // narrower is re-checked against the specific business by RLS when the screen
  // actually reads data, so a wide sidebar can never become a wide data scope.
  const permissions = new Set<Permission>(
    viewer.role === 'admin' ? ADMIN_PERMISSIONS : [],
  );
  if (viewer.role !== null) {
    for (const grant of coreGrants) {
      for (const permission of effectivePermissions(viewer.role, grant, grant.businessId)) {
        permissions.add(permission);
      }
    }
  }

  const coreActor: CoreActor =
    viewer.userId !== null && viewer.role !== null
      ? { kind: 'user', userId: viewer.userId, role: viewer.role }
      : { kind: 'system', name: 'service' };

  const nav = visibleNavItems(coreActor, permissions, viewer.role === 'admin' ? ADMIN_NAV : USER_NAV);

  return {
    viewer,
    permissions,
    businesses,
    switcher: switcherOptions(businesses, viewer.role),
    grants: coreGrants,
    nav: nav.map((section) => ({ group: section.group, items: section.items })),
  };
}

/**
 * Resolves the business named in the URL.
 *
 * Returns null when the viewer cannot see it — which is exactly what RLS would do
 * for its rows, so a hidden business is indistinguishable from a non-existent one.
 * That is deliberate: revealing "this exists but you may not see it" is itself a
 * disclosure.
 *
 * Synchronous: the access check happened when the context was loaded, so this is a
 * lookup over an already-authorized list, not another round trip.
 */
export function resolveBusiness(context: ViewerContext, slug: string): Business | null {
  return context.businesses.find((business) => business.key === slug) ?? null;
}

/** The business to land on when a route needs one but none was given. */
export function defaultBusiness(context: ViewerContext): Business | null {
  return context.businesses[0] ?? null;
}
