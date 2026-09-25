/**
 * Session cookie handling.
 *
 * The cookie carries `userId.expiresAt` signed with HMAC-SHA256. It is
 * deliberately *not* a JWT: this app never needs to read a session on a client,
 * and a compact signed token avoids a crypto dependency and the class of bugs
 * that comes with unverified header parsing.
 *
 * Production uses Supabase Auth (`security_and_reliability.stack.auth`). This
 * module is the local-development provider; both converge on the same thing —
 * a `userId` that is then published to PostgreSQL as `request.jwt.claims`, which
 * is exactly what Supabase's `auth.uid()` reads. Authorization therefore behaves
 * identically under either provider, because it is enforced by RLS in the
 * database rather than by the cookie format.
 */
import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'nx_session';

/** 12 hours: long enough for a working day, short enough to bound a leaked cookie. */
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionPayload {
  readonly userId: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

function secret(): string {
  const configured = process.env.NEXUS_SESSION_SECRET ?? '';
  if (configured.trim().length > 0) return configured.trim();
  if (process.env.NODE_ENV === 'production') {
    // assertRuntimePosture() refuses to boot in this state; failing here too means
    // a misconfigured deploy cannot silently accept forgeable sessions.
    throw new Error('NEXUS_SESSION_SECRET is required in production');
  }
  // Development-only fallback. Fixed rather than random so restarting the dev
  // server does not sign every developer out mid-flow.
  return 'nexus-development-session-secret-not-for-production';
}

function sign(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

/**
 * Issues a signed session cookie.
 *
 * `ttlSeconds` defaults to the working-day lifetime. It is overridable so tests
 * can mint an already-expired cookie through the real signing path, rather than
 * hand-forging a token and testing a different code path.
 */
export function issueSession(
  userId: string,
  now: Date = new Date(),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): {
  readonly cookieValue: string;
  readonly payload: SessionPayload;
} {
  const payload: SessionPayload = {
    userId,
    expiresAt: Math.floor(now.getTime() / 1000) + ttlSeconds,
  };
  const body = `${payload.userId}.${String(payload.expiresAt)}`;
  return { cookieValue: `${body}.${sign(body)}`, payload };
}

/**
 * Verifies a cookie value. Returns null for anything malformed, unsigned,
 * mismatched or expired — callers never see a partially trusted payload.
 */
export function verifySession(cookieValue: string | undefined, now: Date = new Date()): SessionPayload | null {
  if (cookieValue === undefined || cookieValue.length === 0) return null;

  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresRaw, signature] = parts as [string, string, string];
  if (userId.length === 0 || expiresRaw.length === 0 || signature.length === 0) return null;

  const expected = sign(`${userId}.${expiresRaw}`);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt)) return null;
  if (expiresAt * 1000 <= now.getTime()) return null;

  return { userId, expiresAt };
}

export function sessionCookieOptions(expiresAt: number): {
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
  readonly path: '/';
  readonly maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Secure cookies require HTTPS; local development runs on http.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
  };
}
