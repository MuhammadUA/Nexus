import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { loadViewer, type Viewer } from './actor';
import { SESSION_COOKIE, verifySession } from './session';

/**
 * Resolves the current viewer for a server render, or null when signed out.
 *
 * This is a convenience for rendering (navigation labels, permission-gated
 * controls). It is **not** the authorization boundary: every repository call runs
 * through `withActor`, so a screen that forgets to check a permission still cannot
 * read or write outside the actor's scope.
 */
export async function currentViewer(): Promise<Viewer | null> {
  const store = await cookies();
  const session = verifySession(store.get(SESSION_COOKIE)?.value);
  if (session === null) return null;

  const viewer = await loadViewer({ kind: 'user', userId: session.userId });
  // A session cookie for a deleted or disabled user must not authenticate: no role
  // means no matching row was visible to RLS, or the row is soft-deleted.
  if (viewer.role === null) return null;
  return viewer;
}

/** Same as `currentViewer`, but redirects to the login screen when signed out. */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await currentViewer();
  if (viewer === null) redirect('/login');
  return viewer;
}
