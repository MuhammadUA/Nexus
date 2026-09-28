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
 * and the audit entry — everything except the HTTP transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withActor, withServiceRole } from '@/lib/actor';
import { generateUserToken } from '@/lib/gateway';
import { POST as addRoute } from '@/app/api/v1/companion/add/route';
import { POST as bindRoute } from '@/app/api/v1/companion/bind/route';

// The panel's own selection logic, imported from the extension it ships in. It is pure
// (no React, no chrome), so the recalculation §36 requires is asserted here without a
// browser — the same function the side panel calls.
import { companionScope, shellBusinesses } from '../../extension/src/binding-scope';

import { createAppHarness, type AppHarness } from './harness';

let h: AppHarness;

const ADMIN_ID = 'f0000000-0000-4000-8000-000000000001';
const MANAGER_ID = 'f0000000-0000-4000-8000-000000000002';
/** Global role `user`, but an admin-level grant on the test business: the transfer boundary. */
const BUSINESS_ADMIN_ID = 'f0000000-0000-4000-8000-000000000003';
const BUSINESS_ID = 'f0000000-0000-4000-8000-000000000004';
const IDENTITY_ID = 'f0000000-0000-4000-8000-000000000005';

/* ---------------------------------------------------------- V1.2 §36 -- */
/** A second business, available to `IDENTITY_B_ID` and not to `IDENTITY_ID`. */
const BUSINESS_B_ID = 'f0000000-0000-4000-8000-000000000007';
const IDENTITY_B_ID = 'f0000000-0000-4000-8000-000000000008';
/** A user with no `user_business_access` row at all. */
const UNGRANTED_USER_ID = 'f0000000-0000-4000-8000-000000000009';
/** An identity that user manages, available to a business they hold no grant on. */
const UNGRANTED_IDENTITY_ID = 'f0000000-0000-4000-8000-00000000000a';
/** An identity the *manager* manages, available to `BUSINESS_ID` only. */
const MANAGED_IDENTITY_ID = 'f0000000-0000-4000-8000-00000000000b';
/** A well-formed id no business uses, for the non-disclosure check. */
const UNKNOWN_BUSINESS_ID = 'f0000000-0000-4000-8000-0000000000ff';

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

function addRequest(token: string, body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1:3000/api/v1/companion/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

let adminToken: string;
let managerToken: string;
let businessAdminToken: string;
let ungrantedToken: string;

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

  /**
   * V1.2 §36 fixtures.
   *
   * The pairs below are chosen so every eligibility case is a *different* obstacle rather
   * than the same one reached twice:
   *
   *   * `IDENTITY_ID` is available to `BUSINESS_ID` only, so a pair with `BUSINESS_B_ID`
   *     is "no account access" for anyone — including a global administrator, which is
   *     the case that proves the admin branch widens visibility but not binding.
   *   * `UNGRANTED_IDENTITY_ID` is managed by `UNGRANTED_USER_ID` and available to
   *     `BUSINESS_ID`, which that user holds no grant on: "no user grant" with account
   *     access present.
   *   * `MANAGER_ID` gets a grant on `BUSINESS_B_ID`, so their pair with `IDENTITY_ID`
   *     is a genuine "has a grant, account not available" rather than a double negative.
   */
  await h.db.query(
    `insert into public.users (id, email, full_name, role, status)
     values ($1, 'bind-ungranted@nexus.test', 'Bind Ungranted', 'user', 'active')`,
    [UNGRANTED_USER_ID],
  );
  await h.db.query(
    `insert into public.businesses (id, key, name, status, created_by)
     values ($1, 'bind-test-b', 'Bind Test B Co', 'active', $2)`,
    [BUSINESS_B_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.user_business_access
       (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
     values ($1, $2, 'manager', true, true, true, false, $3)`,
    [MANAGER_ID, BUSINESS_B_ID, ADMIN_ID],
  );
  await h.db.query(
    `insert into public.outreach_identities
       (id, platform, display_name, profile_url, managed_by_user_id, status, daily_target, created_by)
     values
       ($1, 'linkedin', 'Osama - Bind B', 'https://www.linkedin.com/in/osama-bind-b', $3, 'active', 10, $3),
       ($2, 'linkedin', 'Ungranted - Bind', 'https://www.linkedin.com/in/ungranted-bind', $4, 'active', 10, $3),
       ($5, 'linkedin', 'Managed - Bind', 'https://www.linkedin.com/in/managed-bind', $6, 'active', 10, $3)`,
    [IDENTITY_B_ID, UNGRANTED_IDENTITY_ID, ADMIN_ID, UNGRANTED_USER_ID, MANAGED_IDENTITY_ID, MANAGER_ID],
  );
  await h.db.query(
    `insert into public.outreach_identity_business_access (outreach_identity_id, business_id) values
       ($1, $3),
       ($2, $4),
       ($5, $4)`,
    [IDENTITY_B_ID, UNGRANTED_IDENTITY_ID, BUSINESS_B_ID, BUSINESS_ID, MANAGED_IDENTITY_ID],
  );
  await h.db.exec('set row_security = on');

  [adminToken, managerToken, businessAdminToken, ungrantedToken] = await Promise.all([
    issueToken(ADMIN_ID),
    issueToken(MANAGER_ID),
    issueToken(BUSINESS_ADMIN_ID),
    issueToken(UNGRANTED_USER_ID),
  ]);

}, 240_000);

afterAll(async () => {
  await h.close();
});

/**
 * Every case starts from no live sessions.
 *
 * A leftover binding from a previous case would hold the identity under test, which the
 * one-active-session-per-identity index then turns into a unique violation — the same failure a
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

/* ===========================================================================
 * V1.2 §36 — which (channel account, business) pairs are bindable
 *
 * The production defect was that the Companion offered every business the user could
 * reach and the server accepted any pair the identity could reach, so the two answers
 * disagreed. `public.companion_ineligible_reason` is now the single rule, and these
 * cases pin each branch of it — including the global-administrator branch, which exists
 * because an administrator holds no `user_business_access` row and the old intersection
 * therefore came back empty for them.
 * ======================================================================== */

/** The database's reason code for one pair, evaluated as a signed-in user. */
async function scopeReason(
  userId: string,
  identityId: string,
  businessId: string | null,
): Promise<string> {
  return withActor({ kind: 'user', userId }, async (sql) => {
    const result = await sql.query<{ reason: string }>(
      `select public.companion_ineligible_reason($1, $2) as reason`,
      [identityId, businessId],
    );
    return result.rows[0]?.reason ?? '';
  });
}

/** The businesses the visibility helper offers for one account, as a signed-in user. */
async function visibleBusinesses(userId: string, identityId: string): Promise<readonly string[]> {
  return withActor({ kind: 'user', userId }, async (sql) => {
    const result = await sql.query<{ ids: string[] }>(
      `select coalesce(array_agg(v order by v), array[]::uuid[]) as ids
         from public.companion_visible_business_ids($1) as t(v)`,
      [identityId],
    );
    return result.rows[0]?.ids ?? [];
  });
}

describe('binding scope: the (channel account, business) matrix', () => {
  it('global admin + account business access is eligible', async () => {
    expect(await scopeReason(ADMIN_ID, IDENTITY_ID, BUSINESS_ID)).toBe('ok');
  });

  it('global admin without account access is NOT eligible', async () => {
    // The administrator has a `user_business_access` row for every business, so this
    // case isolates the account-access requirement: visibility was widened for admins,
    // binding authority was not.
    expect(await scopeReason(ADMIN_ID, IDENTITY_ID, BUSINESS_B_ID)).toBe('no_account_access');
  });

  it('user grant + account access is eligible', async () => {
    // The account's own manager, with a grant on the business it sends from.
    expect(await scopeReason(MANAGER_ID, MANAGED_IDENTITY_ID, BUSINESS_ID)).toBe('ok');
    // A business-level administrator: their admin-level grant is what makes the account
    // usable for them (the same predicate the browser_sessions policy uses, 0017).
    expect(await scopeReason(BUSINESS_ADMIN_ID, IDENTITY_ID, BUSINESS_ID)).toBe('ok');
    // A global administrator.
    expect(await scopeReason(ADMIN_ID, IDENTITY_ID, BUSINESS_ID)).toBe('ok');
  });

  it('user grant without account access is NOT eligible', async () => {
    // The manager holds a grant on B and manages the account; the account is not
    // available to B, so the account is the obstacle.
    expect(await scopeReason(MANAGER_ID, MANAGED_IDENTITY_ID, BUSINESS_B_ID)).toBe('no_account_access');
  });

  it('account access without a user grant is NOT eligible for a non-admin', async () => {
    // The account is available to the business and the user manages the account, but
    // they hold no `user_business_access` row for it.
    expect(await scopeReason(UNGRANTED_USER_ID, UNGRANTED_IDENTITY_ID, BUSINESS_ID)).toBe(
      'no_user_grant',
    );
  });

  it('an identity the actor may not use reports identity_not_usable', async () => {
    expect(await scopeReason(MANAGER_ID, UNGRANTED_IDENTITY_ID, BUSINESS_ID)).toBe(
      'identity_not_usable',
    );
  });

  it('never discloses whether a business exists', async () => {
    // An unknown id and an existing business the account cannot reach answer the same
    // way, so a crafted probe learns nothing about the tenant.
    expect(await scopeReason(MANAGER_ID, IDENTITY_ID, UNKNOWN_BUSINESS_ID)).toBe(
      await scopeReason(MANAGER_ID, IDENTITY_ID, BUSINESS_B_ID),
    );
    expect(await scopeReason(ADMIN_ID, IDENTITY_ID, UNKNOWN_BUSINESS_ID)).toBe('no_account_access');
    // A refused pair is refused after the business is gone from consideration entirely.
    expect(await scopeReason(ADMIN_ID, IDENTITY_ID, null)).toBe('ok');
  });
});

describe('binding scope: effective visibility', () => {
  it('a global administrator sees every business the account is available to, without a grant', async () => {
    // The administrator has no `user_business_access` row for B at all; the account does.
    expect(await visibleBusinesses(ADMIN_ID, IDENTITY_B_ID)).toEqual([BUSINESS_B_ID]);
  });

  it('a non-admin without a grant sees nothing, so the intersection is never a union', async () => {
    expect(await visibleBusinesses(UNGRANTED_USER_ID, UNGRANTED_IDENTITY_ID)).toEqual([]);
    // ...and a user with a grant on another business gets only their own intersection.
    expect(await visibleBusinesses(MANAGER_ID, IDENTITY_B_ID)).toEqual([BUSINESS_B_ID]);
  });
});

describe('binding scope: a crafted pair is refused server-side', () => {
  it('refuses a pair the actor holds no grant for, with the specific reason and no write', async () => {
    const response = await bindRoute(
      bindRequest(ungrantedToken, {
        installId: 'crafted-no-grant',
        identityId: UNGRANTED_IDENTITY_ID,
        defaultBusinessId: BUSINESS_ID,
      }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { reason?: string; error?: string };
    expect(body.reason).toBe('no_user_grant');
    expect(body.error ?? '').toMatch(/grant/i);

    const rows = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.browser_sessions
        where browser_fingerprint_or_install_id = 'crafted-no-grant'`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('refuses a business the account is not available to', async () => {
    const response = await bindRoute(
      bindRequest(managerToken, {
        installId: 'crafted-no-account',
        identityId: MANAGED_IDENTITY_ID,
        defaultBusinessId: BUSINESS_B_ID,
      }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { reason?: string; error?: string };
    expect(body.reason).toBe('no_account_access');
    expect(body.error ?? '').toMatch(/not available to that business/i);
  });

  it('refuses a global administrator the same pair', async () => {
    const response = await bindRoute(
      bindRequest(adminToken, {
        installId: 'crafted-admin-no-account',
        identityId: IDENTITY_ID,
        defaultBusinessId: BUSINESS_B_ID,
      }),
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason?: string }).reason).toBe('no_account_access');
  });

  it('is refused by the database too, so bypassing the route does not help', async () => {
    // The repository check is the explanation; this is the authorization, applied by the
    // trigger to any signed-in write that names the pair.
    const failure = await withActor({ kind: 'user', userId: UNGRANTED_USER_ID }, async (sql) => {
      try {
        await sql.query(
          `insert into public.browser_sessions
             (user_id, browser_fingerprint_or_install_id, outreach_identity_id, default_business_id, status)
           values ($1, 'crafted-direct-write', $2, $3, 'active')`,
          [UNGRANTED_USER_ID, UNGRANTED_IDENTITY_ID, BUSINESS_ID],
        );
        return null;
      } catch (error) {
        return error as { code?: string; message?: string };
      }
    });

    expect(failure?.code).toBe('42501');
    expect(failure?.message ?? '').toContain('no_user_grant');
  });
});

/* ===========================================================================
 * The panel's own recalculation, §36/§61 — pure selection state, no DOM.
 * ======================================================================== */

describe('the panel recalculates the business list when the channel account changes', () => {
  const businesses = [
    { id: BUSINESS_ID, name: 'Bind Test Co', slug: 'bind-test' },
    { id: BUSINESS_B_ID, name: 'Bind Test B Co', slug: 'bind-test-b' },
  ] as const;

  const identities = [
    { id: IDENTITY_ID, displayName: 'Osama - Bind', status: 'active', businessIds: [BUSINESS_ID] },
    { id: IDENTITY_B_ID, displayName: 'Osama - Bind B', status: 'active', businessIds: [BUSINESS_B_ID] },
  ] as const;

  it('offers only the businesses the selected account may send from', () => {
    const scope = companionScope({ businesses, identities, identityId: IDENTITY_ID, businessId: '' });
    expect(scope.eligible.map((business) => business.id)).toEqual([BUSINESS_ID]);
    expect(scope.businessId).toBe(BUSINESS_ID);
    expect(scope.canBind).toBe(true);
    expect(scope.message).toBe('');
  });

  it('recalculates on switch and drops a selection the new account cannot reach', () => {
    const scope = companionScope({
      businesses,
      identities,
      identityId: IDENTITY_B_ID,
      businessId: BUSINESS_ID,
    });
    expect(scope.eligible.map((business) => business.id)).toEqual([BUSINESS_B_ID]);
    expect(scope.businessId).toBe(BUSINESS_B_ID);
    expect(scope.canBind).toBe(true);
  });

  it('keeps a selection the new account can still reach', () => {
    const both = [
      { id: IDENTITY_ID, displayName: 'One', status: 'active', businessIds: [BUSINESS_ID, BUSINESS_B_ID] },
      { id: IDENTITY_B_ID, displayName: 'Two', status: 'active', businessIds: [BUSINESS_ID, BUSINESS_B_ID] },
    ];
    const scope = companionScope({
      businesses,
      identities: both,
      identityId: IDENTITY_B_ID,
      businessId: BUSINESS_B_ID,
    });
    expect(scope.businessId).toBe(BUSINESS_B_ID);
  });

  it('prefers the stored binding when the current selection is invalid', () => {
    const scope = companionScope({
      businesses,
      identities,
      identityId: IDENTITY_B_ID,
      businessId: '',
      preferredBusinessId: BUSINESS_B_ID,
    });
    expect(scope.businessId).toBe(BUSINESS_B_ID);
  });

  it('disables Bind with the specific reason when no business is eligible', () => {
    // The account is not assigned to any business.
    const unassigned = companionScope({
      businesses,
      identities: [{ id: IDENTITY_B_ID, displayName: 'Unassigned', status: 'active', businessIds: [] }],
      identityId: IDENTITY_B_ID,
      businessId: BUSINESS_ID,
    });
    expect(unassigned.eligible).toEqual([]);
    expect(unassigned.businessId).toBe('');
    expect(unassigned.canBind).toBe(false);
    expect(unassigned.reason).toBe('no_account_access');
    expect(unassigned.message).toMatch(/not assigned to any business/i);

    // The account is assigned, but the operator holds no grant on any of its businesses.
    const ungranted = companionScope({
      businesses: [],
      identities,
      identityId: IDENTITY_ID,
      businessId: '',
    });
    expect(ungranted.canBind).toBe(false);
    expect(ungranted.reason).toBe('no_user_grant');
    expect(ungranted.message).toMatch(/do not have access/i);

    // Neither sentence is the generic permission message this replaces.
    expect(unassigned.message).not.toMatch(/permission/i);
    expect(ungranted.message).not.toMatch(/permission/i);
  });

  it('does not crash on an empty business list', () => {
    const scope = companionScope({ businesses: [], identities, identityId: IDENTITY_ID, businessId: '' });
    expect(scope.eligible).toEqual([]);
    expect(scope.canBind).toBe(false);
    expect(scope.businessId).toBe('');
    expect(shellBusinesses([], identities, IDENTITY_ID)).toEqual([]);
  });

  it('reports a missing or unusable account instead of offering everything', () => {
    const none = companionScope({ businesses, identities, identityId: '', businessId: BUSINESS_ID });
    expect(none.reason).toBe('no_identity');
    expect(none.eligible).toEqual([]);

    const paused = companionScope({
      businesses,
      identities: [{ id: IDENTITY_ID, displayName: 'Paused', status: 'paused', businessIds: [BUSINESS_ID] }],
      identityId: IDENTITY_ID,
      businessId: BUSINESS_ID,
    });
    expect(paused.reason).toBe('identity_not_usable');
    expect(paused.canBind).toBe(false);
  });

  it('narrows the shell selector to the account, but not for an account it does not know', () => {
    expect(shellBusinesses(businesses, identities, IDENTITY_ID).map((b) => b.id)).toEqual([BUSINESS_ID]);
    // An unknown account has no scope to apply; the list is left alone rather than emptied,
    // so an archived binding does not take the whole panel down.
    expect(shellBusinesses(businesses, identities, 'unknown-account')).toHaveLength(2);
  });
});

/* ===========================================================================
 * V1.2 §36 — a minimal lead: name, company, location, source, and nothing invented.
 * ======================================================================== */

describe('minimal lead capture', () => {
  it('a permissioned operator: creates the lead from a name, company, location and source, and lands in NEEDS_PROFILE', async () => {
    const response = await addRoute(
      addRequest(businessAdminToken, {
        businessId: BUSINESS_ID,
        idempotencyKey: `minimal-lead-${String(Date.now())}`,
        fullName: 'Nora Minimal',
        companyName: 'Minimal Works',
        location: 'Berlin, Germany',
        source: 'companion',
        jobTitle: 'Head of Media',
      }),
    );

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const body = (await response.json()) as {
      leadId: string;
      needsProfile: boolean;
      enrichmentStatus?: string;
      findLinkedInUrl?: string | null;
    };

    // No profile URL was supplied, so the lead is partial by definition and the
    // enrichment row the database seeds says so.
    expect(body.needsProfile).toBe(true);
    expect(body.enrichmentStatus).toBe('NEEDS_PROFILE');

    const enrichment = await h.db.query<{ status: string; completeness_score: number }>(
      `select status, completeness_score from public.lead_enrichment where lead_id = $1`,
      [body.leadId],
    );
    expect(enrichment.rows[0]?.status).toBe('NEEDS_PROFILE');
    // The score is the pipeline's to set; the capture must not invent one.
    expect(enrichment.rows[0]?.completeness_score).toBe(0);

    // Everything supplied is stored, and nothing else is manufactured.
    const person = await h.db.query<{ full_name: string; job_title: string | null; location: string | null; linkedin_url: string | null }>(
      `select p.full_name, p.job_title, p.location, p.linkedin_url
         from public.people p
         join public.leads l on l.person_id = p.id
        where l.id = $1`,
      [body.leadId],
    );
    expect(person.rows[0]).toEqual({
      full_name: 'Nora Minimal',
      job_title: 'Head of Media',
      location: 'Berlin, Germany',
      linkedin_url: null,
    });

    // The generated-search affordance is the deterministic Google URL built by
    // `searchLinks` in @nexus/core — the panel never builds one of its own.
    expect(body.findLinkedInUrl ?? '').toContain('https://www.google.com/search?q=');
    expect(decodeURIComponent(body.findLinkedInUrl ?? '')).toContain('"Nora Minimal"');
    expect(decodeURIComponent(body.findLinkedInUrl ?? '')).toContain('site:linkedin.com/in');
  });

  it('an operator without lead-source capability is refused with a specific reason, not a generic failure', async () => {
    /**
     * `can_use_lead_sources` is what permits creating canonical rows, so an actor with no
     * `user_business_access` row at all must be refused — and refused *specifically*.
     * This is a requirement, not a bug: the panel has to be able to tell "you may not
     * add leads here" apart from "your payload was wrong".
     */
    const response = await addRoute(
      addRequest(ungrantedToken, {
        businessId: BUSINESS_ID,
        idempotencyKey: `minimal-lead-forbidden-${String(Date.now())}`,
        fullName: 'Not Permitted',
        companyName: 'Forbidden Works',
        location: 'Berlin, Germany',
        source: 'companion',
      }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { reason?: string; error?: string };
    expect(body.reason).toBe('not_permitted');
    expect(body.error ?? '').toMatch(/not permitted/i);

    // Nothing was written, canonical rows included.
    const written = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.people where full_name = 'Not Permitted'`,
    );
    expect(written.rows[0]?.n).toBe(0);
  });

  it('refuses a capture with neither a profile URL nor a person name', async () => {
    const response = await addRoute(
      addRequest(businessAdminToken, {
        businessId: BUSINESS_ID,
        idempotencyKey: `minimal-lead-empty-${String(Date.now())}`,
        companyName: 'No Name Co',
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { reason?: string };
    expect(body.reason).toBe('minimal_lead_incomplete');
  });

  it('keeps the profile-capture path working', async () => {
    const url = `https://www.linkedin.com/in/minimal-keep-${String(Date.now()).slice(-7)}`;
    const response = await addRoute(
      addRequest(businessAdminToken, {
        businessId: BUSINESS_ID,
        idempotencyKey: `capture-${String(Date.now())}`,
        linkedinUrl: url,
        pastedContent: 'Kerry Capture\nChief Editor at Kernel Works\nBerlin, Germany',
        icpId: null,
        autoMatch: true,
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { leadId: string; created: boolean; needsProfile: boolean };
    expect(body.leadId).toBeTruthy();
    // A profile URL with a company and title is not partial.
    expect(body.needsProfile).toBe(false);
  });
});
