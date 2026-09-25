/**
 * Route authorization.
 *
 * The rule under test: a screen's declared requirement is enforced against the *right* scope. Two
 * mistakes this pins down, both of which were real in this codebase:
 *
 *   * the route -> permission matrix was exported and read by nothing, so a standard user who typed
 *     an admin URL got a fully rendered page with the forms merely disabled — which also disclosed
 *     the platform's global settings;
 *   * permissions were accumulated across every business an operator can reach. That is right for
 *     the sidebar and wrong for a screen: a manager of one business holding `icp.manage` there would
 *     have been allowed to open another business's ICP manager.
 */
import { describe, expect, it } from 'vitest';

import {
  isBusinessScopedRoute,
  routeAccessAllowed,
  routePermissionsFor,
  type Actor,
  type Permission,
  type UserBusinessGrant,
} from './permissions.js';

const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';

const actor: Actor = { kind: 'user', userId: 'user-1', role: 'manager' };

function grant(overrides: Partial<UserBusinessGrant> & { businessId: string }): UserBusinessGrant {
  return {
    accessLevel: 'manager',
    canManageLeads: true,
    canUseLeadSources: true,
    canUseProfileQueue: true,
    canDeleteLeads: false,
    ...overrides,
  };
}

describe('route permission lookup', () => {
  it('finds a requirement by pattern', () => {
    expect(routePermissionsFor('/settings')?.permissions).toEqual(['settings.manage']);
  });

  it('finds a requirement by concrete path', () => {
    // A guard is often handed the path the browser asked for, not the declared pattern.
    expect(routePermissionsFor('/b/zemnas/setup/icps')?.route).toBe('/b/:businessSlug/setup/icps');
    expect(routePermissionsFor('/identities/abc-123')?.route).toBe('/identities/:identityId');
  });

  it('does not match a path of the wrong depth', () => {
    expect(routePermissionsFor('/b/zemnas/setup')).toBeNull();
    expect(routePermissionsFor('/b/zemnas/setup/icps/extra')).toBeNull();
  });

  it('identifies business-scoped patterns', () => {
    expect(isBusinessScopedRoute('/b/:businessSlug/setup/icps')).toBe(true);
    expect(isBusinessScopedRoute('/settings')).toBe(false);
    expect(isBusinessScopedRoute('/team')).toBe(false);
  });
});

describe('global admin routes', () => {
  it('allows an administrator', () => {
    const decision = routeAccessAllowed({
      actor: { kind: 'user', userId: 'admin-1', role: 'admin' },
      role: 'admin',
      grants: [grant({ businessId: BUSINESS_A, accessLevel: 'admin' })],
      unionPermissions: new Set<Permission>(['settings.manage', 'user.manage', 'business.create']),
      pathOrPattern: '/settings',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('granted');
  });

  it('denies a user whose union carries no admin permission', () => {
    const decision = routeAccessAllowed({
      actor: { kind: 'user', userId: 'user-1', role: 'user' },
      role: 'user',
      grants: [grant({ businessId: BUSINESS_A, accessLevel: 'user' })],
      unionPermissions: new Set<Permission>([]),
      pathOrPattern: '/settings',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('permission_denied');
    expect(decision.permissions).toEqual(['settings.manage']);
  });

  it('denies a route that declares no requirement, rather than allowing it', () => {
    // Failing closed is the point: a new screen that forgot to declare its requirement must not be
    // reachable by default.
    const decision = routeAccessAllowed({
      actor,
      role: 'manager',
      grants: [],
      unionPermissions: new Set<Permission>([]),
      pathOrPattern: '/some/undeclared/screen',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('route_not_declared');
  });
});

describe('business-scoped routes are judged against that business', () => {
  const icpManager = new Set<Permission>(['business.view', 'lead.view_all', 'icp.manage']);

  it('allows the business whose grant confers the permission', () => {
    const decision = routeAccessAllowed({
      actor,
      role: 'manager',
      // `icp.manage` is not a manager default, so it arrives as an extra on business A only.
      grants: [grant({ businessId: BUSINESS_A, extraPermissions: ['icp.manage'] })],
      unionPermissions: icpManager,
      pathOrPattern: '/b/:businessSlug/setup/icps',
      businessId: BUSINESS_A,
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies a sibling business even though the union holds the permission', () => {
    // This is the cross-business escalation: the union has `icp.manage` because business A granted
    // it. Opening business B's ICP manager must still be refused.
    const decision = routeAccessAllowed({
      actor,
      role: 'manager',
      grants: [
        grant({ businessId: BUSINESS_A, extraPermissions: ['icp.manage'] }),
        grant({ businessId: BUSINESS_B }),
      ],
      unionPermissions: icpManager,
      pathOrPattern: '/b/:businessSlug/setup/icps',
      businessId: BUSINESS_B,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('permission_denied');
  });

  it('denies a business the operator has no grant for', () => {
    const decision = routeAccessAllowed({
      actor,
      role: 'manager',
      grants: [grant({ businessId: BUSINESS_A, extraPermissions: ['icp.manage'] })],
      unionPermissions: icpManager,
      pathOrPattern: '/b/:businessSlug/setup/icps',
      businessId: 'business-hidden',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_grant_for_business');
  });

  it('requires a business id for a business-scoped route', () => {
    const decision = routeAccessAllowed({
      actor,
      role: 'manager',
      grants: [grant({ businessId: BUSINESS_A, extraPermissions: ['icp.manage'] })],
      unionPermissions: icpManager,
      pathOrPattern: '/b/:businessSlug/setup/icps',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('business_scope_required');
  });

  it('allows an operator with no extra permissions on a screen their role covers', () => {
    // `lead.view_all` and `sequence.reactivate` are manager defaults, so a manager's own business
    // reach their Operate screens without any per-business override.
    const decision = routeAccessAllowed({
      actor,
      role: 'manager',
      grants: [grant({ businessId: BUSINESS_A })],
      unionPermissions: new Set<Permission>([]),
      pathOrPattern: '/b/:businessSlug/reactivation',
      businessId: BUSINESS_A,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('admin-only permissions cannot be widened', () => {
  it('refuses a non-admin even when a grant lists the permission', () => {
    // `effectivePermissions` clamps ADMIN_ONLY_PERMISSIONS last, so a mis-typed `extraPermissions`
    // entry cannot escalate. The guard inherits that clamp because it derives scoped permissions
    // through the same function.
    const decision = routeAccessAllowed({
      actor: { kind: 'user', userId: 'mgr-1', role: 'manager' },
      role: 'manager',
      grants: [grant({ businessId: BUSINESS_A, extraPermissions: ['settings.manage', 'user.manage'] })],
      unionPermissions: new Set<Permission>([]),
      pathOrPattern: '/settings',
    });
    expect(decision.allowed).toBe(false);
  });

  it('refuses a business-level admin on a global admin route that is not business-scoped', () => {
    // A global route has no business to scope to, so it is judged against the union — and the union
    // for a non-admin cannot contain an admin-only permission.
    const decision = routeAccessAllowed({
      actor: { kind: 'user', userId: 'bizadmin-1', role: 'user' },
      role: 'user',
      grants: [grant({ businessId: BUSINESS_A, accessLevel: 'admin' })],
      unionPermissions: new Set<Permission>([]),
      pathOrPattern: '/team',
    });
    expect(decision.allowed).toBe(false);
  });
});
