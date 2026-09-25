/**
 * `POST /api/auth/login` — establishes a session.
 *
 * This is a **route handler, not a server action**, and that is deliberate. Server
 * actions in this Next.js version resolve the request scope through
 * `AsyncLocalStorage` in a way that makes `cookies()` throw *"`cookies` was called
 * outside a request scope"* — including when it is the very first statement in the
 * action. A route handler receives a real `Request`, so the session cookie can be set
 * on the `Response` directly and unambiguously.
 *
 * Redirecting *after* setting the cookie on the same response also sidesteps a second
 * Next.js behaviour: a `redirect()` issued from inside a server action streams a GET
 * whose `Set-Cookie` header replaces the one the action had just set
 * (vercel/next.js#61611, #70769), silently leaving the operator signed out. Here the
 * `303 See Other` and the cookie travel together, and the browser's follow-up GET is a
 * fresh request that already carries the session.
 *
 * `mode=bootstrap` creates the first administrator (only while the deployment has no
 * users) and `mode=signin` verifies existing credentials.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { bootstrapFirstAdmin, localAuthEnabled, verifyLocalCredentials } from '@/lib/auth';
import { formString } from '@/lib/form-data';
import { SESSION_COOKIE, issueSession, sessionCookieOptions } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Generous but bounded, so a malformed email cannot become a megabyte-long query. */
const email = z.string().trim().min(3).max(320);
const password = z.string().min(1).max(200);

const signInSchema = z.object({ email, password });
const bootstrapSchema = signInSchema.extend({ fullName: z.string().trim().min(1).max(200) });

/**
 * The page to return to on failure, with the reason.
 *
 * Errors travel in the query string rather than in a rendered page because this
 * handler's job is session establishment; the login screen owns presentation.
 */
function backToLogin(reason: string, extra: Record<string, string> = {}): NextResponse {
  const url = new URL('/login', 'http://placeholder');
  url.searchParams.set('error', reason);
  for (const [key, value] of Object.entries(extra)) {
    if (value.length > 0) url.searchParams.set(key, value);
  }
  // Relative Location keeps the redirect working behind any host or proxy.
  return new NextResponse(null, { status: 303, headers: { location: `${url.pathname}${url.search}` } });
}

function signedIn(userId: string): NextResponse {
  const { cookieValue, payload } = issueSession(userId);

  // The cookie is set on the redirect response itself, so it is present when the
  // browser follows the redirect.
  const response = new NextResponse(null, { status: 303, headers: { location: '/my-day' } });
  response.cookies.set(SESSION_COOKIE, cookieValue, sessionCookieOptions(payload.expiresAt));
  return response;
}

export async function POST(request: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return backToLogin('That form could not be read. Try again.');
  }

  const mode = formString(formData, 'mode', 'signin');
  const submittedEmail = formString(formData, 'email', '');

  if (mode === 'bootstrap') {
    const parsed = bootstrapSchema.safeParse({
      fullName: formString(formData, 'fullName'),
      email: formString(formData, 'email'),
      password: formString(formData, 'password'),
    });
    if (!parsed.success) {
      return backToLogin('Enter your name, email and a password of at least 12 characters.', {
        email: submittedEmail,
        fullName: formString(formData, 'fullName'),
      });
    }

    const outcome = await bootstrapFirstAdmin(parsed.data);
    if (!outcome.ok || outcome.userId === undefined) {
      return backToLogin(outcome.reason ?? 'Could not create the administrator account.', {
        email: submittedEmail,
        fullName: parsed.data.fullName,
      });
    }

    return signedIn(outcome.userId);
  }

  if (!localAuthEnabled()) {
    return backToLogin(
      'Local sign-in is disabled. Set NEXUS_LOCAL_AUTH=1 for local development, or connect Supabase Auth.',
      { email: submittedEmail },
    );
  }

  const parsed = signInSchema.safeParse({
    email: formString(formData, 'email'),
    password: formString(formData, 'password'),
  });
  if (!parsed.success) {
    return backToLogin('Enter your email and password.', { email: submittedEmail });
  }

  const outcome = await verifyLocalCredentials(parsed.data.email, parsed.data.password);
  if (!outcome.ok || outcome.userId === undefined) {
    return backToLogin(outcome.reason ?? 'Email or password is incorrect.', { email: submittedEmail });
  }

  return signedIn(outcome.userId);
}

/** `GET` is refused rather than silently succeeding, so a prefetch cannot sign anyone in. */
export function GET(): Response {
  return new NextResponse(null, { status: 405, headers: { allow: 'POST' } });
}
