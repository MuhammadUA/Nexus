/**
 * API gateway authentication and scope enforcement.
 *
 * Two credential kinds reach `/api/v1`:
 *
 *  1. **User bearer tokens** (`user_api_tokens`) — the Companion side panel and any
 *     user-scoped client. Resolved to a `user_id`, then the request runs through the
 *     ordinary `withActor` path, so RLS decides everything exactly as it does for a
 *     browser session.
 *  2. **Service tokens** (`api_clients`) — external agents (ChatGPT, OpenCode,
 *     BrowserOS). These carry an explicit scope list and a business allow-list, and
 *     `is_api_client_allowed()` refuses any business or scope outside them.
 *
 * Neither kind can express SQL. There is no `execute_sql`, and the request body is
 * never interpolated into a statement — every value is a bound parameter.
 */
import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { withActor, type Actor } from './actor';
import { withServiceRole } from './actor';

export interface UserCredential {
  readonly kind: 'user';
  readonly userId: string;
  readonly actor: Actor;
}

export interface ServiceCredential {
  readonly kind: 'service';
  readonly apiClientId: string;
  readonly apiClientName: string;
  readonly scopes: readonly string[];
  readonly businessIds: readonly string[];
  readonly actor: Actor;
}

export interface AnonymousCredential {
  readonly kind: 'anonymous';
  /** Always null: there is no identity to act as. */
  readonly actor: null;
}

export type Credential = UserCredential | ServiceCredential | AnonymousCredential;

/** SHA-256 hex. Tokens are high-entropy, so a fast hash is appropriate (unlike passwords). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Issues a new user token. Returns the RAW token exactly once — it is never stored,
 * so it cannot be recovered later and must be revoked and reissued instead.
 */
export function generateUserToken(): { readonly raw: string; readonly hash: string; readonly prefix: string } {
  // 32 bytes of CSPRNG output: 256 bits, well beyond guessing.
  const raw = `nxu_${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 12) };
}

export function generateServiceToken(): { readonly raw: string; readonly hash: string; readonly prefix: string } {
  const raw = `nxs_${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 12) };
}

/** Constant-time comparison for any token material compared in application code. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Resolves a bearer token.
 *
 * The user-token lookup is the only place a token is turned into an identity, and it
 * is deliberately a database function so "revoked", "expired" and "user disabled"
 * are evaluated against live rows rather than a cached copy.
 */
export async function resolveCredential(authorizationHeader: string | null): Promise<Credential> {
  if (authorizationHeader === null) return { kind: 'anonymous', actor: null };

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  const raw = match?.[1]?.trim() ?? '';
  if (raw.length === 0) return { kind: 'anonymous', actor: null };

  const hash = hashToken(raw);

  // Order matters: user tokens are prefixed, so a personal token is never probed
  // against the service table.
  if (raw.startsWith('nxu_')) {
    const userId = await withServiceRole('gateway: resolve user bearer token', async (sql) => {
      const result = await sql.query<{ user_id: string | null }>(
        `select public.resolve_user_token($1) as user_id`,
        [hash],
      );
      return result.rows[0]?.user_id ?? null;
    });

    if (userId === null) return { kind: 'anonymous', actor: null };
    return { kind: 'user', userId, actor: { kind: 'user', userId } };
  }

  if (raw.startsWith('nxs_')) {
    const client = await withServiceRole('gateway: resolve service token', async (sql) => {
      const result = await sql.query<{
        id: string;
        name: string;
        scopes: string[];
        business_ids: string[];
      }>(
        `select id, name, scopes, business_ids
           from public.api_clients
          where token_hash = $1
            and is_active
            and revoked_at is null
            and (expires_at is null or expires_at > now())`,
        [hash],
      );
      return result.rows[0] ?? null;
    });

    if (client === null) return { kind: 'anonymous', actor: null };
    return {
      kind: 'service',
      apiClientId: client.id,
      apiClientName: client.name,
      scopes: client.scopes,
      businessIds: client.business_ids,
      actor: { kind: 'api_client', apiClientId: client.id },
    };
  }

  return { kind: 'anonymous', actor: null };
}

/** Gate for endpoints that only a signed-in person may use. */
export function requireUser(credential: Credential): { ok: true; userId: string } | { ok: false; error: string } {
  if (credential.kind === 'user') return { ok: true, userId: credential.userId };
  if (credential.kind === 'service') {
    return { ok: false, error: 'This endpoint requires a user token, not a service token.' };
  }
  return { ok: false, error: 'Sign in to Nexus.' };
}

/**
 * Gate for endpoints an external agent may call.
 *
 * A service token must hold the specific scope AND list the business — the two terms
 * are both mandatory, which is what prevents a token from exceeding its grant even
 * if the SQL it triggers forgets a predicate.
 */
export function requireScope(
  credential: Credential,
  scope: string,
  businessId: string,
): { ok: true } | { ok: false; error: string; status: number } {
  if (credential.kind === 'user') return { ok: true };
  if (credential.kind === 'anonymous') return { ok: false, error: 'Missing or invalid token.', status: 401 };
  if (!credential.scopes.includes(scope)) {
    return { ok: false, error: `This token does not have the ${scope} scope.`, status: 403 };
  }
  if (!credential.businessIds.includes(businessId)) {
    return { ok: false, error: 'This token is not scoped to that business.', status: 403 };
  }
  return { ok: true };
}

/** Convenience: the actor to hand to a repository. */
export function actorFor(credential: Credential): Actor | null {
  return credential.kind === 'anonymous' ? null : credential.actor;
}

export { withActor };
