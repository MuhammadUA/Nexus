'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Route-level error boundary.
 *
 * Without one, a render failure reaches the operator as "a server-side exception has
 * occurred" with a digest and nothing else, which is correct for security but leaves nothing
 * to act on. This boundary keeps the digest visible, states which section failed, and offers
 * the two things that actually help: retry the render, or go back to the business overview.
 *
 * It does not swallow the error — the same failure is still logged server-side.
 */
export default class RouteError extends Component<
  { readonly error: Error & { digest?: string }; readonly reset: () => void },
  { readonly shown: boolean }
> {
  constructor(props: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
    super(props);
    this.state = { shown: false };
  }

  static getDerivedStateFromError(): { shown: boolean } {
    return { shown: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only place a client render failure is visible; the digest ties it
    // to the server log line for the same request, where `instrumentation.ts` records the
    // real message.
    console.error('[nexus] render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    return (
      <main className="nx-content">
        <div className="nx-card">
          <header className="nx-card__header">
            <h1 className="nx-section-title">This screen could not be rendered</h1>
          </header>
          <div className="nx-card__body">
            <div className="nx-stack nx-stack--md">
              <p>
                The page failed while rendering. The failure has been recorded in the server log with the
                reference below, which is the fastest way to find the cause.
              </p>
              <p className="nx-hint">
                Reference: <span className="nx-table__mono">{this.props.error.digest ?? 'no digest'}</span>
              </p>
              <div className="nx-row nx-row--wrap">
                <button type="button" className="nx-btn nx-btn--primary" onClick={() => { this.props.reset(); }}>
                  Try again
                </button>
                <a className="nx-btn nx-btn--secondary" href="/">
                  Back to My Day
                </a>
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }
}
