'use client';

import type { ReactElement, ReactNode } from 'react';

import { AppShell, type BusinessOption, type NavSection, type SecondaryNavItem } from '@nexus/ui';
import { usePathname, useRouter } from 'next/navigation';

import { signOutAction } from '@/app/login/actions';

/**
 * Client shell around `AppShell`.
 *
 * Kept as a thin client boundary so navigation stays instant (no full document
 * reload between screens, which would discard list state) while every screen
 * remains a server component that reads through RLS.
 */
export function Shell({
  surface,
  nav,
  secondaryNav,
  businessSlug,
  businesses,
  userLabel,
  children,
}: {
  readonly surface: 'admin' | 'user';
  readonly nav: readonly NavSection[];
  /**
   * The business operational surfaces (spec §73.2), already resolved and permission-filtered by
   * the business layout. Passed through untouched: the shell is a client boundary and must not
   * be the place where visibility is decided.
   */
  readonly secondaryNav?: readonly SecondaryNavItem[];
  readonly businessSlug?: string;
  readonly businesses: readonly BusinessOption[];
  readonly userLabel: string;
  readonly children: ReactNode;
}): ReactElement {
  const router = useRouter();
  const pathname = usePathname();

  /**
   * The business used to resolve sidebar links on screens that are not themselves business-scoped.
   *
   * `businesses` is the switcher list, which already honours the viewer's grants, so its first
   * *real* entry is a business this operator can actually reach. Substituting it keeps the full
   * seven-destination sidebar visible on `/`, `/team`, `/integrations` and the user surfaces.
   *
   * The roll-up is skipped. For an administrator the switcher's first entry is "All Businesses",
   * whose slug is a placeholder (`__all__`) with no screens behind it — substituting it produced
   * `/b/__all__/overview` and `/b/__all__/insights` links that answered 404 from every global screen.
   * The roll-up stays in the dropdown; it is simply never used as a route segment.
   */
  const defaultBusiness = businesses.find((business) => business.isRollUp !== true) ?? businesses[0];
  const effectiveSlug = businessSlug ?? defaultBusiness?.slug;

  return (
    <AppShell
      surface={surface}
      nav={nav}
      {...(secondaryNav === undefined ? {} : { secondaryNav })}
      activeRoute={pathname}
      {...(businessSlug === undefined ? {} : { businessSlug })}
      {...(effectiveSlug === undefined ? {} : { defaultBusinessSlug: effectiveSlug })}
      businesses={businesses}
      onSelectBusiness={(businessId) => {
        const target = businesses.find((business) => business.id === businessId);
        if (target === undefined) return;
        /**
         * The roll-up has no screens of its own, so choosing it lands on the admin hub that lists
         * every business rather than on a `/b/__all__/...` route that does not exist.
         */
        if (target.isRollUp === true) {
          router.push('/businesses');
          return;
        }
        // Swap the slug segment in place, so the operator keeps their position in
        // the same screen when switching business context.
        const next = businessSlug === undefined
          ? `/b/${target.slug}/overview`
          : pathname.replace(`/b/${businessSlug}`, `/b/${target.slug}`);
        router.push(next);
      }}
      onNavigate={(route) => router.push(route)}
      userLabel={userLabel}
      onSignOut={() => {
        void signOutAction();
      }}
    >
      {children}
    </AppShell>
  );
}
