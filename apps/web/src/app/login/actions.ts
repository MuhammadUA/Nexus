'use server';

/**
 * Sign-out.
 *
 * Still a server action, because deleting a cookie is the one case where the
 * action-context limitation documented in `/api/auth/login/route.ts` does not apply:
 * `cookies().delete()` needs no value round trip, and the redirect is the desired
 * final state rather than something that must preserve a header.
 *
 * Sign-in deliberately does NOT live here — see the route handler's docblock.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '@/lib/session';

export async function signOutAction(): Promise<never> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect('/login');
}
