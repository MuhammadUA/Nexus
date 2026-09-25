import 'server-only';

import { notFound, redirect } from 'next/navigation';

import { routeAccessAllowed, type Permission, type RouteAccessReason } from '@nexus/core';

import { currentViewer } from './current-viewer';
import type { ViewerContext } from './viewer-context';

/**
 * Route-level authorization.
 *
 * `packages/core` owns the route -> permission matrix; this is the server-side enforcement of it.
 * Before this existed, the matrix was exported and read by nothing: every page gated its *controls*
 * with `context.permissions.has(...)`, so a standard user who typed `/settings` got a fully rendered
 * page with the forms disabled — and `/settings` disclosed the platform's global security, retention
 * and DNC defaults in the process. Navigation hiding is not authorization.
 *
 * Three properties this guard exists to guarantee:
 *
 *   1. **It runs on the server, before any read.** A page calls it immediately after building the
 *      viewer context, so a denied route never reaches a repository and never renders a shell.
 *   2. **It fails closed.** A route with no entry in the matrix is denied, so a screen that forgot to
 *      declare its requirement is unreachable rather than open.
 *   3. **Business scope is real.** A business-scoped route is judged against that business's grant,
 *      not the union across every business the operator can reach.
 *
 * The response is `notFound()`, matching the convention already used for a hidden business: a route
 * the viewer may not load is indistinguishable from one that does not exist. Returning 403 would
 * confirm that an admin area exists and that they are merely not allowed into it.
 *
 * RLS stays the real boundary. This guard decides whether a *screen* may be rendered; it never
 * decides whether a row may be read.
 */
export function requireRouteAccess(
  context: ViewerContext,
  requirements: {
    /** Route pattern from `ROUTE_PERMISSIONS`, e.g. `/b/:businessSlug/setup/icps`. */
    readonly route: string;
    /** The business the route belongs to, for a business-scoped route. */
    readonly businessId?: string | null;
  },
): { readonly reason: RouteAccessReason; readonly permissions: readonly Permission[] } {
  const decision = routeAccessDecision(context, requirements);

  if (!decision.allowed) notFound();

  return { reason: decision.reason, permissions: decision.permissions };
}

/**
 * The route-access decision itself: allowed, why, and which permissions it consulted.
 *
 * The single place the decision is made, so the page guard, the action guard and the "may this
 * screen render its controls" checks cannot disagree.
 */
export function routeAccessDecision(
  context: ViewerContext,
  requirements: { readonly route: string; readonly businessId?: string | null },
): { readonly allowed: boolean; readonly reason: RouteAccessReason; readonly permissions: readonly Permission[] } {
  const actor =
    context.viewer.userId !== null && context.viewer.role !== null
      ? ({ kind: 'user', userId: context.viewer.userId, role: context.viewer.role } as const)
      : ({ kind: 'system', name: 'service' } as const);

  return routeAccessAllowed({
    actor,
    role: context.viewer.role,
    grants: context.grants,
    unionPermissions: context.permissions,
    pathOrPattern: requirements.route,
    businessId: requirements.businessId ?? null,
  });
}

/** The same decision, without rendering a 404. */
export function canAccessRoute(
  context: ViewerContext,
  requirements: { readonly route: string; readonly businessId?: string | null },
): boolean {
  return routeAccessDecision(context, requirements).allowed;
}

/**
 * Authorization for a server action, which is reachable without ever loading its page.
 *
 * A Server Action is a public HTTP endpoint once it has been rendered anywhere: the client posts to
 * an action id, and nothing about that request passes through the page that imports it. Gating the
 * page therefore does nothing for the action. RLS has been the only barrier for the admin actions —
 * it does refuse them, because `users_insert` and friends require `is_admin()` — but "the database
 * refused it" is a poor place to be the *only* check: it needs a fixture to test, it is invisible in
 * the action's own code, and a future policy change would silently widen the action.
 *
 * So each admin action verifies the same route requirement its page declares, and returns a typed
 * refusal rather than a 404, because an action has no page to not find. Business-scoped actions pass
 * their business id and are judged against that business's grant.
 *
 * Returns `null` when the caller may proceed, so a call site reads:
 *
 * ```ts
 * const refusal = await authorizeAction(context, { route: '/team' });
 * if (refusal !== null) return refusal;
 * ```
 *
 * The context is supplied by the caller rather than resolved here. A screen already has it, so
 * passing it in costs nothing; and an action that is posted directly resolves it once from the
 * session cookie, which is the same source the page would have used.
 */
export async function authorizeAction(
  context: ViewerContext | null,
  requirements: { readonly route: string; readonly businessId?: string | null },
): Promise<{ readonly ok: false; readonly error: string } | null> {
  const resolved = context ?? (await contextFromSession());
  if (resolved === null) return { ok: false, error: 'Your session has expired. Sign in again.' };

  if (routeAccessDecision(resolved, requirements).allowed) return null;

  // One message for every refusal. Naming the missing permission would tell a caller which
  // capability to go looking for, and the difference between "you may not" and "that does not
  // exist" is itself a disclosure.
  return { ok: false, error: 'You do not have permission to do that.' };
}

/**
 * Builds a viewer context for an action that was posted without its page.
 *
 * Reuses `loadViewerContext` so the action sees exactly the permissions the page would have had.
 * A signed-out caller is redirected to the login screen — the same response the page gives — which
 * surfaces to the action's `useActionState` as a navigation rather than a silent failure.
 */
async function contextFromSession(): Promise<ViewerContext | null> {
  const viewer = await currentViewer();
  if (viewer === null) redirect('/login');
  const { loadViewerContext } = await import('./viewer-context');
  return loadViewerContext();
}
