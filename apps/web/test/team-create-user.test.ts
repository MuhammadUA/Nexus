/**
 * Team user creation — the production Create User defect, and its variations.
 *
 * **The defect this file exists for.** `createTeamUser` inserted
 * `(email, full_name, role, status, created_by)` into `public.users`. That table has no
 * `created_by` column and never had one: `0002_tenancy.sql` defines
 * `(id, email, full_name, role, status, avatar_url, timezone, last_seen_at, created_at,
 * updated_at, deleted_at)` and no later migration adds it. Every Create User attempt on
 * production therefore failed with SQLSTATE 42703 (undefined_column), and because the
 * repository's error translator had no case for a schema error, the operator saw only
 * "The request could not be completed." while the server logged nothing at all.
 *
 * These tests run against a database built from the **real migration set** by the same
 * runner the application uses (`./harness`), so the schema is the production schema and
 * a column that does not exist cannot be assumed. That is the property that makes this a
 * regression test rather than a table-shape assertion.
 *
 * Actor provenance is asserted too, because removing the column looked at first like it
 * would lose it. It does not: `trg_users_audit` records the acting user on the INSERT.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadViewer, type Viewer } from '@/lib/actor';
import { hashPassword, verifyPassword } from '@/lib/password';
import { describeDbError } from '@/lib/repo/common';
import { createTeamUser } from '@/lib/repo/team';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;
let admin: Viewer;

const ADMIN_ID = 'e0000000-0000-4000-8000-000000000001';
const MANAGER_ID = 'e0000000-0000-4000-8000-000000000002';
const BUSINESS_ID = 'e1000000-0000-4000-8000-000000000001';

/** Deterministic, deliberately non-scrypt hasher so the suite does not pay scrypt's cost. */
const fastHash = (password: string): Promise<string> => Promise.resolve(`$scrypt$test$${password}`);

beforeAll(async () => {
  h = await createAppHarness();

  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'admin@team.test', 'Team Admin', 'admin', 'active')`,
    [ADMIN_ID],
  );
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'manager@team.test', 'Team Manager', 'manager', 'active')`,
    [MANAGER_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, focus, created_by)
     values ($1, 'team-biz', 'Team Business', 'active', 'Editing', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources,
        can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'admin', true, true, true, true, $1)`,
    [ADMIN_ID, BUSINESS_ID],
  );

  await h.db.exec('set row_security = on');
  admin = await loadViewer({ kind: 'user', userId: ADMIN_ID });
}, 240_000);

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/*
 * Re-assert the policy switch before every test. This is what makes the suite order-independent:
 * if any inspection forgot to restore it, the next test would still run the product code against
 * the same RLS configuration a real request sees.
 */
beforeEach(async () => {
  await h.db.exec('set row_security = on');
});

/*
 * Direct reads run with `row_security = off` so a test can inspect what was written
 * regardless of the policy that governs the *product* path.
 *
 * `row_security` is a session setting, and `createTeamUser` opens its own transaction on this
 * same connection. Leaving it off after a read therefore changes the next product call: with
 * `row_security = off` and a non-owner role, PostgreSQL refuses the write with "query would be
 * affected by row-level security policy" instead of applying the policy. These helpers restore
 * `on` before returning, and `beforeEach` re-asserts it, so an inspection can never alter the
 * behaviour of the thing under test.
 */
async function withoutRowSecurity<T>(fn: () => Promise<T>): Promise<T> {
  await h.db.exec('set row_security = off');
  try {
    return await fn();
  } finally {
    await h.db.exec('set row_security = on');
  }
}

/** One row's column value, or null. */
async function column<T>(table: string, where: string, params: unknown[], col: string): Promise<T | null> {
  return withoutRowSecurity(async () => {
    const result = await h.db.query<Record<string, T>>(
      `select ${col} from public.${table} where ${where}`,
      params,
    );
    return result.rows[0]?.[col] ?? null;
  });
}

async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  return withoutRowSecurity(async () => {
    const result = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.${table} where ${where}`,
      params,
    );
    return Number(result.rows[0]?.n ?? -1);
  });
}

describe('createTeamUser — the schema mismatch that broke production', () => {
  it('creates a user without naming a column public.users does not have', async () => {
    const result = await createTeamUser(
      admin,
      { email: 'no-password@team.test', fullName: 'No Password', role: 'user', status: 'active', grant: null },
      fastHash,
    );

    expect(result.ok, `createTeamUser failed: ${result.error ?? ''}`).toBe(true);
    expect(result.id).toBeTruthy();

    const stored = await column<string>('users', 'id = $1', [result.id], 'email');
    expect(stored).toBe('no-password@team.test');
  });

  it('reports a schema mismatch as a plain sentence, never as raw SQL', () => {
    // The exact shape Postgres returned for the missing column.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const reported = describeDbError(
      { code: '42703', message: 'column "created_by" does not exist', routine: 'errorMissingColumn' },
      'createTeamUser',
    );

    // The operator-facing sentence must not contain the column, the table or the SQLSTATE.
    expect(reported).not.toMatch(/created_by|42703|column|users/i);
    expect(reported).toMatch(/logged/i);

    // ...while the server log carries enough to diagnose it.
    expect(logged).toHaveBeenCalled();
    const payload = String(logged.mock.calls[0]?.[1] ?? '');
    expect(payload).toContain('42703');
    expect(payload).toContain('created_by');
    expect(payload).toContain('createTeamUser');
  });
});

describe('createTeamUser — the variations an operator can actually produce', () => {
  it('user without a password: profile persists, no credential row is created', async () => {
    const result = await createTeamUser(
      admin,
      { email: 'no-creds@team.test', fullName: 'No Creds', role: 'user', status: 'active', grant: null },
      fastHash,
    );
    expect(result.ok, result.error).toBe(true);

    const credentials = await withoutRowSecurity(async () =>
      h.db.query<{ n: number }>(
        'select count(*)::int as n from public.user_credentials where user_id = $1',
        [result.id],
      ),
    );
    expect(Number(credentials.rows[0]?.n ?? -1)).toBe(0);
  });

  it('user with a valid local password: the credential persists and verifies against it', async () => {
    const password = 'correct-horse-battery-staple-42';
    const result = await createTeamUser(
      admin,
      { email: 'with-creds@team.test', fullName: 'With Creds', role: 'user', status: 'active', grant: null, password },
      hashPassword,
    );
    expect(result.ok, result.error).toBe(true);

    const stored = await withoutRowSecurity(async () =>
      h.db.query<{ password_hash: string }>(
        'select password_hash from public.user_credentials where user_id = $1',
        [result.id],
      ),
    );
    const hash = stored.rows[0]?.password_hash;
    expect(hash, 'no credential row was written').toBeTruthy();

    // The stored value must be a real scrypt hash the app can verify — not the plaintext.
    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash as string)).resolves.toBe(true);
    await expect(verifyPassword('not-the-password', hash as string)).resolves.toBe(false);
  });

  it('user without an initial business grant gets no visibility at all', async () => {
    const result = await createTeamUser(
      admin,
      { email: 'no-grant@team.test', fullName: 'No Grant', role: 'user', status: 'active', grant: null },
      fastHash,
    );
    expect(result.ok, result.error).toBe(true);

    const grants = await withoutRowSecurity(async () =>
      h.db.query<{ n: number }>(
        'select count(*)::int as n from public.user_business_access where user_id = $1',
        [result.id],
      ),
    );
    expect(Number(grants.rows[0]?.n ?? -1)).toBe(0);
  });

  it('user with an initial business grant persists the grant with its permissions', async () => {
    const result = await createTeamUser(
      admin,
      {
        email: 'with-grant@team.test',
        fullName: 'With Grant',
        role: 'user',
        status: 'active',
        grant: {
          businessId: BUSINESS_ID,
          accessLevel: 'manager',
          canManageLeads: true,
          canUseLeadSources: false,
          canUseProfileQueue: true,
          canDeleteLeads: false,
        },
      },
      fastHash,
    );
    expect(result.ok, result.error).toBe(true);

    const grant = await withoutRowSecurity(async () =>
      h.db.query<Record<string, unknown>>(
        `select business_id, access_level, can_manage_leads, can_use_lead_sources,
                can_use_profile_queue, can_delete_leads, created_by
           from public.user_business_access where user_id = $1`,
        [result.id],
      ),
    );
    const row = grant.rows[0];
    expect(row, 'the grant was not written').toBeDefined();
    expect(row?.business_id).toBe(BUSINESS_ID);
    expect(row?.access_level).toBe('manager');
    expect(row?.can_manage_leads).toBe(true);
    expect(row?.can_use_lead_sources).toBe(false);
    expect(row?.can_use_profile_queue).toBe(true);
    expect(row?.can_delete_leads).toBe(false);
    // user_business_access DOES have created_by, and it is the acting admin.
    expect(row?.created_by).toBe(ADMIN_ID);
  });

  it('manager role persists', async () => {
    const result = await createTeamUser(
      admin,
      { email: 'a-manager@team.test', fullName: 'A Manager', role: 'manager', status: 'active', grant: null },
      fastHash,
    );
    expect(result.ok, result.error).toBe(true);
    expect(await column<string>('users', 'id = $1', [result.id], 'role')).toBe('manager');
  });

  it('standard user role persists', async () => {
    const result = await createTeamUser(
      admin,
      { email: 'a-user@team.test', fullName: 'A User', role: 'user', status: 'active', grant: null },
      fastHash,
    );
    expect(result.ok, result.error).toBe(true);
    expect(await column<string>('users', 'id = $1', [result.id], 'role')).toBe('user');
  });

  it('a duplicate email is refused with an operator-safe message and writes nothing', async () => {
    const first = await createTeamUser(
      admin,
      { email: 'dup@team.test', fullName: 'Dup One', role: 'user', status: 'active', grant: null },
      fastHash,
    );
    expect(first.ok, first.error).toBe(true);

    const before = await withoutRowSecurity(async () =>
      h.db.query<{ n: number }>(
        `select count(*)::int as n from public.users where email = 'dup@team.test'`,
      ),
    );

    const second = await createTeamUser(
      admin,
      { email: 'dup@team.test', fullName: 'Dup Two', role: 'user', status: 'active', grant: null },
      fastHash,
    );
    expect(second.ok).toBe(false);
    expect(second.error).toBe('That record already exists.');
    expect(second.error).not.toMatch(/duplicate key|users_email|23505/i);

    const after = await withoutRowSecurity(async () =>
      h.db.query<{ n: number }>(
        `select count(*)::int as n from public.users where email = 'dup@team.test'`,
      ),
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));
  });

  it('an invalid (too-short) password hash is refused by the credential function and rolls the profile back', async () => {
    const before = await countRows('users', `email = 'bad-pw@team.test'`, []);

    const result = await createTeamUser(
      admin,
      { email: 'bad-pw@team.test', fullName: 'Bad Pw', role: 'user', status: 'active', grant: null, password: 'x' },
      // `set_user_credential` requires a hash of at least 20 characters (0015).
      () => Promise.resolve('short'),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    // The whole transaction must roll back: no orphaned profile that can never sign in.
    const after = await countRows('users', `email = 'bad-pw@team.test'`, []);
    expect(after).toBe(before);
  });

  it('refuses a non-admin actor', async () => {
    const manager = await loadViewer({ kind: 'user', userId: MANAGER_ID });

    const result = await createTeamUser(
      manager,
      { email: 'by-manager@team.test', fullName: 'By Manager', role: 'user', status: 'active', grant: null },
      fastHash,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/row-level security|42501|policy/i);

    const written = await countRows('users', `email = 'by-manager@team.test'`, []);
    expect(written).toBe(0);
  });
});

describe('createTeamUser — the successful transaction leaves a complete, auditable record', () => {
  const email = 'full-txn@team.test';
  const password = 'full-transaction-password-1';

  it('persists the user, the grant, the credential, and an audit event naming the actor', async () => {
    const result = await createTeamUser(
      admin,
      {
        email,
        fullName: 'Full Transaction',
        role: 'manager',
        status: 'active',
        password,
        grant: {
          businessId: BUSINESS_ID,
          accessLevel: 'user',
          canManageLeads: false,
          canUseLeadSources: true,
          canUseProfileQueue: false,
          canDeleteLeads: false,
        },
      },
      hashPassword,
    );
    expect(result.ok, result.error).toBe(true);
    const userId = result.id as string;

    await h.db.exec('set row_security = off');

    // 1. the profile
    const user = await h.db.query<Record<string, unknown>>(
      'select email, full_name, role, status from public.users where id = $1',
      [userId],
    );
    expect(user.rows[0]?.email).toBe(email);
    expect(user.rows[0]?.full_name).toBe('Full Transaction');
    expect(user.rows[0]?.role).toBe('manager');
    expect(user.rows[0]?.status).toBe('active');

    // 2. the optional business grant
    const grants = await h.db.query<{ n: number }>(
      'select count(*)::int as n from public.user_business_access where user_id = $1',
      [userId],
    );
    expect(Number(grants.rows[0]?.n)).toBe(1);

    // 3. the optional credential
    const creds = await h.db.query<{ n: number }>(
      'select count(*)::int as n from public.user_credentials where user_id = $1',
      [userId],
    );
    expect(Number(creds.rows[0]?.n)).toBe(1);

    // 4. provenance via the audit trail — the reason dropping users.created_by loses nothing.
    const audit = await h.db.query<Record<string, unknown>>(
      `select actor_type, actor_id, action
         from public.audit_events
        where entity_id = $1 and entity_type = 'users'
        order by created_at`,
      [userId],
    );
    expect(audit.rows.length, 'no audit event was written for the new user').toBeGreaterThan(0);
    expect(audit.rows[0]?.actor_type).toBe('user');
    expect(audit.rows[0]?.actor_id).toBe(ADMIN_ID);
  });
});
