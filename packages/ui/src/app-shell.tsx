/**
 * Application chrome for the Next.js surfaces (admin + user).
 *
 * The sidebar is data-driven from `ADMIN_NAV` / `USER_NAV` in `@nexus/core`, so a
 * route can never appear in the navigation without also declaring the permission
 * that gates it — navigation and authorization cannot drift apart.
 */
import type { ReactElement, ReactNode } from 'react';

import type { NavItem } from '@nexus/core';

import { Button, Row, cx } from './primitives.js';

export interface NavSection {
  readonly group: string;
  readonly items: readonly NavItem[];
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
  readonly businesses?: readonly BusinessOption[];
  readonly onSelectBusiness?: (businessId: string) => void;
  readonly onNavigate: (route: string) => void;
  readonly topbar?: ReactNode;
  readonly children: ReactNode;
  readonly userLabel?: string;
  readonly onSignOut?: () => void;
}

/**
 * Substitutes the route parameters a nav entry may contain. Entries whose
 * required parameter is unknown are dropped rather than rendered as a dead link.
 */
function resolveRoute(route: string, businessSlug: string | undefined): string | null {
  if (!route.includes(':businessSlug')) return route;
  if (businessSlug === undefined || businessSlug.length === 0) return null;
  return route.replace(':businessSlug', businessSlug);
}

export function AppShell({
  surface,
  nav,
  activeRoute,
  businessSlug,
  businesses,
  onSelectBusiness,
  onNavigate,
  topbar,
  children,
  userLabel,
  onSignOut,
}: AppShellProps): ReactElement {
  const userNav = surface === 'user'
    ? [{
        group: 'My workspace',
        items: nav
          .flatMap((section) => section.items)
          .filter((item) =>
            item.label === 'My Day' || item.label === 'My Leads' || item.label === 'Lead Sources',
          ),
      }]
    : nav;

  const sections = userNav
    .map((section) => ({
      group: section.group,
      items: section.items
        .map((item) => ({ item, href: resolveRoute(item.route, businessSlug) }))
        .filter((entry): entry is { item: NavItem; href: string } => entry.href !== null),
    }))
    .filter((section) => section.items.length > 0);

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
              value={businesses.find((b) => b.slug === businessSlug)?.id ?? ''}
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
                const active = activeRoute === href || activeRoute.startsWith(`${href}/`);
                return (
                  <li key={href}>
                    <a
                      className="nx-nav__item"
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      onClick={(event) => {
                        // Client-side navigation keeps the shell mounted (and the
                        // Companion-like list state intact); the href remains for
                        // middle-click, copy-link and no-JS access.
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
                const base = businessSlug === undefined ? '/my-leads' : `/b/${businessSlug}/leads`;
                onNavigate(value.length === 0 ? base : `${base}?q=${encodeURIComponent(value)}`);
              }}
            />
          )}
          <span className="nx-topbar__spacer" />
          {surface === 'admin' && <span className="nx-topbar__context">Admin workspace</span>}
        </header>

        <main className="nx-content" id="nx-content">
          {children}
        </main>
      </div>
    </div>
  );
}

/** Compact breadcrumb used by detail screens. */
export function Breadcrumbs({
  items,
  onNavigate,
}: {
  readonly items: readonly { readonly label: string; readonly route?: string }[];
  readonly onNavigate: (route: string) => void;
}): ReactElement {
  return (
    <Row>
      {items.map((item, index) => (
        <Row key={`${item.label}-${String(index)}`}>
          {index > 0 && <span className="nx-hint">/</span>}
          {item.route === undefined ? (
            <span className="nx-hint">{item.label}</span>
          ) : (
            <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => onNavigate(item.route as string)}>
              {item.label}
            </button>
          )}
        </Row>
      ))}
    </Row>
  );
}
