/**
 * Authentication service.
 *
 * Two entry points, both converging on "confirm a `userId`, then publish it to
 * PostgreSQL as `request.jwt.claims`":
 *
 *   - `bootstrapFirstAdmin` — runs only while the deployment has zero users, so a
 *     fresh install can be claimed exactly once.
 *   - `verifyLocalCredentials` — the local development provider.
 *
 * In production, Supabase Auth issues the cookie and this module's credential
 * path is bypassed; the rest of the app is unaffected because authorization is
 * enforced by RLS on the resulting `userId`, not by how the login happened.
 */
import 'server-only';

import { withServiceRole } from './actor';
import { hashPassword, passwordPolicyError, verifyPassword } from './password';

export interface LoginCandidate {
  readonly userId: string;
  readonly role: 'admin' | 'manager' | 'user';
  readonly passwordHash: string;
  readonly lockedUntil: string | null;
}

export interface AuthOutcome {
  readonly ok: boolean;
  readonly userId?: string;
  readonly reason?: string;
}

/** True once at least one user row exists. */
export async function deploymentIsClaimed(): Promise<boolean> {
  return withServiceRole('first-run check: count users', async (sql) => {
    const result = await sql.query<{ n: number }>(`select count(*)::int as n from public.users`);
    return (result.rows[0]?.n ?? 0) > 0;
  });
}

export interface BootstrapInput {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
}

/**
 * Creates the first admin.
 *
 * Refuses once any user exists. The guard is re-checked *inside* the transaction
 * that inserts, so two concurrent first-run requests cannot both succeed.
 */
export async function bootstrapFirstAdmin(input: BootstrapInput): Promise<AuthOutcome> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, reason: 'Enter a valid email address.' };
  if (input.fullName.trim().length === 0) return { ok: false, reason: 'Enter your name.' };

  const policyError = passwordPolicyError(input.password);
  if (policyError !== null) return { ok: false, reason: policyError };

  const passwordHash = await hashPassword(input.password);

  return withServiceRole('bootstrap: create the first admin', async (sql) => {
    const existing = await sql.query<{ n: number }>(`select count(*)::int as n from public.users`);
    if ((existing.rows[0]?.n ?? 0) > 0) {
      return { ok: false, reason: 'This deployment already has users. Sign in instead.' };
    }

    const inserted = await sql.query<{ id: string }>(
      `insert into public.users (email, full_name, role, status)
       values ($1, $2, 'admin', 'active')
       returning id`,
      [email, input.fullName.trim()],
    );
    const userId = inserted.rows[0]?.id;
    if (userId === undefined) return { ok: false, reason: 'Could not create the admin user.' };

    await sql.query(`insert into public.user_credentials (user_id, password_hash) values ($1, $2)`, [
      userId,
      passwordHash,
    ]);

    await sql.query(
      `insert into public.audit_events (actor_type, actor_id, entity_type, entity_id, action, after_json, source_client)
       values ('system', $1, 'users', $1, 'bootstrap_first_admin', $2, 'web-bootstrap')`,
      [userId, JSON.stringify({ email, role: 'admin' })],
    );

    return { ok: true, userId };
  });
}

/** Looks up the credential record for an email. Service path only. */
async function findCandidate(email: string): Promise<LoginCandidate | null> {
  return withServiceRole('login: read credential record', async (sql) => {
    const result = await sql.query<{
      user_id: string;
      password_hash: string;
      role: 'admin' | 'manager' | 'user';
      locked_until: string | null;
    }>(`select user_id, password_hash, role, locked_until from public.authenticate_user($1)`, [email]);

    const row = result.rows[0];
    // Guard the hash explicitly: a missing or non-string value must read as "no
    // usable credential", never as `undefined` flowing into the KDF.
    if (row === undefined || typeof row.password_hash !== 'string' || row.password_hash.length === 0) {
      return null;
    }
    return {
      userId: row.user_id,
      role: row.role,
      passwordHash: row.password_hash,
      lockedUntil: row.locked_until,
    };
  });
}

/**
 * Verifies an email/password pair.
 *
 * The outbound error is intentionally identical for "unknown email", "wrong
 * password" and "disabled account", so the endpoint cannot be used to enumerate
 * accounts. Lockout state is checked before the KDF runs, so a locked account
 * cannot be used to burn server CPU.
 */
export async function verifyLocalCredentials(email: string, password: string): Promise<AuthOutcome> {
  const genericFailure = { ok: false, reason: 'Email or password is incorrect.' } as const;

  const candidate = await findCandidate(email.trim());
  if (candidate === null) {
    // Spend comparable time so a missing account is not detectably faster.
    await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    return genericFailure;
  }

  if (candidate.lockedUntil !== null && new Date(candidate.lockedUntil).getTime() > Date.now()) {
    return { ok: false, reason: 'This account is temporarily locked after repeated failed sign-ins.' };
  }

  const valid = await verifyPassword(password, candidate.passwordHash);

  await withServiceRole('login: record attempt', async (sql) => {
    await sql.query(`select public.record_login_attempt($1, $2)`, [candidate.userId, valid]);
  });

  return valid ? { ok: true, userId: candidate.userId } : genericFailure;
}

/**
 * Whether the local credential path is permitted.
 *
 * Opt-in, and never on by default, so a misconfigured production deploy cannot
 * silently accept local passwords. `NEXUS_LOCAL_AUTH=1` is the explicit switch.
 */
export function localAuthEnabled(): boolean {
  return process.env.NEXUS_LOCAL_AUTH === '1';
}
