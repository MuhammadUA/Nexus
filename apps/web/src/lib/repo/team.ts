/**
 * Team & accounts — users, their business grants and their lead scope.
 *
 * Screens A15 (`/team`) and A16 (`/team/[id]`).
 *
 * Everything here is admin-only and the database is the enforcement point:
 * `public.users`, `public.user_business_access` and `public.user_lead_scope` all
 * carry RLS policies that permit writes to `public.is_admin()` only, and
 * `public.set_user_credential` calls `public.require_admin` internally. The checks
 * this module performs exist so a screen can explain a refusal, not so the refusal
 * can be avoided.
 *
 * Reused from `businesses.ts` rather than re-implemented: `listUserGrants`,
 * `upsertUserGrant`, `revokeUserGrant`.
 */
import 'server-only';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Row } from '../sql';
import {
  asIso,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  describeDbError,
  read,
  readOne,
  type MutationResult,
} from './common';
import {
  listUserGrants,
  revokeUserGrant,
  upsertUserGrant,
  type UserBusinessGrantRow,
} from './businesses';

export type { MutationResult, UserBusinessGrantRow };
export { listUserGrants };

/** spec `roles_and_permissions.roles`. */
export const USER_ROLES = ['admin', 'manager', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** `users.status` (0002_tenancy.sql; not enumerated in the spec). */
export const USER_STATUSES = ['active', 'invited', 'suspended', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** `user_lead_scope.mode` (0002_tenancy.sql). */
export const LEAD_SCOPE_MODES = ['all', 'assigned', 'own'] as const;
export type LeadScopeMode = (typeof LEAD_SCOPE_MODES)[number];

export const ACCESS_LEVELS = ['admin', 'manager', 'user'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/* ------------------------------------------------------------------ users -- */

export interface TeamUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly timezone: string;
  readonly lastSeenAt: string | null;
  readonly createdAt: string | null;
  /** Rows in `user_business_access` — how many businesses they may see. */
  readonly businessCount: number;
  /** Live rows in `outreach_identities` managed by this user. */
  readonly identityCount: number;
  /** Browser sessions bound to an identity this user manages. */
  readonly activeSessionCount: number;
}

export interface UserDetail extends TeamUser {
  readonly updatedAt: string | null;
}

/**
 * The A15 roll-up.
 *
 * The three counts are correlated sub-selects rather than a join with `group by`,
 * so a user with no grants and no identities still returns exactly one row with
 * zeros instead of disappearing. The counting sub-selects read tables whose RLS
 * policies grant an admin everything, so the numbers always match what the identity
 * and permission screens would show for the same user.
 */
const USER_COUNTS = `
  (select count(*) from public.user_business_access a where a.user_id = u.id) as business_count,
  (select count(*) from public.outreach_identities i
    where i.managed_by_user_id = u.id and i.deleted_at is null) as identity_count,
  (select count(*) from public.browser_sessions s
     join public.outreach_identities i2 on i2.id = s.outreach_identity_id
    where i2.managed_by_user_id = u.id and s.status = 'active') as active_session_count
`;

function mapUser(row: Row): TeamUser {
  return {
    id: asString(row.id),
    email: asString(row.email),
    fullName: asStringOrNull(row.full_name),
    role: asString(row.role, 'user') as UserRole,
    status: asString(row.status, 'active') as UserStatus,
    timezone: asString(row.timezone, 'UTC'),
    lastSeenAt: asIso(row.last_seen_at),
    createdAt: asIso(row.created_at),
    businessCount: asNumber(row.business_count),
    identityCount: asNumber(row.identity_count),
    activeSessionCount: asNumber(row.active_session_count),
  };
}

const USER_SELECT = `
  select u.id, u.email, u.full_name, u.role, u.status, u.timezone,
         u.last_seen_at, u.created_at, u.updated_at,
         ${USER_COUNTS}
    from public.users u
   where u.deleted_at is null
`;

/** Every user profile row visible to the viewer, with grant and identity counts. */
export async function listTeamUsers(actor: Actor): Promise<readonly TeamUser[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(`${USER_SELECT} order by u.full_name nulls last, u.email`);
    return result.rows.map((row: Row) => mapUser(row));
  });
}

export async function getUser(actor: Actor, userId: string): Promise<UserDetail | null> {
  return readOne(actor, async (sql) => {
    const result = await sql.query<Row>(`${USER_SELECT} and u.id = $1`, [userId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return { ...mapUser(row), updatedAt: asIso(row.updated_at) };
  });
}

/** Business options for the create-user form and the grant editor (A15/A16). */
export interface BusinessOption {
  readonly id: string;
  readonly name: string;
  readonly key: string;
}

export async function listBusinessOptions(actor: Actor): Promise<readonly BusinessOption[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, key, name from public.businesses where deleted_at is null order by name`,
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      key: asString(row.key),
      name: asString(row.name),
    }));
  });
}

export interface CreateUserInput {
  readonly email: string;
  readonly fullName: string | null;
  readonly role: UserRole;
  readonly status: UserStatus;
  /**
   * Optional initial grant. `null` creates the profile with no business visibility
   * at all — RLS never implies access.
   */
  readonly grant: {
    readonly businessId: string;
    readonly accessLevel: AccessLevel;
    readonly canManageLeads: boolean;
    readonly canUseLeadSources: boolean;
    readonly canUseProfileQueue: boolean;
    readonly canDeleteLeads: boolean;
  } | null;
  /**
   * The plaintext password is used once, to derive a hash, and is then dropped. It
   * is never stored, returned or logged by this module.
   */
  readonly password?: string;
}

/** Derives the hash. Injected so this module never imports the crypto path itself. */
export type PasswordHasher = (password: string) => Promise<string>;

/**
 * Creates a user profile, optionally grants one business, and optionally sets the
 * local password.
 *
 * All three steps run inside a single `withActor` transaction *as the signed-in
 * admin*, so a failure anywhere (an email already taken, a password rejected by
 * `set_user_credential`) rolls the whole thing back rather than leaving a profile
 * that can never sign in. `set_user_credential` is admin-gated and SECURITY
 * DEFINER; the calling identity is therefore the admin from the session cookie,
 * never a value taken from the form.
 */
export async function createTeamUser(
  viewer: Viewer,
  input: CreateUserInput,
  hash: PasswordHasher,
): Promise<MutationResult> {
  try {
    // The hash is derived before the transaction opens: scrypt is deliberately slow
    // and holding a database transaction open across it would pin a connection.
    const passwordHash =
      input.password === undefined || input.password.length === 0 ? null : await hash(input.password);

    return await withActor(viewer.actor, async (sql) => {
      const created = await sql.query<{ id: string }>(
        `insert into public.users (email, full_name, role, status, created_by)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [input.email, input.fullName, input.role, input.status, viewer.userId],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) return { ok: false, error: 'The user was not created.' };

      if (input.grant !== null) {
        await sql.query(
          `insert into public.user_business_access
             (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources,
              can_use_profile_queue, can_delete_leads, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            input.grant.businessId,
            input.grant.accessLevel,
            input.grant.canManageLeads,
            input.grant.canUseLeadSources,
            input.grant.canUseProfileQueue,
            input.grant.canDeleteLeads,
            viewer.userId,
          ],
        );
      }

      if (passwordHash !== null) {
        // the hash goes straight into the database call and is never returned
        await sql.query(`select public.set_user_credential($1, $2)`, [id, passwordHash]);
      }

      return { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export interface UpdateUserInput {
  readonly fullName?: string | null;
  readonly role?: UserRole;
  readonly status?: UserStatus;
  readonly timezone?: string | null;
}

/**
 * Profile edits.
 *
 * `case when $n::boolean then ... else <column> end` is used instead of
 * `coalesce`: an explicit `null` for `fullName` clears the name, while an omitted
 * key leaves the column alone — the two are genuinely different requests.
 */
export async function updateTeamUser(
  viewer: Viewer,
  userId: string,
  input: UpdateUserInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `update public.users
            set full_name  = case when $2::boolean then $3 else full_name end,
                role       = case when $4::boolean then $5 else role end,
                status     = case when $6::boolean then $7 else status end,
                timezone   = case when $8::boolean then $9 else timezone end,
                updated_at = now()
          where id = $1 and deleted_at is null
          returning id`,
        [
          userId,
          input.fullName !== undefined,
          input.fullName ?? null,
          input.role !== undefined,
          input.role ?? null,
          input.status !== undefined,
          input.status ?? null,
          input.timezone !== undefined,
          input.timezone ?? null,
        ],
      );
      return result.rows[0] === undefined
        ? { ok: false, error: 'That user no longer exists.' }
        : { ok: true, id: userId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Sets (or rotates) a user's local password.
 *
 * spec `security_and_reliability.stack` names Supabase Auth as the production
 * provider; this is the local credential path from `0015_local_credentials.sql`.
 * The hash is produced here, handed to the SECURITY DEFINER function inside the
 * admin's transaction, and never returned.
 */
export async function setUserPassword(
  viewer: Viewer,
  userId: string,
  password: string,
  hash: PasswordHasher,
): Promise<MutationResult> {
  try {
    const passwordHash = await hash(password);
    return await withActor(viewer.actor, async (sql) => {
      await sql.query(`select public.set_user_credential($1, $2)`, [userId, passwordHash]);
      return { ok: true, id: userId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* ------------------------------------------------------------- lead scope -- */

export interface UserLeadScope {
  readonly userId: string;
  readonly businessId: string;
  readonly mode: LeadScopeMode;
  readonly icpIds: readonly string[];
}

export async function listUserLeadScopes(
  actor: Actor,
  userId: string,
): Promise<readonly UserLeadScope[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select user_id, business_id, mode, icp_ids
         from public.user_lead_scope
        where user_id = $1`,
      [userId],
    );
    return result.rows.map((row: Row) => ({
      userId: asString(row.user_id),
      businessId: asString(row.business_id),
      mode: asString(row.mode, 'all') as LeadScopeMode,
      icpIds: asStringArray(row.icp_ids),
    }));
  });
}

/**
 * Upserts the lead scope for one (user, business) pair. Admin-only by RLS.
 *
 * An empty `icp_ids` means "every ICP in this business": spec `lead_invariants`
 * allows a lead to match several ICPs, so narrowing is opt-in.
 */
export async function upsertUserLeadScope(
  viewer: Viewer,
  input: UserLeadScope,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ business_id: string }>(
        `insert into public.user_lead_scope (user_id, business_id, mode, icp_ids, updated_at)
         values ($1, $2, $3, $4::uuid[], now())
         on conflict (user_id, business_id) do update
           set mode = excluded.mode,
               icp_ids = excluded.icp_ids,
               updated_at = now()
         returning business_id`,
        [input.userId, input.businessId, input.mode, [...input.icpIds]],
      );
      return result.rows[0] === undefined
        ? { ok: false, error: 'The lead scope was not saved.' }
        : { ok: true, id: result.rows[0].business_id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/** Removes a scope row so the role default applies again. */
export async function clearUserLeadScope(
  viewer: Viewer,
  userId: string,
  businessId: string,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `delete from public.user_lead_scope where user_id = $1 and business_id = $2`,
        [userId, businessId],
      );
      return result.affectedRows === 0
        ? { ok: false, error: 'That lead scope no longer exists.' }
        : { ok: true };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* ------------------------------------------------------------- identities -- */

export interface ManagedIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly platform: string;
  readonly status: string;
  readonly dailyTarget: number;
  readonly dailySentCount: number;
}

/**
 * Identities assigned to a user (spec `roles_and_permissions.user.can`: "Use only
 * LinkedIn identities assigned to them").
 */
export async function listIdentitiesForUser(
  actor: Actor,
  userId: string,
): Promise<readonly ManagedIdentity[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, display_name, platform, status, daily_target, daily_sent_count
         from public.outreach_identities
        where managed_by_user_id = $1 and deleted_at is null
        order by display_name`,
      [userId],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      displayName: asString(row.display_name),
      platform: asString(row.platform, 'linkedin'),
      status: asString(row.status, 'active'),
      dailyTarget: asNumber(row.daily_target),
      dailySentCount: asNumber(row.daily_sent_count),
    }));
  });
}

/* -------------------------------------------------- grant + scope writes -- */

/**
 * A16 edits one (user, business) pair at a time, so the grant and its lead scope
 * are saved together. This wrapper is what keeps that rule in one place instead of
 * relying on the page to remember the second half.
 */
export interface GrantAndScopeInput {
  readonly userId: string;
  readonly businessId: string;
  readonly accessLevel: AccessLevel;
  readonly canManageLeads: boolean;
  readonly canUseLeadSources: boolean;
  readonly canUseProfileQueue: boolean;
  readonly canDeleteLeads: boolean;
  readonly leadScopeMode: LeadScopeMode;
  readonly icpIds: readonly string[];
}

export async function saveUserGrant(
  viewer: Viewer,
  input: GrantAndScopeInput,
): Promise<MutationResult> {
  const granted = await upsertUserGrant(viewer, {
    userId: input.userId,
    businessId: input.businessId,
    accessLevel: input.accessLevel,
    canManageLeads: input.canManageLeads,
    canUseLeadSources: input.canUseLeadSources,
    canUseProfileQueue: input.canUseProfileQueue,
    canDeleteLeads: input.canDeleteLeads,
  });
  if (!granted.ok) return granted;

  return upsertUserLeadScope(viewer, {
    userId: input.userId,
    businessId: input.businessId,
    mode: input.leadScopeMode,
    icpIds: input.icpIds,
  });
}

export async function removeUserGrant(
  viewer: Viewer,
  userId: string,
  businessId: string,
): Promise<MutationResult> {
  const revoked = await revokeUserGrant(viewer, userId, businessId);
  if (!revoked.ok) return revoked;
  // The scope row is meaningless without the grant, and leaving it behind would
  // silently re-apply an old restriction if the grant were ever recreated.
  await clearUserLeadScope(viewer, userId, businessId);
  return { ok: true };
}
