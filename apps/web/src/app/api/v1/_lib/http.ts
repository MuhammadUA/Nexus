/**
 * Shared plumbing for `/api/v1` route handlers.
 *
 * Every handler in this folder follows the same shape: resolve the credential,
 * refuse an anonymous caller, parse and validate the body with Zod, run the work
 * through the repository layer (which is inside `withActor`, so RLS applies), and
 * return a JSON result. No handler builds SQL, and no handler accepts SQL.
 */
import 'server-only';

import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { resolveCredential, type Credential } from '@/lib/gateway';
import type { Actor } from '@/lib/actor';

export interface ApiErrorBody {
  readonly error: string;
  /**
   * A machine-readable discriminator, plus any structured detail the caller needs to recover.
   *
   * Some failures are decisions rather than faults — "this sender identity is held by another
   * browser profile, here is who and when" is one — and a caller that only receives the sentence
   * cannot offer the right next step. Anything added here is already safe to show the operator.
   */
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export function jsonError<T extends Record<string, unknown> = Record<string, never>>(
  message: string,
  status: number,
  detail?: T,
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: message, ...(detail ?? {}) }, { status });
}

/**
 * A JSON 200 (or explicit status).
 *
 * Not generic over the payload any more: a JSON-RPC batch answers with an *array* of response
 * objects, and a `T extends Record<string, unknown>` bound cannot express that. Callers that need a
 * precise type already have it from their own literal.
 */
export function jsonOk(payload: unknown, status = 200): NextResponse {
  return NextResponse.json(payload, { status });
}

export interface AuthorizedContext {
  readonly credential: Credential;
  readonly userId: string;
  /**
   * The actor to hand to a repository. Always non-null here: `authorizeUser` and
   * `authorizeAny` have already refused the anonymous case, so handlers cannot
   * accidentally call a repository with no identity.
   */
  readonly actor: Actor;
}

/**
 * Resolves the caller and requires a *user* credential.
 *
 * Returns a `NextResponse` on failure so the caller can return it directly; this
 * shape makes it impossible to forget the check and continue with a null user.
 */
export async function authorizeUser(
  request: Request,
): Promise<{ ok: true; context: AuthorizedContext } | { ok: false; response: NextResponse<ApiErrorBody> }> {
  const credential = await resolveCredential(request.headers.get('authorization'));

  if (credential.kind === 'anonymous') {
    return { ok: false, response: jsonError('Sign in to Nexus.', 401) };
  }
  if (credential.kind === 'service') {
    return {
      ok: false,
      response: jsonError('This endpoint requires a user token, not a service token.', 403),
    };
  }

  return { ok: true, context: { credential, userId: credential.userId, actor: credential.actor } };
}

/** Any non-anonymous credential (user or scoped service token). */
export async function authorizeAny(
  request: Request,
): Promise<{ ok: true; context: AuthorizedContext } | { ok: false; response: NextResponse<ApiErrorBody> }> {
  const credential = await resolveCredential(request.headers.get('authorization'));
  if (credential.kind === 'anonymous') {
    return { ok: false, response: jsonError('Missing or invalid token.', 401) };
  }
  return {
    ok: true,
    context: {
      credential,
      userId: credential.kind === 'user' ? credential.userId : '',
      actor: credential.actor,
    },
  };
}

/**
 * Validates a JSON body.
 *
 * A malformed or unexpected body is rejected before any database work, which is the
 * spec's "AI output is schema validated before database mutation" rule applied to
 * every external boundary — agents and browsers alike.
 */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse<ApiErrorBody> }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: jsonError('Expected a JSON body.', 400) };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const message = first?.message ?? 'Invalid request body.';
    return {
      ok: false,
      response: jsonError(path.length > 0 ? `${path}: ${message}` : message, 400),
    };
  }

  return { ok: true, data: parsed.data };
}

/** Guards against unbounded `limit` values from a client. */
export function clampLimit(value: number | undefined, fallback: number, max = 100): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}
