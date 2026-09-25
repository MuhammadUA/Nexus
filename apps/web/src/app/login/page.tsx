import type { ReactNode } from 'react';

import { redirect } from 'next/navigation';

import { deploymentIsClaimed, localAuthEnabled } from '@/lib/auth';
import { currentViewer } from '@/lib/current-viewer';
import { LoginForm } from '@/components/login-form';

export const dynamic = 'force-dynamic';

/**
 * A01 / U01 — Login.
 *
 * One login screen serves both surfaces: the spec lists it twice because admin and
 * user both need it, not because there are two implementations. The contract is
 * "no business-specific examples or instructional copy", so this page renders
 * nothing product-specific, and it shows the first-run panel only while the
 * deployment genuinely has zero users.
 */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}): Promise<ReactNode> {
  const viewer = await currentViewer();
  if (viewer !== null) redirect('/my-day');

  const query = await searchParams;
  const claimed = await deploymentIsClaimed();

  // The route handler that establishes the session reports failures by redirecting
  // back here with a reason, so the login screen stays the only place that renders
  // authentication messaging.
  const error = firstValue(query.error) ?? null;
  const defaultEmail = firstValue(query.email) ?? '';
  const defaultFullName = firstValue(query.fullName) ?? '';

  return (
    <main className="nx-login">
      <div className="nx-login__shell">
        <div className="nx-login__brand">Nexus</div>
        {!claimed ? (
          <>
            <p className="nx-login__tagline">Create the first administrator for this workspace.</p>
            <LoginForm
              mode="bootstrap"
              defaultEmail={defaultEmail}
              defaultFullName={defaultFullName}
              error={error}
            />
          </>
        ) : (
          <>
            <p className="nx-login__tagline">Sign in to continue.</p>
            <LoginForm
              mode="signin"
              localAuthEnabled={localAuthEnabled()}
              defaultEmail={defaultEmail}
              error={error}
            />
          </>
        )}
      </div>
    </main>
  );
}

/** A repeated query parameter arrives as an array; take the first value. */
function firstValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}
