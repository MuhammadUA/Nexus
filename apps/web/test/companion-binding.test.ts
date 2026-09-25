/**
 * Companion browser binding, driven through the real route handlers.
 *
 * spec `roles_and_permissions.same_user_multiple_browsers` allows an identity's concurrent use to
 * be warned about or blocked, and the intended flow is `warn -> explicit decision`, never a silent
 * takeover. This walks that flow against the real database, the real RLS policies and the real
 * `browser_sessions_active_identity_key` index, because that index is what makes the question
 * exist in the first place.
 *
 * The handlers are called directly with a `Request` carrying a real bearer token. That exercises
 * credential resolution, body validation, the concurrency decision, the transfer, the constraint
 * and the audit entry ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â everything except the HTTP transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withServiceRole } from '@/lib/actor';
import { generateUserToken } from '@/lib/gateway';
import { POST as bindRoute } from '@/app/api/v1/companion/bind/route';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;

const ADMIN_ID = 'f0000000-0000-4000-8000-000000000001';
const MANAGER_ID = 'f0000000-0000-4000-8000-000000000002';
/** Global role `user`, but an admin-level grant on the test business: the transfer boundary. */
const BUSINESS_ADMIN_ID = 'f0000000-0000-4000-8000-000000000003';
const BUSINESS_ID = 'f0000000-0000-4000-8000-000000000004';
const IDENTITY_ID = 'f0000000-0000-4000-8000-000000000005';

/** Issues a bearer token the way `/companion/session` does, and returns the raw value. */
async function issueToken(userId: string): Promise<string> {
  const token = generateUserToken();
  await withServiceRole('test: issue user token', async (sql) => {
    await sql.query(`select public.issue_user_token($1, $2, $3, $4, 'companion', 30)`, [
      userId,
      token.hash,
      token.prefix,
      'test',
    ]);
  });
  return token.raw;
}

function bindRequest(token: string, body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1:3000/api/v1/companion/bind', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

let adminToken: string;
let managerToken: string;
let businessAdminToken: string;

beforeAll(async () => {
  h = await createAppHarness();

  await h.db.exec('set row_security = off');
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status) values
       ($1, 'bind-admin@nexus.test', 'Bind Admin', 'admin', 'active'),
       ($2, 'bind-manager@nexus.test', 'Bind Manager', 'manager', 'active'),
       ($3, 'bind-bizadmin@nexus.test', 'Bind Business Admin', 'user', 'active')`,
    [ADMIN_ID, MANAGER_ID, BUSINESS_ADMIN_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'bind-test', 'Bind Test Co', 'active', $2)`,
    [BUSINESS_ID, ADMIN_ID],
  );
  // The third account has global role `user` with an admin-level grant on this business: it may
  // transfer (the grant is the permission), but it still cannot see another operator's browser
  // session, because `browser_sessions` RLS is per-user and not scoped by business.
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values
       ($1, $4, 'admin',   true, true, true, true,  $1),
       ($2, $4, 'manager', true, true, true, false, $1),
       ($3, $4, 'admin',   true, true, true, false, $1)`,
    [ADMIN_ID, MANAGER_ID, BUSINESS_ADMIN_ID, BUSINESS_ID],
  );
  await h.db.query(
    `insert into public.outreach_identities (id, platform, display_name, profile_url, managed_by_user_id, status, daily_target, created_by)
     values ($1, 'linkedin', 'Osama - Bind', 'https://www.linkedin.com/in/osama-bind', null, 'active', 25, $2)`,
    [IDENTITY_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.outreach_identity_business_access (outreach_identity_id, business_id)
     values ($1, $2)`,
    [IDENTITY_ID, BUSINESS_ID],
  );
  await h.db.exec('set row_security = on');

  [adminToken, managerToken, businessAdminToken] = await Promise.all([
    issueToken(ADMIN_ID),
    issueToken(MANAGER_ID),
    issueToken(BUSINESS_ADMIN_ID),
  ]);

}, 240_000);

afterAll(async () => {
  await h.close();
});

/**
 * Every case starts from no live sessions.
 *
 * A leftover binding from a previous case would hold the identity under test, which the
 * one-active-session-per-identity index then turns into a unique violation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the same failure a
 * real operator sees, arrived at for an unrelated reason. Each case seeds exactly the sessions it
 * is about.
 */
beforeEach(async () => {
  await withServiceRole('test: clear sessions', async (sql) => {
    await sql.query(`update public.browser_sessions set status = 'revoked', revoked_at = now() where status = 'active'`);
  });
});

/** Creates a live session holding the identity, as another browser profile would. */
async function seedHoldingSession(installId: string, userId = ADMIN_ID): Promise<string> {
  const result = await withServiceRole('test: seed holding session', async (sql) =>
    sql.query<{ id: string }>(
      `insert into public.browser_sessions
         (user_id, browser_fingerprint_or_install_id, outreach_identity_id, default_business_id, status, last_active_at)
       values ($1, $2, $3, $4, 'active', now())
       returning id`,
      [userId, installId, IDENTITY_ID, BUSINESS_ID],
    ),
  );
  return result.rows[0]?.id ?? '';
}

describe('binding an identity that is already in use', () => {
  it('refuses with the holder named, and does not revoke anything', async () => {
    const held = await seedHoldingSession('other-profile-1');

    const response = await bindRoute(
      bindRequest(adminToken, {
        installId: 'my-profile-1',
        identityId: IDENTITY_ID,
        defaultBusinessId: BUSINESS_ID,
      }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: string;
      reason?: string;
      canTransfer?: boolean;
      conflicts?: readonly { sessionId: string; operatorName: string | null }[];
    };
    expect(body.reason).toBe('identity_in_use');
    expect(body.canTransfer).toBe(true);
    expect(body.conflicts?.[0]?.sessionId).toBe(held);
    expect(body.conflicts?.[0]?.operatorName).toBe('Bind Admin');

    // The refused attempt must have left the holder alone: refusing is not a takeover.
    const stillActive = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.browser_sessions where id = $1 and status = 'active'`,
      [held],
    );
    expect(stillActive.rows[0]?.n).toBe(1);

    const binding = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.browser_sessions
        where browser_fingerprint_or_install_id = 'my-profile-1'`,
    );
    expect(binding.rows[0]?.n).toBe(0);
  });

  it('transfers when an administrator asks for it, revoking the holder and auditing it', async () => {
    const held = await seedHoldingSession('other-profile-2');

    const response = await bindRoute(
      bindRequest(adminToken, {
        installId: 'my-profile-2',
        identityId: IDENTITY_ID,
        defaultBusinessId: BUSINESS_ID,
        transfer: true,
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { transferredFrom: number };
    expect(body.transferredFrom).toBeGreaterThanOrEqual(1);

    const holder = await h.db.query<{ status: string; revoked_at: string | null }>(
      `select status, revoked_at from public.browser_sessions where id = $1`,
      [held],
    );
    expect(holder.rows[0]?.status).toBe('revoked');
    expect(holder.rows[0]?.revoked_at).not.toBeNull();

    const mine = await h.db.query<{ status: string }>(
      `select status from public.browser_sessions where browser_fingerprint_or_install_id = 'my-profile-2'`,
    );
    expect(mine.rows[0]?.status).toBe('active');

    // Invariant 20: the transfer is recorded, with what it revoked.
    const audit = await h.db.query<{ action: string; after_json: unknown }>(
      `select action, after_json from public.audit_events
        where entity_id = $1 and action = 'identity_transfer'
        order by created_at desc limit 1`,
      [IDENTITY_ID],
    );
    expect(audit.rows[0]?.action).toBe('identity_transfer');
    expect(JSON.stringify(audit.rows[0]?.after_json)).toContain(held);
  });

  it('lets an operator transfer their own other browser profile', async () => {
    // The holder is this operator's own other profile, and an admin-level grant on the business is
    // the permission to take it back. The holder's row is visible to them, so the transfer can
    // actually complete.
    const held = await seedHoldingSession('other-profile-3', BUSINESS_ADMIN_ID);

    const response = await bindRoute(
      bindRequest(businessAdminToken, {
        installId: 'my-profile-3',
        identityId: IDENTITY_ID,
        defaultBusinessId: BUSINESS_ID,
        transfer: true,
      }),
    );

    expect(response.status).toBe(200);
    const holder = await h.db.query<{ status: string }>(
      `select status from public.browser_sessions where id = $1`,
      [held],
    );
    expect(holder.rows[0]?.status).toBe('revoked');

    const mine = await h.db.query<{ status: string }>(
      `select status from public.browser_sessions
        where browser_fingerprint_or_install_id = 'my-profile-3'`,
    );
    expect(mine.rows[0]?.status).toBe('active');
  });

  it('refuses to transfer an identity held by another operator when the actor cannot release it', async () => {
    // A manager holds the identity and is not an administrator, so they may not transfer it. The
    // refusal comes from the permission check, before anything is written.
    await seedHoldingSession('manager-profile', MANAGER_ID);

    const response = await bindRoute(
      bindRequest(managerToken, {
        installId: 'my-profile-cross',
        identityId: IDENTITY_ID,
        defaultBusinessId: BUSINESS_ID,
        transfer: true,
      }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { reason?: string };
    expect(body.reason).toBe('transfer_not_permitted');

    const mine = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.browser_sessions
        where browser_fingerprint_or_install_id = 'my-profile-cross' and status = 'active'`,
    );
    expect(mine.rows[0]?.n).toBe(0);
  });

  it('allows a bind with no transfer when the identity is free', async () => {
    const response = await bindRoute(
      bindRequest(businessAdminToken, {
        installId: 'my-profile-free',
        identityId: IDENTITY_ID,
        defaultBusinessId: BUSINESS_ID,
      }),
    );

    expect(response.status).toBe(200);
    const mine = await h.db.query<{ status: string; outreach_identity_id: string }>(
      `select status, outreach_identity_id from public.browser_sessions
        where browser_fingerprint_or_install_id = 'my-profile-free'`,
    );
    expect(mine.rows[0]?.status).toBe('active');
    expect(mine.rows[0]?.outreach_identity_id).toBe(IDENTITY_ID);
  });

  it('rebinding the same profile to another identity does not revoke anyone else', async () => {
    // A second identity this browser may move to.
    const secondIdentity = 'f0000000-0000-4000-8000-000000000006';
    await withServiceRole('test: second identity', async (sql) => {
      await sql.query(
        `insert into public.outreach_identities
           (id, platform, display_name, profile_url, managed_by_user_id, status, daily_target, created_by)
         values ($1, 'linkedin', 'Bisma - Bind', 'https://www.linkedin.com/in/bisma-bind', $2, 'active', 20, $2)`,
        [secondIdentity, ADMIN_ID],
      );
      await sql.query(
        `insert into public.outreach_identity_business_access (outreach_identity_id, business_id) values ($1, $2)`,
        [secondIdentity, BUSINESS_ID],
      );
    });

    const response = await bindRoute(
      bindRequest(businessAdminToken, {
        installId: 'my-profile-free',
        identityId: secondIdentity,
        defaultBusinessId: BUSINESS_ID,
      }),
    );

    expect(response.status).toBe(200);
    const rows = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.browser_sessions
        where browser_fingerprint_or_install_id = 'my-profile-free' and status = 'active'`,
    );
    // One active session for this profile, not two.
    expect(rows.rows[0]?.n).toBe(1);
  });
});
