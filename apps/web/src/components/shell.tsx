'use client';

import type { ReactElement, ReactNode } from 'react';

import { AppShell, type BusinessOption, type NavSection } from '@nexus/ui';
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
  businessSlug,
  businesses,
  userLabel,
  children,
}: {
  readonly surface: 'admin' | 'user';
  readonly nav: readonly NavSection[];
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
   * `businesses` is the switcher list, which already honours the viewer's grants, so its first entry
   * is a business this operator can actually reach. Substituting it keeps the full seven-destination
   * sidebar visible on `/`, `/team`, `/integrations` and the user surfaces. Without it every
   * business-scoped entry is dropped for want of a slug and the sidebar collapses.
   */
  const effectiveSlug = businessSlug ?? businesses[0]?.slug;

  return (
    <AppShell
      surface={surface}
      nav={nav}
      activeRoute={pathname}
      {...(businessSlug === undefined ? {} : { businessSlug })}
      {...(effectiveSlug === undefined ? {} : { defaultBusinessSlug: effectiveSlug })}
      businesses={businesses}
      onSelectBusiness={(businessId) => {
        const target = businesses.find((business) => business.id === businessId);
        if (target === undefined) return;
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
