import type { ReactNode } from 'react';

import { Shell } from '@/components/shell';
import { loadViewerContext } from '@/lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * Authenticated shell for every non-business-scoped screen (admin hub, team,
 * settings, My Day, …).
 *
 * `Shell` derives a default business from the switcher list so the sidebar keeps
 * its full set of destinations here. Previously no slug was bound at this level, so
 * every business-scoped entry was dropped for want of a slug and the sidebar
 * collapsed to the handful of global routes; the `/b/[slug]` layout supplies the
 * real slug for the business-scoped screens.
 */
export default async function AppLayout({ children }: { readonly children: ReactNode }): Promise<ReactNode> {
  const context = await loadViewerContext();

  // A user with no granted business has nothing to operate on. Sending them to a
  // screen that explains that is kinder than showing an empty shell.
  if (context.businesses.length === 0) {
    return (
      <Shell
        surface={context.viewer.role === 'admin' ? 'admin' : 'user'}
        nav={context.nav}
        businesses={[]}
        userLabel={context.viewer.fullName ?? context.viewer.email ?? ''}
      >
        <div className="nx-card">
          <div className="nx-card__body">
            <div className="nx-empty">
              <span className="nx-empty__title">No businesses yet</span>
              <p className="nx-empty__body">
                {context.viewer.role === 'admin'
                  ? 'Create a business to start configuring the workspace.'
                  : 'An administrator has not granted you access to a business yet.'}
              </p>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      surface={context.viewer.role === 'admin' ? 'admin' : 'user'}
      nav={context.nav}
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
