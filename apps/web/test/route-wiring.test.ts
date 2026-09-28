/**
 * Route and link wiring.
 *
 * This suite exists because the browser suite could only prove the screens it knew to visit. The
 * Preview exposed two classes of defect that page-structure assertions never touch:
 *
 *   * a physical page at one path while navigation, authorization and callers used another name
 *     (the user Trash screen lived at `/trash` behind a guard that named `/trash`, which was not a
 *     declared route — the guard fails closed, so the screen answered 404 to everybody and the
 *     `/my-trash` entry in the navigation led straight into it);
 *   * links to screens that do not exist (`/leads/<id>`, `/automations`), which no amount of
 *     rendering each page in isolation can reveal, because the defect is in the *edge*, not the
 *     node.
 *
 * So this test builds the inventory from the filesystem and compares it with the published
 * contract: every physical page against `ROUTE_PERMISSIONS`, every navigation entry against both,
 * and every internal destination in the source against the set of pages that exist. It is
 * deliberately exhaustive rather than sampled — "every internal destination ends as PASS" is only a
 * meaningful claim if something checks all of them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { ADMIN_NAV_FLAT, ROUTE_PERMISSIONS, USER_NAV, isAliasRoute, routeAccessAllowed } from '@nexus/core';
import type { Permission, UserBusinessGrant } from '@nexus/core';
import { describe, expect, it } from 'vitest';

const APP_DIR = path.resolve(import.meta.dirname, '..', 'src', 'app');
const SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');

/* ------------------------------------------------------------- inventory -- */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** `/b/[slug]/leads/[id]/page.tsx` -> `/b/[slug]/leads/[id]`, route groups removed. */
function pagePattern(file: string): string {
  const segments = path
    .relative(APP_DIR, file)
    .split(path.sep)
    .slice(0, -1)
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
  return `/${segments.join('/')}`;
}

/**
 * Segment-wise match, treating `:name` and `[name]` as "any single segment".
 *
 * This is what makes a physical `/b/[slug]/setup/icps` comparable with the declared
 * `/b/:businessSlug/setup/icps`, and a link to `/b/zemnas/setup/icps` comparable with either.
 */
function segments(value: string): string[] {
  return value.split('/').filter((segment) => segment.length > 0);
}

function isPlaceholder(segment: string): boolean {
  return segment.startsWith(':') || (segment.startsWith('[') && segment.endsWith(']'));
}

function matches(pattern: string, target: string): boolean {
  const a = segments(pattern);
  const b = segments(target);
  if (a.length !== b.length) return false;
  return a.every((segment, index) => isPlaceholder(segment) || segment === b[index]);
}

/**
 * The static shape of a destination found in source.
 *
 * A template literal is reduced to placeholders: each `${...}` hole becomes a single wildcard
 * segment, whether it is a bare variable or a call like
 * `${formString(formData, 'businessSlug', '')}`. The question this test asks is only "does a page
 * exist at this shape", which is exactly what a wildcard can answer.
 */
function shapeOf(destination: string): string {
  // The path only: a query string or fragment is not part of which page answers.
  const withoutQuery = destination.split(/[?#]/)[0];
  return withoutQuery.replace(/\$\{[^}]*\}/g, '*').replace(/\/+$/, '');
}

/** Blanks out comments so a path mentioned in prose is not read as a link. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageFiles = walk(APP_DIR).filter((file) => file.endsWith(`page.tsx`));
const physicalPages = pageFiles.map(pagePattern);
const pageSources = new Map(pageFiles.map((file) => [pagePattern(file), readFileSync(file, 'utf8')]));

/**
 * The source of the page that renders a declared route.
 *
 * A declared route is a pattern (`/b/:businessSlug/setup/icps`) and a physical page is a different
 * pattern (`/b/[slug]/setup/icps`), so a lookup by exact string silently skips every dynamic screen —
 * which is most of them. Everything below resolves through this so a check cannot quietly cover
 * only the static routes.
 */
function sourceFor(route: string): string | undefined {
  for (const [physical, source] of pageSources) {
    if (matches(physical, route) || matches(route, physical)) return source;
  }
  return undefined;
}

const appRoutes = ROUTE_PERMISSIONS.filter((requirement) => requirement.route.startsWith('/'));
const canonicalRoutes = appRoutes.filter((requirement) => !isAliasRoute(requirement));

/** Every page that exists, as a pattern, plus the aliases that stand in for one. */
function pageExistsFor(route: string): boolean {
  return physicalPages.some((physical) => matches(physical, route) || matches(route, physical));
}

/**
 * A page that only redirects.
 *
 * The marker is the `Promise<never>` return type every alias in this codebase declares, plus a
 * `redirect(` call. It is checked rather than guessed from "does it read the viewer context",
 * because an alias legitimately reads the context to resolve the lead it is forwarding to.
 */
function isRedirectOnly(route: string): boolean {
  const source = sourceFor(route);
  if (source === undefined) return false;
  return source.includes('redirect(') && /Promise<never>|\): never\b/.test(source);
}

const GUARD_CALLS = ['requireRouteAccess(', 'canAccessRoute(', 'routeAccessDecision(', 'authorizeAction('];

/** Destination sources: links, client navigation, redirects and revalidations. */
function destinationsIn(file: string): readonly string[] {
  const source = withoutComments(readFileSync(file, 'utf8'));
  const patterns = [
    // Plain string literals.
    /href=(?:"|')(\/[^"'#?]*)/g,
    /router\.push\((?:"|')(\/[^"'#?]*)/g,
    /redirect\((?:"|')(\/[^"'#?]*)/g,
    /revalidatePath\((?:"|')(\/[^"'#?]*)/g,
    // Template literals are captured whole, so a hole that contains its own commas and quoted
    // arguments is read as one destination instead of being cut off at the first quote.
    /href=\{`([^`]*)`/g,
    /router\.push\(`([^`]*)`/g,
    /redirect\(`([^`]*)`/g,
    /revalidatePath\(`([^`]*)`/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('/')) found.push(match[1]);
    }
  }
  return found;
}

const sourceFiles = walk(SRC_DIR).filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));

interface Destination {
  readonly value: string;
  readonly shape: string;
  readonly from: string;
}

const destinations: readonly Destination[] = sourceFiles.flatMap((file) =>
  destinationsIn(file).map((value) => ({
    value,
    shape: shapeOf(value),
    from: path.relative(SRC_DIR, file),
  })),
);

/**
 * Paths that are deliberately not pages: API routes, Next.js internals, and a dynamic-route
 * revalidation pattern that Next.js documents for `revalidatePath(path, 'page')`.
 */
function isIntentionalNonPage(shape: string): boolean {
  return (
    shape.startsWith('/api/') ||
    shape.startsWith('/_next/') ||
    shape.includes('[') // a route *pattern* handed to revalidatePath, e.g. /b/[slug]/automations
  );
}

/** Every destination the sidebar and the user navigation offer. */
const navRoutes: readonly string[] = [
  ...ADMIN_NAV_FLAT.map((item) => item.route),
  ...USER_NAV.flatMap((section) => section.items.map((item) => item.route)),
];

describe('physical pages and the declared route matrix', () => {
  it('declares every page that exists', () => {
    const undeclared = physicalPages.filter((page) => {
      // An alias page and a canonical page are both declared; a page with no entry at all is the
      // defect this asserts against.
      return !appRoutes.some((requirement) => matches(requirement.route, page) || matches(page, requirement.route));
    });
    expect(undeclared, `pages with no ROUTE_PERMISSIONS entry: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('has a page for every declared application route', () => {
    const orphans = appRoutes.filter((requirement) => !pageExistsFor(requirement.route));
    expect(
      orphans.map((requirement) => requirement.route),
      'declared routes with no page: a link to one of these is a dead link',
    ).toEqual([]);
  });

  it('points every alias at a declared, non-alias route', () => {
    const aliases = appRoutes.filter(isAliasRoute);
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      const target = appRoutes.find((requirement) => requirement.route === alias.aliasOf);
      expect(target, `${alias.route} aliases ${String(alias.aliasOf)}, which is not declared`).toBeDefined();
      expect(target !== undefined && isAliasRoute(target), `${alias.route} aliases another alias`).toBe(false);
      expect(target !== undefined && pageExistsFor(target.route), `${alias.route} aliases a dead route`).toBe(true);
      // An alias is a page that redirects; a second implementation under another name is the drift
      // this whole audit exists to prevent.
      expect(isRedirectOnly(alias.route), `${alias.route} is declared as an alias but redirects nowhere`).toBe(true);
    }
  });

  it('guards every page that declares a permission requirement', () => {
    const unguarded: string[] = [];
    let checked = 0;
    for (const requirement of appRoutes) {
      if (requirement.permissions.length === 0) continue;
      const source = sourceFor(requirement.route);
      if (source === undefined) continue;
      checked += 1;
      if (GUARD_CALLS.some((call) => source.includes(call))) continue;
      if (isRedirectOnly(requirement.route)) continue;
      unguarded.push(requirement.route);
    }
    // A positive count, so a resolution bug cannot turn this into a check of nothing.
    expect(checked, 'no pages were inspected for a guard').toBeGreaterThan(30);
    expect(unguarded, `pages with no route guard: ${unguarded.join(', ')}`).toEqual([]);
  });

  it('names the route it is declared under, not a sibling', () => {
    // A page whose guard names a different pattern than its own path is the `/trash` defect: the
    // guard consults the matrix for a route that is not there and fails closed.
    const mismatched: string[] = [];
    for (const [route, source] of pageSources) {
      for (const match of source.matchAll(/route: '(\/[^']*)'/g)) {
        const named = match[1];
        const declaredForNamed = appRoutes.find((requirement) => requirement.route === named);
        if (declaredForNamed === undefined) {
          mismatched.push(`${route} guards an undeclared route ${named}`);
          continue;
        }
        if (isAliasRoute(declaredForNamed)) continue; // an alias guards its canonical requirement
        if (!matches(route, named)) mismatched.push(`${route} guards ${named}`);
      }
    }
    expect(mismatched, mismatched.join('; ')).toEqual([]);
  });
});

describe('navigation and the matrix agree', () => {
  it('declares every navigation destination', () => {
    const undeclared = navRoutes.filter(
      (route) => !appRoutes.some((requirement) => requirement.route === route),
    );
    expect(undeclared, `navigation items with no route entry: ${undeclared.join(', ')}`).toEqual([]);
  });

  it('gives every navigation destination a page', () => {
    const dead = navRoutes.filter((route) => !pageExistsFor(route));
    expect(dead, `navigation items without a page: ${dead.join(', ')}`).toEqual([]);
  });

  it('gives every navigation item the same permission its route declares', () => {
    const drift: string[] = [];
    for (const item of ADMIN_NAV_FLAT) {
      const requirement = appRoutes.find((candidate) => candidate.route === item.route);
      if (requirement === undefined) continue;
      const declared = requirement.permissions.length === 1 ? requirement.permissions[0] : null;
      if (declared !== null && item.permission !== declared) {
        drift.push(`${item.route}: nav says ${String(item.permission)}, matrix says ${declared}`);
      }
    }
    expect(drift, drift.join('; ')).toEqual([]);
  });
});

describe('internal destinations', () => {
  it('reports the inventory it checked, for the audit document', () => {
    // Printed by the runner so the numbers in `docs/V1_2_ROUTE_WIRING_AUDIT.md` are produced by this
    // test rather than counted by hand.
    console.log(
      [
        `route inventory: ${String(physicalPages.length)} physical pages`,
        `${String(appRoutes.length)} permission entries (${String(appRoutes.filter(isAliasRoute).length)} aliases)`,
        `${String(new Set(destinations.map((entry) => entry.shape)).size)} distinct internal destination shapes`,
        `${String(destinations.length)} destination occurrences`,
        `${String(navRoutes.length)} navigation entries`,
      ].join(', '),
    );
    expect(physicalPages.length).toBeGreaterThan(40);
  });

  it('finds destinations to check, so an empty scan cannot pass silently', () => {
    expect(destinations.length).toBeGreaterThan(50);
  });

  it('resolves every internal destination to a page that exists', () => {
    const dead = destinations
      .filter((destination) => !isIntentionalNonPage(destination.shape) && destination.shape.startsWith('/'))
      .filter((destination) => !pageExistsFor(destination.shape))
      .map((destination) => `${destination.value} (from ${destination.from})`);

    expect(
      [...new Set(dead)],
      'these destinations have no page: a click on one of them is a 404',
    ).toEqual([]);
  });

  it('does not link to the old V1.1 lead shape', () => {
    // `/leads/:id` and `/leads/:id/edit` were the pre-canonical paths. The detail is
    // `/b/:slug/leads/:id` (with `/my-leads/:id` as the user alias) and the edit screen is
    // `/b/:slug/leads/:id/edit`. A raw `/leads/...` link is the defect, whatever it resolves to.
    const legacy = destinations
      .filter((destination) => /^\/leads\//.test(destination.shape))
      .filter((destination) => destination.shape !== '/leads/*/edit')
      .map((destination) => `${destination.value} (from ${destination.from})`);
    expect([...new Set(legacy)], 'links to the old slug-less lead paths').toEqual([]);
  });

  it('does not link to a business screen without its business', () => {    /**
     * Every one of these is a business-scoped screen, so a destination equal to the bare name can
     * only be a hard-coded guess or a missing slug.
     *
     * `/trash` is deliberately absent from the list: it is a *user* route (the alias for
     * `/my-trash`), and the business Trash screen is `/b/:businessSlug/trash`. The distinction is
     * exactly the sort of thing this audit exists to keep straight, so it is written down rather
     * than left to the reader.
     */
    const businessScreens = [
      'overview',
      'leads',
      'setup',
      'agent-jobs',
      'insights',
      'automations',
      'profile-queue',
      'duplicates',
      'reactivation',
      'lead-sources',
    ];
    const offenders = destinations
      .filter((destination) => businessScreens.some((screen) => destination.shape === `/${screen}`))
      .map((destination) => `${destination.value} (from ${destination.from})`);
    expect([...new Set(offenders)], 'business-scoped destinations without a business').toEqual([]);
  });
});

/**
 * The audit table, generated from the same matrix the guard uses.
 *
 * `docs/V1_2_ROUTE_WIRING_AUDIT.md` carries this table. Printing it here rather than writing it by
 * hand means the document cannot drift from the code, and the two access columns are *decisions*
 * (`routeAccessAllowed`), not a hand-written claim about what the guard does.
 */
describe('the audit table', () => {
  const BUSINESS_ID = 'a0000000-0000-4000-8000-000000000001';

  const admin = { kind: 'user', userId: 'admin-1', role: 'admin' } as const;
  const restricted = { kind: 'user', userId: 'restricted-1', role: 'user' } as const;

  /** A `user`-level grant with every capability boolean off — the crawl's restricted operator. */
  const restrictedGrant: UserBusinessGrant = {
    businessId: BUSINESS_ID,
    accessLevel: 'user',
    canManageLeads: false,
    canUseLeadSources: false,
    canUseProfileQueue: false,
    canDeleteLeads: false,
  };

  function decide(actor: typeof admin | typeof restricted, route: string, scoped: boolean) {
    const role = actor.role;
    const grants = role === 'admin' ? [] : [restrictedGrant];
    return routeAccessAllowed({
      actor,
      role,
      grants,
      unionPermissions: new Set<Permission>(),
      pathOrPattern: route,
      ...(scoped ? { businessId: BUSINESS_ID } : {}),
    });
  }

  it('allows a grantless administrator on every declared screen', () => {
    const refused: string[] = [];
    for (const requirement of appRoutes) {
      if (requirement.permissions.length === 0) continue;
      const decision = decide(admin, requirement.route, requirement.route.startsWith('/b/:'));
      if (!decision.allowed) refused.push(`${requirement.route} (${decision.reason})`);
    }
    expect(refused, `a grantless administrator was refused: ${refused.join(', ')}`).toEqual([]);
  });

  it('refuses the restricted operator on every administration screen', () => {
    /**
     * The contract a `user`-level operator must satisfy, written as an explicit list rather than
     * derived from the same permission sets the guard consults: "no business/ICP/sequence/knowledge
     * configuration, no team or platform administration" (spec `roles_and_permissions.user.cannot`).
     * A derived list would agree with the code by construction and prove nothing.
     */
    const mustBeRefused = [
      '/b/:businessSlug/overview',
      '/b/:businessSlug/leads',
      '/b/:businessSlug/leads/:leadId',
      '/b/:businessSlug/setup',
      '/b/:businessSlug/setup/brain',
      '/b/:businessSlug/setup/icps',
      '/b/:businessSlug/setup/sequences',
      '/b/:businessSlug/setup/knowledge',
      '/b/:businessSlug/setup/signals',
      '/b/:businessSlug/setup/ai',
      '/b/:businessSlug/agent-jobs',
      '/b/:businessSlug/insights',
      '/b/:businessSlug/insights/messaging',
      '/b/:businessSlug/automations',
      '/team',
      '/team/:userId',
      '/team/:userId/permissions',
      '/settings',
      '/identities',
      '/identities/:identityId',
      '/integrations',
      '/businesses',
      '/businesses/new',
      '/business-domains',
    ];

    const reached = mustBeRefused.filter(
      (route) => decide(restricted, route, route.startsWith('/b/:')).allowed,
    );
    expect(reached, `the restricted operator reached: ${reached.join(', ')}`).toEqual([]);

    // The mirror image: the work surfaces a user *does* hold must not be collateral damage.
    const mustBeAllowed = [
      '/my-day',
      '/my-day/upcoming',
      '/my-day/done',
      '/my-leads',
      '/my-leads/:leadId',
      '/my-leads/:leadId/edit',
      '/my-leads/:leadId/task',
      '/my-leads/:leadId/snooze',
      '/my-lead-sources',
      '/my-lead-sources/file',
      '/my-profile-queue',
      '/my-duplicates',
      '/my-trash',
      '/trash',
      '/tasks/new',
      '/snooze',
      '/leads/:leadId/edit',
    ];
    const refused = mustBeAllowed.filter(
      (route) => !decide(restricted, route, route.startsWith('/b/:')).allowed,
    );
    expect(refused, `the restricted operator was refused their own work screens: ${refused.join(', ')}`).toEqual([]);
  });

  it('prints the table', () => {
    const rows = appRoutes.map((requirement) => {
      const scoped = requirement.route.startsWith('/b/:');
      const adminDecision = decide(admin, requirement.route, scoped);
      const restrictedDecision = decide(restricted, requirement.route, scoped);
      const physical = physicalPages.find(
        (page) => matches(page, requirement.route) || matches(requirement.route, page),
      );
      return [
        requirement.route,
        physical ?? '(none)',
        requirement.aliasOf ?? '—',
        requirement.permissions.length === 0 ? '—' : requirement.permissions.join(' + '),
        scoped ? 'yes' : 'no',
        requirement.permissions.length === 0 ? 'n/a' : adminDecision.allowed ? 'PASS' : `FAIL (${adminDecision.reason})`,
        restrictedDecision.allowed ? 'allowed' : 'refused',
      ].join(' | ');
    });
    console.log(['route | page | aliasOf | permission | scoped | admin(no grant) | restricted', ...rows].join('\n'));
    expect(rows.length).toBe(appRoutes.length);
  });
});
