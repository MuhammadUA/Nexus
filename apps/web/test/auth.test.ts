/**
 * Local authentication path — the exact flow the login screen drives.
 *
 * Covers the first-run bootstrap, credential verification, account lockout, the
 * session cookie, and the RLS consequences of the resulting identity. These are
 * the behaviours the earlier HTTP smoke test could not reach.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootstrapFirstAdmin, deploymentIsClaimed, localAuthEnabled, verifyLocalCredentials } from '@/lib/auth';
import { withActor } from '@/lib/actor';
import { hashPassword, passwordPolicyError, verifyPassword } from '@/lib/password';
import { SESSION_COOKIE, issueSession, sessionCookieOptions, verifySession } from '@/lib/session';

import { createAppHarness, scalar, type AppHarness } from './harness';

let h: AppHarness;

const ADMIN_EMAIL = 'first.admin@nexus.test';
const ADMIN_NAME = 'First Admin';
const ADMIN_PASSWORD = 'a-sufficiently-long-password';

beforeAll(async () => {
  h = await createAppHarness();
}, 240_000);

afterAll(async () => {
  await h.close();
});

describe('password hashing', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('incorrect horse battery staple', hash)).toBe(false);
  });

  it('produces a different hash each time (unique salt)', async () => {
    const a = await hashPassword('same-password-twice');
    const b = await hashPassword('same-password-twice');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-twice', a)).toBe(true);
    expect(await verifyPassword('same-password-twice', b)).toBe(true);
  });

  it('treats a malformed stored hash as a non-match rather than throwing', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5']) {
      await expect(verifyPassword('anything', bad)).resolves.toBe(false);
    }
  });

  it('enforces the length policy', () => {
    expect(passwordPolicyError('short')).not.toBeNull();
    expect(passwordPolicyError('long-enough-password')).toBeNull();
  });
});

describe('first-run bootstrap', () => {
  it('an unknown deployment is unclaimed, so the first-run panel is shown', async () => {
    // The harness creates a bare database with every migration applied and no users,
    // which is exactly the state `/login` inspects to choose its panel.
    expect(await deploymentIsClaimed()).toBe(false);
  });

  it('rejects a weak password before writing anything', async () => {
    const outcome = await bootstrapFirstAdmin({
      email: ADMIN_EMAIL,
      fullName: ADMIN_NAME,
      password: 'short',
    });
    expect(outcome.ok).toBe(false);
    expect(await scalar(h.db, 'select count(*)::int as n from public.users')).toBe(0);
  });

  it('creates the first admin with an admin role and a usable credential', async () => {
    const outcome = await bootstrapFirstAdmin({
      email: ADMIN_EMAIL,
      fullName: ADMIN_NAME,
      password: ADMIN_PASSWORD,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.userId).toBeDefined();

    const user = await h.db.query<{ role: string; email: string; status: string }>(
      'select role, email, status from public.users where id = $1',
      [outcome.userId],
    );
    expect(user.rows[0]?.role).toBe('admin');
    expect(user.rows[0]?.email).toBe(ADMIN_EMAIL);
    expect(user.rows[0]?.status).toBe('active');

    // The credential is stored, and stored as a hash rather than the password.
    const credential = await h.db.query<{ password_hash: string }>(
      'select password_hash from public.user_credentials where user_id = $1',
      [outcome.userId],
    );
    expect(credential.rows[0]?.password_hash).toBeDefined();
    expect(credential.rows[0]?.password_hash).not.toContain(ADMIN_PASSWORD);
  });

  it('writes an audit event naming the bootstrap action', async () => {
    const audit = await h.db.query<{ action: string; entity_type: string }>(
      `select action, entity_type from public.audit_events where action = 'bootstrap_first_admin'`,
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]?.entity_type).toBe('users');
  });

  it('the credentials it just created are immediately usable', async () => {
    // Reproduces the live first-run sequence end to end: bootstrap, then sign in with
    // the same password. A bootstrap that stores an unusable hash would pass every
    // other assertion here and still leave the operator locked out of their own
    // deployment.
    const outcome = await verifyLocalCredentials(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(outcome.ok).toBe(true);
    expect(outcome.userId).toBeDefined();
  });

  it('refuses a second bootstrap once a user exists', async () => {
    expect(await deploymentIsClaimed()).toBe(true);
    const outcome = await bootstrapFirstAdmin({
      email: 'second.admin@nexus.test',
      fullName: 'Second Admin',
      password: 'another-sufficiently-long-password',
    });
    expect(outcome.ok).toBe(false);
    expect(await scalar(h.db, 'select count(*)::int as n from public.users')).toBe(1);
  });
});

describe('credential verification', () => {
  it('accepts the correct password', async () => {
    const outcome = await verifyLocalCredentials(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(outcome.ok).toBe(true);
    expect(outcome.userId).toBeDefined();
  });

  it('is case-insensitive on the email', async () => {
    const outcome = await verifyLocalCredentials(ADMIN_EMAIL.toUpperCase(), ADMIN_PASSWORD);
    expect(outcome.ok).toBe(true);
  });

  it('rejects a wrong password with the same message as an unknown account', async () => {
    const wrongPassword = await verifyLocalCredentials(ADMIN_EMAIL, 'wrong-password-entirely');
    const unknownAccount = await verifyLocalCredentials('nobody@nexus.test', 'wrong-password-entirely');

    expect(wrongPassword.ok).toBe(false);
    expect(unknownAccount.ok).toBe(false);
    // Identical wording: the endpoint must not reveal which accounts exist.
    expect(wrongPassword.reason).toBe(unknownAccount.reason);
    expect(wrongPassword.reason).toBe('Email or password is incorrect.');
  });

  it('does not return the stored hash to the caller', async () => {
    const outcome = await verifyLocalCredentials(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(JSON.stringify(outcome)).not.toContain('scrypt$');
  });

  it('locks an account after repeated failures and then refuses the correct password', async () => {
    const created = await bootstrapFirstAdmin({
      email: 'lockout@nexus.test',
      fullName: 'Lockout Subject',
      password: 'lockout-subject-password',
    });
    // Bootstrap only works while unclaimed, so create this user directly instead.
    expect(created.ok).toBe(false);

    await h.db.query(
      `insert into public.users (email, full_name, role, status) values ($1, $2, 'user', 'active')`,
      ['lockout@nexus.test', 'Lockout Subject'],
    );
    const userId = (
      await h.db.query<{ id: string }>('select id from public.users where email = $1', ['lockout@nexus.test'])
    ).rows[0]?.id;
    expect(userId).toBeDefined();

    await h.db.query('insert into public.user_credentials (user_id, password_hash) values ($1, $2)', [
      userId,
      await hashPassword('lockout-subject-password'),
    ]);

    // Eight failures is the default threshold in `record_login_attempt`.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await verifyLocalCredentials('lockout@nexus.test', 'wrong');
    }

    const locked = await h.db.query<{ locked_until: string | null }>(
      'select locked_until from public.user_credentials where user_id = $1',
      [userId],
    );
    expect(locked.rows[0]?.locked_until).not.toBeNull();

    const withCorrectPassword = await verifyLocalCredentials('lockout@nexus.test', 'lockout-subject-password');
    expect(withCorrectPassword.ok).toBe(false);
    expect(withCorrectPassword.reason).toContain('locked');
  });
});

describe('session cookie', () => {
  it('round-trips a signed session', () => {
    const { cookieValue, payload } = issueSession('11111111-1111-4111-8111-111111111111');
    const verified = verifySession(cookieValue);
    expect(verified?.userId).toBe(payload.userId);
  });

  it('rejects a tampered payload', () => {
    const { cookieValue } = issueSession('11111111-1111-4111-8111-111111111111');
    const parts = cookieValue.split('.');
    // Swap the user id but keep the original signature.
    const forged = ['22222222-2222-4222-8222-222222222222', parts[1], parts[2]].join('.');
    expect(verifySession(forged)).toBeNull();
  });

  it('rejects a tampered expiry', () => {
    const { cookieValue } = issueSession('11111111-1111-4111-8111-111111111111');
    const parts = cookieValue.split('.');
    const forged = [parts[0], String(Number(parts[1]) + 86_400), parts[2]].join('.');
    expect(verifySession(forged)).toBeNull();
  });

  it('rejects an expired session', () => {
    // Minted through the real signing path with a negative lifetime, so this
    // exercises expiry rather than a hand-forged token.
    const { cookieValue } = issueSession('11111111-1111-4111-8111-111111111111', new Date(), -60);
    expect(verifySession(cookieValue, new Date())).toBeNull();
  });

  it('rejects malformed values instead of partially trusting them', () => {
    for (const bad of [undefined, '', 'a', 'a.b', 'a.b.c.d']) {
      expect(verifySession(bad)).toBeNull();
    }
  });

  it('marks the cookie http-only, lax and path-scoped', () => {
    const { payload } = issueSession('11111111-1111-4111-8111-111111111111');
    const options = sessionCookieOptions(payload.expiresAt);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBeGreaterThan(0);
  });

  it('sets Secure in production, where the session is served over HTTPS', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { payload } = issueSession('11111111-1111-4111-8111-111111111111');
    expect(sessionCookieOptions(payload.expiresAt).secure).toBe(true);

    vi.stubEnv('NODE_ENV', 'development');
    expect(sessionCookieOptions(payload.expiresAt).secure).toBe(false);
    vi.unstubAllEnvs();
  });

  it('names the cookie the browser will actually send', () => {
    expect(SESSION_COOKIE).toBe('nx_session');
  });
});

describe('the local auth path is opt-in', () => {
  it('reports enabled only when NEXUS_LOCAL_AUTH=1', () => {
    expect(localAuthEnabled()).toBe(true);
    const previous = process.env.NEXUS_LOCAL_AUTH;
    delete process.env.NEXUS_LOCAL_AUTH;
    expect(localAuthEnabled()).toBe(false);
    process.env.NEXUS_LOCAL_AUTH = previous;
  });
});

describe('the bootstrapped admin identity is enforced by the database', () => {
  it('can read its own profile through RLS', async () => {
    const outcome = await verifyLocalCredentials(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!outcome.ok || outcome.userId === undefined) throw new Error('admin sign-in failed');

    const profile = await withActor({ kind: 'user', userId: outcome.userId }, async (sql) => {
      const result = await sql.query<{ email: string; role: string }>(
        'select email, role from public.users where id = $1',
        [outcome.userId],
      );
      return result.rows[0];
    });

    expect(profile?.email).toBe(ADMIN_EMAIL);
    expect(profile?.role).toBe('admin');
  });

  it('sees no business it has not been granted (there are none yet)', async () => {
    const outcome = await verifyLocalCredentials(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!outcome.ok || outcome.userId === undefined) throw new Error('admin sign-in failed');

    // Business visibility is the tenant boundary; a fresh deployment has no
    // business rows, and an admin must not be able to conjure one into view.
    const count = await withActor({ kind: 'user', userId: outcome.userId }, async (sql) => {
      const result = await sql.query<{ n: number }>('select count(*)::int as n from public.businesses');
      return result.rows[0]?.n ?? -1;
    });

    expect(count).toBe(0);
  });
});
