import type { ReactElement } from 'react';

import { cx } from '@nexus/ui';

export function MyDayNav({ active, showTask = true }: { readonly active: 'today' | 'upcoming' | 'done'; readonly showTask?: boolean }): ReactElement {
  const tabs = [
    { key: 'today', label: 'Today', href: '/my-day' },
    { key: 'upcoming', label: 'Upcoming', href: '/my-day/upcoming' },
    { key: 'done', label: 'Done', href: '/my-day/done' },
  ] as const;

  return (
    <nav className="nx-view-tabs" aria-label="My Day views">
      {tabs.map((tab) => (
        <a
          key={tab.key}
          href={tab.href}
          className={cx('nx-view-tab', active === tab.key && 'nx-view-tab--active')}
          aria-current={active === tab.key ? 'page' : undefined}
        >
          {tab.label}
        </a>
      ))}
      {showTask && (
        <a className="nx-btn nx-btn--secondary nx-btn--sm nx-view-tabs__action" href="/tasks/new">
          + Task
        </a>
      )}
    </nav>
  );
}
