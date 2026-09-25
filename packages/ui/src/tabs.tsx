'use client';

/**
 * Tabs — the one primitive that needs a browser.
 *
 * A tab strip is genuinely interactive: clicking a tab has to change the selected tab
 * without a round trip. That means an `onClick` handler, and an event handler cannot cross
 * the Server/Client boundary — passing one from a Server Component is a hard error
 * ("Event handlers cannot be passed to Client Component props"), which is exactly how the
 * Duplicate Review screen failed to render at all.
 *
 * So this lives in its own client module rather than in `primitives.tsx`. Everything else in
 * the kit is presentational and stays renderable from a Server Component, which keeps the
 * rest of the design system usable without shipping it to the browser.
 *
 * The component takes an optional `href` per tab. With an `href` it renders an anchor and the
 * selection becomes a real navigation, which is what a Server Component wants; without one it
 * needs `onChange` and must be rendered from a Client Component.
 */
import type { ReactElement, ReactNode } from 'react';

export interface TabItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly count?: number;
  /** When set, the tab renders as a link and `onChange` is not required. */
  readonly href?: string;
}

export interface TabsProps {
  readonly tabs: readonly TabItem[];
  readonly active: string;
  /** Required for interactive tabs; omit when every tab has an `href`. */
  readonly onChange?: (key: string) => void;
  readonly label: string;
}

export function Tabs({ tabs, active, onChange, label }: TabsProps): ReactElement {
  return (
    <div className="nx-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const selected = tab.key === active;
        const content = (
          <>
            {tab.label}
            {tab.count !== undefined && <span className="nx-tab__count">{tab.count}</span>}
          </>
        );

        // A Server Component cannot supply `onChange`, so a tab that carries an `href` is
        // rendered as a link instead: same appearance, same selection state, real navigation.
        if (tab.href !== undefined) {
          return (
            <a
              key={tab.key}
              role="tab"
              className="nx-tab"
              aria-selected={selected}
              href={tab.href}
            >
              {content}
            </a>
          );
        }

        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            className="nx-tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange?.(tab.key)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
