/**
 * Application chrome for the Next.js surfaces (admin + user).
 *
 * The sidebar is data-driven from `ADMIN_NAV` / `USER_NAV` in `@nexus/core`, so a route can never
 * appear in the navigation without also declaring the permission that gates it — navigation and
 * authorization cannot drift apart.
 *
 * Two rules here are load-bearing, and both were violated by an earlier implementation:
 *
 *  1. **Never look a destination up by its display label.** Resolving nav entries by matching
 *     `item.label` against a hard-coded string silently drops the entry the moment a label is
 *     reworded, which is how a seven-destination sidebar collapsed to three on non-business-scoped
 *     routes. The tree is fixed here; only *visibility* is filtered, and by permission.
 *  2. **Never render a dead section.** A destination whose `:businessSlug` cannot be resolved is
 *     dropped from the sidebar (it would be a dead link), but that can only happen when the viewer
 *     has no business at all. Every parent keeps its children, so the nested modules stay reachable
 *     through the secondary tab strip rather than being orphaned.
 */
import type { ReactElement, ReactNode } from 'react';

import type { NavItem } from '@nexus/core';

import { Button, cx } from './primitives.js';

export interface NavSection {
  readonly group: string;
  readonly items: readonly NavItem[];
}

/**
 * One entry of the secondary navigation that the host supplies itself.
 *
 * `ADMIN_NAV` covers the nested modules of the seven sidebar destinations, but the V1.2
 * operational surfaces (Agent Jobs, Channel Accounts, AI, Automations, Imports, Access —
 * spec §73.2) are not all in it: Agent Jobs and AI are new routes, and two of the six are not
 * business-scoped. The host resolves them — existence, and the permission of the route each one
 * declares — and passes the surviving ones here. The shell never decides visibility itself, and
 * never renders an entry whose route the viewer may not open.
 */
export interface SecondaryNavItem {
  readonly label: string;
  readonly href: string;
}

export interface BusinessOption {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface AppShellProps {
  /** `admin` widens the sidebar per spec layout_notes.admin_sidebar_width_approx. */
  readonly surface: 'admin' | 'user';
  readonly nav: readonly NavSection[];
  readonly activeRoute: string;
  /** Replaces the `:businessSlug` token in nav routes. */
  readonly businessSlug?: string;
  /**
   * The slug to substitute when the current route is not itself business-scoped.
   *
   * Without this, every business-scoped sidebar entry drops out on `/`, `/team`, `/integrations`
   * and the user surfaces, because there is no slug to substitute and a nav entry is never rendered
   * as a dead link. That is how a seven-destination sidebar silently became three. A viewer who can
   * reach at least one business always has a coherent default, so the full navigation renders
   * everywhere and the business switcher reflects the same context.
   */
  readonly defaultBusinessSlug?: string;
  readonly businesses?: readonly BusinessOption[];
  readonly onSelectBusiness?: (businessId: string) => void;
  readonly onNavigate: (route: string) => void;
  /**
   * Extra secondary destinations, already resolved and permission-filtered by the host.
   *
   * Appended to the active destination's own tabs, deduplicated by href, so a surface that is
   * both a nested module and an operational entry (Automations, Imports) appears once.
   */
  readonly secondaryNav?: readonly SecondaryNavItem[];
  readonly topbar?: ReactNode;
  readonly children: ReactNode;
  readonly userLabel?: string;
  readonly onSignOut?: () => void;
}

/**
 * Substitutes the route parameters a nav entry may contain.
 *
 * `:businessSlug` is the only parameter the sidebar can supply. A `:userId` child (the per-user
 * permissions screen) has no single sensible value from the sidebar, so it is resolved to the
 * people list, which is where a viewer picks the user whose permissions they want to edit.
 */
function resolveRoute(
  route: string,
  businessSlug: string | undefined,
  activeRoute: string,
): string | null {
  let resolved = route;
  if (resolved.includes(':businessSlug')) {
    if (businessSlug === undefined || businessSlug.length === 0) return null;
    resolved = resolved.replace(':businessSlug', businessSlug);
  }
  if (resolved.includes(':userId')) {
    // The concrete user is only known while editing that user; otherwise send the viewer to the
    // team list. That keeps the destination reachable instead of rendering a dead `/team//permissions`.
    const match = /^\/team\/([^/]+)\/permissions/.exec(activeRoute);
    resolved = resolved.replace(':userId', match?.[1] ?? '');
    if (resolved.includes('/team//')) return null;
  }
  return resolved;
}

/** A resolved navigation entry. */
interface ResolvedItem {
  readonly item: NavItem;
  readonly href: string;
  readonly children: readonly { readonly item: NavItem; readonly href: string }[];
}

export function AppShell({
  surface,
  nav,
  activeRoute,
  businessSlug,
  defaultBusinessSlug,
  businesses,
  onSelectBusiness,
  onNavigate,
  secondaryNav,
  topbar,
  children,
  userLabel,
  onSignOut,
}: AppShellProps): ReactElement {
  // The slug actually used for link resolution: the route's own business when it is business-scoped,
  // otherwise the viewer's default. This single line is what keeps the sidebar stable across every
  // screen instead of collapsing on the non-business-scoped ones.
  const effectiveSlug = businessSlug ?? defaultBusinessSlug;

  const userNav =
    surface === 'user'
      ? [
          {
            group: 'My workspace',
            items: nav
              .flatMap((section) => section.items)
              .filter(
                (item) =>
                  item.label === 'My Day' || item.label === 'My Leads' || item.label === 'Lead Sources',
              ),
          },
        ]
      : nav;

  const resolveChildren = (
    item: NavItem,
  ): readonly { readonly item: NavItem; readonly href: string }[] =>
    (item.children ?? []).flatMap((entry) => {
      const href = resolveRoute(entry.route, effectiveSlug, activeRoute);
      return href === null ? [] : [{ item: entry, href }];
    });

  const sections = userNav
    .map((section) => ({
      group: section.group,
      items: section.items.flatMap((item): ResolvedItem[] => {
        const href = resolveRoute(item.route, effectiveSlug, activeRoute);
        // An item with children whose own route cannot be resolved (a `:userId` child with no
        // context) still renders, anchored at its first resolvable child, so the group of
        // destinations is never lost.
        const children = resolveChildren(item);
        if (href === null) {
          const first = children[0];
          return first === undefined ? [] : [{ item, href: first.href, children }];
        }
        return [{ item, href, children }];
      }),
    }))
    .filter((section) => section.items.length > 0);

  /**
   * The active top-level entry, used for both highlighting and the secondary tab strip.
   *
   * Longest-prefix match, so `/b/zemnas/setup/icps` selects *Business Setup* rather than also
   * matching a shorter `/b/zemnas` prefix.
   */
  const activeItem = sections
    .flatMap((section) => section.items)
    .filter((entry) => activeRoute === entry.href || activeRoute.startsWith(`${entry.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  const secondary = activeItem?.children.filter((child) => child.href !== activeItem.href) ?? [];

  /**
   * The strip actually rendered: the active destination's own tabs, then the host's operational
   * surfaces, deduplicated by href.
   *
   * Deduplication matters because the two sources overlap by design: Automations and the Import
   * Builder are nested modules *and* operational entries, and rendering them twice would put two
   * links to one screen in one strip. The nested module wins, because it is the one the section's
   * own IA names.
   */
  const strip: readonly { readonly label: string; readonly href: string }[] = [
    ...secondary.map((child) => ({ label: child.item.label, href: child.href })),
    ...(secondaryNav ?? []),
  ].filter((entry, index, all) => all.findIndex((other) => other.href === entry.href) === index);

  /**
   * The one current destination, by longest matching prefix.
   *
   * Longest-prefix rather than "has this prefix": `/b/zemnas/setup` is a prefix of
   * `/b/zemnas/setup/icps`, so a naive check would mark two tabs current at once and the strip
   * would stop telling the operator where they are. Exact matches and sub-routes both resolve,
   * so a tab stays current while the operator is inside the screen it names.
   */
  const currentHref = strip
    .filter((entry) => activeRoute === entry.href || activeRoute.startsWith(`${entry.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <div className="nx-app">
      <a className="nx-skip-link" href="#nx-content">
        Skip to content
      </a>

      <nav className={cx('nx-sidebar', surface === 'admin' && 'nx-sidebar--admin')} aria-label="Primary">
        <div className="nx-sidebar__brand">
          <span className="nx-sidebar__wordmark">Nexus</span>
        </div>

        {surface === 'admin' && businesses !== undefined && businesses.length > 0 && (
          <div className="nx-sidebar__section">
            <p className="nx-sidebar__eyebrow">Lead intelligence</p>
            <label className="nx-sidebar__group-label" htmlFor="nx-business-switcher">
              Business
            </label>
            <select
              id="nx-business-switcher"
              className="nx-select"
              value={businesses.find((b) => b.slug === effectiveSlug)?.id ?? ''}
              onChange={(event) => onSelectBusiness?.(event.target.value)}
            >
              {businesses.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {sections.map((section) => (
          <div className="nx-sidebar__section" key={section.group}>
            <p className="nx-sidebar__group-label">{section.group}</p>
            <ul className="nx-nav">
              {section.items.map(({ item, href }) => {
                const active = activeItem?.href === href;
                return (
                  <li key={`${item.label}-${href}`}>
                    <a
                      className="nx-nav__item"
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      onClick={(event) => {
                        // Client-side navigation keeps the shell mounted (and the Companion-like list
                        // state intact); the href remains for middle-click, copy-link and no-JS access.
                        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                        event.preventDefault();
                        onNavigate(href);
                      }}
                    >
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {surface === 'user' && (
          <div className="nx-sidebar__section nx-sidebar__search">
            <label className="nx-sidebar__group-label" htmlFor="nx-user-search">
              Search
            </label>
            <input
              id="nx-user-search"
              className="nx-input"
              type="search"
              placeholder="Search leads..."
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const value = event.currentTarget.value.trim();
                onNavigate(value.length === 0 ? '/my-leads' : `/my-leads?q=${encodeURIComponent(value)}`);
              }}
            />
          </div>
        )}

        <div className="nx-sidebar__account">
          {userLabel !== undefined && <span className="nx-sidebar__account-name">{userLabel}</span>}
          {onSignOut !== undefined && (
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              Sign out
            </Button>
          )}
        </div>
      </nav>

      <div className="nx-main">
        <header className={cx('nx-topbar', surface === 'user' && 'nx-topbar--user')}>
          {topbar}
          {surface === 'admin' && (
            <input
              className="nx-input nx-topbar__search"
              type="search"
              aria-label="Search Nexus"
              placeholder="Search Nexus..."
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const value = event.currentTarget.value.trim();
                const base = effectiveSlug === undefined ? '/my-leads' : `/b/${effectiveSlug}/leads`;
                onNavigate(value.length === 0 ? base : `${base}?q=${encodeURIComponent(value)}`);
              }}
            />
          )}
          <span className="nx-topbar__spacer" />
          {surface === 'admin' && <span className="nx-topbar__context">Admin workspace</span>}
        </header>

        {/**
         * Secondary navigation.
         *
         * The final Figma Admin IA is two-level: seven sidebar destinations, with the nested
         * modules reached as a strip inside their parent (Business Setup -> ICPs / Sequences /
         * Knowledge / Signals), plus the V1.2 operational surfaces (Agent Jobs, Channel Accounts,
         * AI, Automations, Imports, Access — §73.2). Without this strip those screens would be
         * reachable only by typing a URL.
         *
         * These are **links**, so they are a `<nav>` of anchors with `aria-current="page"`, not a
         * `tablist`: a tab that navigates and has no tabpanel is the wrong pattern for assistive
         * technology (and the V1.1 defect — two links rendering as `Outreach IdentitiesMy Access`
         * — was a presentation bug in a strip that was already semantically fine). Anchors are
         * keyboard reachable, carry the global focus ring, and can be opened in a new tab.
         */}
        {strip.length > 0 && (
          <nav
            className="nx-subnav"
            aria-label={`${activeItem?.item.label ?? 'Business'} sections`}
          >
            {strip.map((entry) => {
              const current = entry.href === currentHref;
              return (
                <a
                  key={entry.href}
                  className="nx-subnav__item"
                  aria-current={current ? 'page' : undefined}
                  href={entry.href}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                    event.preventDefault();
                    onNavigate(entry.href);
                  }}
                >
                  {entry.label}
                </a>
              );
            })}
          </nav>
        )}

        <main className="nx-content" id="nx-content">
          {children}
        </main>
      </div>
    </div>
  );
}

