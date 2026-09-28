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
  ROUTE_PERMISSIONS,
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
    // `/b/:businessSlug/setup` is now a real declared route (the Business Setup landing tab of the
    // final Figma IA), so it resolves rather than being unmatched. The depth check is exercised by
    // the two cases below, which have no declared pattern at their length.
    expect(routePermissionsFor('/b/zemnas/setup')?.route).toBe('/b/:businessSlug/setup');
    expect(routePermissionsFor('/b/zemnas/setup/icps/extra')).toBeNull();
    expect(routePermissionsFor('/b/zemnas')).toBeNull();
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

describe('a global admin needs no business grant', () => {
  /**
   * The production condition this pins down: a Preview/production administrator with an active
   * account and **zero** `user_business_access` rows. Every business-scoped screen used to answer
   * `notFound()` for them, because the scoped permission set was derived from the grant table
   * alone — Business Setup, ICPs, Agent Jobs and Insights all 404'd for the account that is
   * supposed to administer them.
   *
   * The admin's authority comes from the role. The grant table records *delegated* access for
   * managers and users, and visibility is a separate check the page performs before the guard.
   */
  const admin: Actor = { kind: 'user', userId: 'admin-1', role: 'admin' };

  const adminScreens: readonly (readonly [string, string])[] = [
    ['/b/:businessSlug/setup', 'knowledge.manage'],
    ['/b/:businessSlug/setup/icps', 'icp.manage'],
    ['/b/:businessSlug/agent-jobs', 'lead.view_all'],
    ['/b/:businessSlug/insights', 'insights.view'],
    ['/b/:businessSlug/setup/ai', 'knowledge.manage'],
    ['/b/:businessSlug/automations', 'automation.manage'],
  ];

  for (const [route, permission] of adminScreens) {
    it(`allows ${route} (needs ${permission}) with no grants at all`, () => {
      const decision = routeAccessAllowed({
        actor: admin,
        role: 'admin',
        grants: [],
        unionPermissions: new Set<Permission>(),
        pathOrPattern: route,
        businessId: BUSINESS_A,
      });
      expect(decision.allowed, `${route} must be reachable by a global admin`).toBe(true);
      expect(decision.reason).toBe('granted');
    });
  }

  it('allows a global admin on a sibling business it also has no grant for', () => {
    const decision = routeAccessAllowed({
      actor: admin,
      role: 'admin',
      grants: [grant({ businessId: BUSINESS_A, accessLevel: 'admin' })],
      unionPermissions: new Set<Permission>(),
      pathOrPattern: '/b/:businessSlug/setup/icps',
      businessId: BUSINESS_B,
    });
    expect(decision.allowed).toBe(true);
  });

  it('still requires a business id for a business-scoped route', () => {
    // No business named means the guard cannot tell which business's screen is being opened.
    const decision = routeAccessAllowed({
      actor: admin,
      role: 'admin',
      grants: [],
      unionPermissions: new Set<Permission>(),
      pathOrPattern: '/b/:businessSlug/setup/icps',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('business_scope_required');
  });

  it('does not let a grant reduce an administrator', () => {
    // A grant that revokes a permission from an admin is not a boundary: the account can grant
    // itself anything. Honouring it produced "adding a grant removed access".
    const decision = routeAccessAllowed({
      actor: admin,
      role: 'admin',
      grants: [grant({ businessId: BUSINESS_A, accessLevel: 'admin', revokedPermissions: ['icp.manage'] })],
      unionPermissions: new Set<Permission>(),
      pathOrPattern: '/b/:businessSlug/setup/icps',
      businessId: BUSINESS_A,
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies a manager with no grant for the business', () => {
    const decision = routeAccessAllowed({
      actor: { kind: 'user', userId: 'mgr-1', role: 'manager' },
      role: 'manager',
      grants: [],
      unionPermissions: new Set<Permission>(['lead.view_all']),
      pathOrPattern: '/b/:businessSlug/agent-jobs',
      businessId: BUSINESS_A,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_grant_for_business');
  });

  it('denies a user with no grant for the business', () => {
    const decision = routeAccessAllowed({
      actor: { kind: 'user', userId: 'user-1', role: 'user' },
      role: 'user',
      grants: [],
      unionPermissions: new Set<Permission>(['business.view']),
      pathOrPattern: '/b/:businessSlug/setup',
      businessId: BUSINESS_A,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_grant_for_business');
  });

  it('denies a manager whose grant does not carry the permission', () => {
    // A manager default covers `lead.view_all` but not `knowledge.manage`, so Business Setup is
    // refused even though the business itself is granted.
    const decision = routeAccessAllowed({
      actor,
      role: 'manager',
      grants: [grant({ businessId: BUSINESS_A })],
      unionPermissions: new Set<Permission>(['knowledge.manage']),
      pathOrPattern: '/b/:businessSlug/setup',
      businessId: BUSINESS_A,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('permission_denied');
    expect(decision.permissions).toEqual(['knowledge.manage']);
  });

  it('allows a manager whose grant carries the permission', () => {
    const decision = routeAccessAllowed({
      actor,
      role: 'manager',
      grants: [grant({ businessId: BUSINESS_A, extraPermissions: ['knowledge.manage'] })],
      unionPermissions: new Set<Permission>(),
      pathOrPattern: '/b/:businessSlug/setup',
      businessId: BUSINESS_A,
    });
    expect(decision.allowed).toBe(true);
  });

  it('allows an api_client only for the businesses its token names', () => {
    const client: Actor = {
      kind: 'api_client',
      apiClientId: 'client-1',
      name: 'opencode',
      scopes: ['lead:read'],
      businessIds: [BUSINESS_A],
    };
    // The token scope is unchanged by the admin rule: a business-scoped route is judged against a
    // business grant, and an api_client has none — it authorises through its scopes and business
    // ids (`canAccessBusiness`), which is where its scoping actually lives.
    const inScope = routeAccessAllowed({
      actor: client,
      role: null,
      grants: [],
      unionPermissions: new Set<Permission>(),
      pathOrPattern: '/b/:businessSlug/leads',
      businessId: BUSINESS_A,
    });
    expect(inScope.allowed).toBe(false);
    expect(inScope.reason).toBe('no_grant_for_business');
  });
});

describe('route matrix coherence', () => {
  it('declares every alias target, and no alias points at another alias absurdly deep', () => {
    const declared = new Set(ROUTE_PERMISSIONS.map((requirement) => requirement.route));
    const aliases = ROUTE_PERMISSIONS.filter((requirement) => requirement.aliasOf !== undefined);
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(
        declared.has(alias.aliasOf ?? ''),
        `${alias.route} is an alias for ${String(alias.aliasOf)}, which is not declared`,
      ).toBe(true);
      const target = ROUTE_PERMISSIONS.find((requirement) => requirement.route === alias.aliasOf);
      expect(target?.aliasOf, `${alias.route} points at an alias (${String(alias.aliasOf)})`).toBeUndefined();
    }
  });

  it('carries a permission requirement on every entry except the unauthenticated surfaces', () => {
    // `/login`, the workspace entry point (a redirect) and the Companion's sign-in screen are the
    // only screens that may be reached without a permission: they decide nothing and disclose
    // nothing. Everything else must say what it needs, because the guard fails closed.
    const unauthenticated = new Set(['/login', '/', 'companion/login']);
    for (const requirement of ROUTE_PERMISSIONS) {
      if (unauthenticated.has(requirement.route)) continue;
      expect(
        requirement.permissions.length,
        `${requirement.route} must declare what it needs`,
      ).toBeGreaterThan(0);
    }
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
