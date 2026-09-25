/**
 * Outreach identities — screen A17 (`/identities`, `/identities/[id]`).
 *
 * spec `identity_model.outreach_identity`: "Represents a specific sender
 * identity/account… CRM lead owner, actual sender identity, and business are
 * separate dimensions and may differ."
 *
 * Two rules shape everything here:
 *
 *   * Business access is an explicit per-identity grant
 *     (`outreach_identity_business_access`, DB_CONTRACT invariant 14). The
 *     Companion's visible businesses are the *intersection* of the operator's
 *     grants and the selected identity's grants — never the union.
 *   * An identity already assigned to someone else may only change hands through
 *     an explicit confirmation, recorded as a confirmed `identity_transfers` row
 *     plus an `audit_events` row
 *     (spec `admin_self_assignment_and_domains.admin_self_assignment`).
 *
 * Visibility is RLS (`public.identity_visible`): an admin sees every identity, a
 * non-admin only the ones assigned to them. Nothing here re-implements that.
 */
import 'server-only';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Row } from '../sql';
import {
  asIso,
  asNumber,
  asString,
  asStringOrNull,
  describeDbError,
  read,
  readOne,
  type MutationResult,
} from './common';

export type { MutationResult };

/** `outreach_identities.platform` (0006_outreach_identities.sql). */
export const IDENTITY_PLATFORMS = ['linkedin', 'email', 'twitter', 'other'] as const;
export type IdentityPlatform = (typeof IDENTITY_PLATFORMS)[number];

/** `outreach_identities.status`. */
export const IDENTITY_STATUSES = ['active', 'paused', 'retired'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/**
 * spec `roles_and_permissions.same_user_multiple_browsers`: a warning is about
 * *concurrent* use, so a session that stopped heartbeating inside this window no
 * longer counts. The read queries and the shared evaluator must agree on the
 * window, so both read it from one place.
 */
export const STALE_SESSION_MINUTES = 15;

/* ------------------------------------------------------------------ reads -- */

export interface IdentityListRow {
  readonly id: string;
  readonly displayName: string;
  readonly platform: IdentityPlatform;
  readonly status: IdentityStatus;
  readonly profileUrl: string | null;
  readonly managedByUserId: string | null;
  readonly managerName: string | null;
  readonly dailyTarget: number;
  readonly dailySentCount: number;
  /** Rows in `outreach_identity_business_access`. */
  readonly businessCount: number;
  readonly businessNames: readonly string[];
  readonly activeSessionCount: number;
  /** True when more than one live session uses this identity (spec warning). */
  readonly concurrentSessions: boolean;
  readonly createdAt: string | null;
}

export interface IdentityDetail extends IdentityListRow {
  readonly notes: string | null;
  readonly optionalBrowserProfileId: string | null;
  readonly normalizedProfileUrl: string | null;
  readonly dailyCountResetAt: string | null;
  readonly createdBy: string | null;
  readonly updatedAt: string | null;
}

export interface IdentityBusinessAccess {
  readonly businessId: string;
  readonly businessName: string;
  readonly businessKey: string;
  readonly createdAt: string | null;
}

export interface BrowserSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly userLabel: string;
  readonly installId: string;
  readonly status: 'active' | 'idle' | 'revoked';
  readonly lastActiveAt: string | null;
  readonly createdAt: string | null;
  readonly revokedAt: string | null;
  readonly defaultBusinessId: string | null;
  readonly defaultBusinessName: string | null;
  readonly userAgent: string | null;
}

export interface IdentityTransferRow {
  readonly id: string;
  readonly fromUserId: string | null;
  readonly fromUserName: string | null;
  readonly toUserId: string | null;
  readonly toUserName: string | null;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly confirmed: boolean;
  readonly note: string | null;
  readonly createdAt: string | null;
}

const IDENTITY_COLUMNS = `
  i.id, i.display_name, i.platform, i.status, i.profile_url, i.managed_by_user_id,
  i.daily_target, i.daily_sent_count, i.notes, i.optional_browser_profile_id,
  i.normalized_profile_url, i.daily_count_reset_at, i.created_by, i.created_at,
  i.updated_at,
  m.full_name as manager_name,
  m.email as manager_email,
  (select count(*) from public.outreach_identity_business_access a
    where a.outreach_identity_id = i.id) as business_count,
  (select coalesce(array_agg(b.name order by b.name), array[]::text[])
     from public.outreach_identity_business_access a
     join public.businesses b on b.id = a.business_id
    where a.outreach_identity_id = i.id) as business_names,
  (select count(*) from public.browser_sessions s
    where s.outreach_identity_id = i.id and s.status = 'active') as active_session_count,
  -- "concurrent" means: more than one live session, the newest of which
  -- heartbeated inside the staleness window. A single stale session left behind by
  -- a closed browser profile must not read as a conflict.
  (
    (select count(*) from public.browser_sessions s
      where s.outreach_identity_id = i.id and s.status = 'active') > 1
    and (
      select max(s.last_active_at) from public.browser_sessions s
       where s.outreach_identity_id = i.id and s.status = 'active'
    ) > now() - make_interval(mins => ${String(STALE_SESSION_MINUTES)})
  ) as concurrent_sessions
`;

const IDENTITY_FROM = `
  from public.outreach_identities i
  left join public.users m on m.id = i.managed_by_user_id
`;

function mapIdentity(row: Row): IdentityListRow {
  return {
    id: asString(row.id),
    displayName: asString(row.display_name),
    platform: asString(row.platform, 'linkedin') as IdentityPlatform,
    status: asString(row.status, 'active') as IdentityStatus,
    profileUrl: asStringOrNull(row.profile_url),
    managedByUserId: asStringOrNull(row.managed_by_user_id),
    managerName: asStringOrNull(row.manager_name) ?? asStringOrNull(row.manager_email),
    dailyTarget: asNumber(row.daily_target),
    dailySentCount: asNumber(row.daily_sent_count),
    businessCount: asNumber(row.business_count),
    businessNames: Array.isArray(row.business_names)
      ? row.business_names.filter((name): name is string => typeof name === 'string')
      : [],
    activeSessionCount: asNumber(row.active_session_count),
    concurrentSessions: row.concurrent_sessions === true,
    createdAt: asIso(row.created_at),
  };
}

/**
 * Every identity the viewer may see.
 *
 * The query carries no owner filter of its own: RLS already narrows it to all
 * (admin) or to the viewer's own assignments (spec `roles_and_permissions.user.can`).
 */
export async function listIdentities(actor: Actor): Promise<readonly IdentityListRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select ${IDENTITY_COLUMNS} ${IDENTITY_FROM}
        where i.deleted_at is null
        order by i.status, i.display_name`,
    );
    return result.rows.map((row: Row) => mapIdentity(row));
  });
}

export async function getIdentity(actor: Actor, identityId: string): Promise<IdentityDetail | null> {
  return readOne(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select ${IDENTITY_COLUMNS} ${IDENTITY_FROM} where i.id = $1 and i.deleted_at is null`,
      [identityId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...mapIdentity(row),
      notes: asStringOrNull(row.notes),
      optionalBrowserProfileId: asStringOrNull(row.optional_browser_profile_id),
      normalizedProfileUrl: asStringOrNull(row.normalized_profile_url),
      dailyCountResetAt: asIso(row.daily_count_reset_at),
      createdBy: asStringOrNull(row.created_by),
      updatedAt: asIso(row.updated_at),
    };
  });
}

/** Which businesses this sender may work (the identity side of the intersection). */
export async function listIdentityBusinessAccess(
  actor: Actor,
  identityId: string,
): Promise<readonly IdentityBusinessAccess[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select a.business_id, b.name as business_name, b.key as business_key, a.created_at
         from public.outreach_identity_business_access a
         join public.businesses b on b.id = a.business_id
        where a.outreach_identity_id = $1
        order by b.name`,
      [identityId],
    );
    return result.rows.map((row: Row) => ({
      businessId: asString(row.business_id),
      businessName: asString(row.business_name),
      businessKey: asString(row.business_key),
      createdAt: asIso(row.created_at),
    }));
  });
}

export async function listBrowserSessions(
  actor: Actor,
  identityId: string,
): Promise<readonly BrowserSessionRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select s.id, s.user_id, s.browser_fingerprint_or_install_id, s.status,
              s.last_active_at, s.created_at, s.revoked_at, s.default_business_id,
              s.user_agent,
              coalesce(u.full_name, u.email) as user_label,
              b.name as default_business_name
         from public.browser_sessions s
         left join public.users u on u.id = s.user_id
         left join public.businesses b on b.id = s.default_business_id
        where s.outreach_identity_id = $1
        order by s.last_active_at desc`,
      [identityId],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      userId: asString(row.user_id),
      userLabel: asStringOrNull(row.user_label) ?? 'Unknown user',
      installId: asString(row.browser_fingerprint_or_install_id),
      status: asString(row.status, 'idle') as BrowserSessionRow['status'],
      lastActiveAt: asIso(row.last_active_at),
      createdAt: asIso(row.created_at),
      revokedAt: asIso(row.revoked_at),
      defaultBusinessId: asStringOrNull(row.default_business_id),
      defaultBusinessName: asStringOrNull(row.default_business_name),
      userAgent: asStringOrNull(row.user_agent),
    }));
  });
}

/**
 * spec `identity_model.conversation_ownership`: "First sender identity becomes the
 * default conversation sender/owner for the channel. Transfers are explicit and
 * logged." — this is that log.
 */
export async function listIdentityTransfers(
  actor: Actor,
  identityId: string,
): Promise<readonly IdentityTransferRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select t.id, t.from_user_id, t.to_user_id, t.actor_user_id, t.confirmed,
              t.note, t.created_at,
              coalesce(f.full_name, f.email) as from_user_name,
              coalesce(o.full_name, o.email) as to_user_name,
              coalesce(a.full_name, a.email) as actor_name
         from public.identity_transfers t
         left join public.users f on f.id = t.from_user_id
         left join public.users o on o.id = t.to_user_id
         left join public.users a on a.id = t.actor_user_id
        where t.outreach_identity_id = $1
        order by t.created_at desc`,
      [identityId],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      fromUserId: asStringOrNull(row.from_user_id),
      fromUserName: asStringOrNull(row.from_user_name),
      toUserId: asStringOrNull(row.to_user_id),
      toUserName: asStringOrNull(row.to_user_name),
      actorUserId: asStringOrNull(row.actor_user_id),
      actorName: asStringOrNull(row.actor_name),
      confirmed: row.confirmed === true,
      note: asStringOrNull(row.note),
      createdAt: asIso(row.created_at),
    }));
  });
}

export interface AssignableUser {
  readonly id: string;
  readonly label: string;
}

/** Users an identity can be handed to. */
export async function listAssignableUsers(actor: Actor): Promise<readonly AssignableUser[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, full_name, email
         from public.users
        where deleted_at is null and status <> 'disabled'
        order by full_name nulls last, email`,
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      label: asStringOrNull(row.full_name) ?? asString(row.email),
    }));
  });
}

/* ----------------------------------------------------------------- writes -- */

export interface UpdateIdentityInput {
  readonly displayName?: string;
  readonly platform?: IdentityPlatform;
  readonly status?: IdentityStatus;
  readonly dailyTarget?: number;
  readonly profileUrl?: string | null;
  readonly notes?: string | null;
}

/**
 * Edits the identity's own fields.
 *
 * `case when $n::boolean then … else <column> end` distinguishes "not supplied"
 * (leave alone) from "explicitly cleared" for the two nullable text fields. An
 * owner who is not an admin may only change `display_name`, `daily_target` and
 * `notes` — the database enforces that in `restrict_identity_self_update`, so the
 * screen can offer the form and still be safe.
 */
export async function updateIdentity(
  viewer: Viewer,
  identityId: string,
  input: UpdateIdentityInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `update public.outreach_identities
            set display_name = case when $2::boolean then $3 else display_name end,
                platform     = case when $4::boolean then $5 else platform end,
                status       = case when $6::boolean then $7 else status end,
                daily_target = case when $8::boolean then $9 else daily_target end,
                profile_url  = case when $10::boolean then $11 else profile_url end,
                notes        = case when $12::boolean then $13 else notes end,
                updated_at   = now()
          where id = $1 and deleted_at is null
          returning id`,
        [
          identityId,
          input.displayName !== undefined,
          input.displayName ?? null,
          input.platform !== undefined,
          input.platform ?? null,
          input.status !== undefined,
          input.status ?? null,
          input.dailyTarget !== undefined,
          input.dailyTarget ?? null,
          input.profileUrl !== undefined,
          input.profileUrl ?? null,
          input.notes !== undefined,
          input.notes ?? null,
        ],
      );
      return result.rows[0] === undefined
        ? { ok: false, error: 'That identity no longer exists.' }
        : { ok: true, id: identityId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export interface CreateIdentityInput {
  readonly displayName: string;
  readonly platform: IdentityPlatform;
  readonly status: IdentityStatus;
  readonly dailyTarget: number;
  readonly profileUrl: string | null;
  readonly notes: string | null;
  readonly managedByUserId: string | null;
}

/**
 * Creates a sender identity. RLS permits the insert to an admin only
 * (`outreach_identities_insert`), which is why A15's "Add identity" control is
 * rendered for admins alone.
 */
export async function createIdentity(
  viewer: Viewer,
  input: CreateIdentityInput,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.outreach_identities
           (display_name, platform, status, daily_target, profile_url, notes,
            managed_by_user_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          input.displayName,
          input.platform,
          input.status,
          input.dailyTarget,
          input.profileUrl,
          input.notes,
          input.managedByUserId,
          viewer.userId,
        ],
      );
      const id = result.rows[0]?.id;
      return id === undefined ? { ok: false, error: 'The identity was not created.' } : { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function grantIdentityBusiness(
  viewer: Viewer,
  identityId: string,
  businessId: string,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ business_id: string }>(
        `insert into public.outreach_identity_business_access
           (outreach_identity_id, business_id, created_by)
         values ($1, $2, $3)
         on conflict (outreach_identity_id, business_id) do nothing
         returning business_id`,
        [identityId, businessId, viewer.userId],
      );
      // `do nothing` returns no row when the grant already existed, which is a
      // success for the operator's intent: the access is in place either way.
      return { ok: true, id: result.rows[0]?.business_id ?? businessId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

export async function revokeIdentityBusiness(
  viewer: Viewer,
  identityId: string,
  businessId: string,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `delete from public.outreach_identity_business_access
          where outreach_identity_id = $1 and business_id = $2`,
        [identityId, businessId],
      );
      return result.affectedRows === 0
        ? { ok: false, error: 'That business was not granted to this identity.' }
        : { ok: true };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Hands an identity to another user.
 *
 * spec `admin_self_assignment_and_domains.admin_self_assignment`: taking over an
 * identity that belongs to someone else requires "explicit transfer confirmation
 * and audit event". Both are written here, in one transaction, so a transfer can
 * never be recorded without its audit row or vice versa:
 *
 *   1. `identity_transfers` with `confirmed = true` (the table's CHECK constraint
 *      also refuses an unconfirmed row that names a previous owner);
 *   2. the `managed_by_user_id` change, which stamps before/after JSON into
 *      `audit_events` through `trg_outreach_identities_audit`;
 *   3. an explicit `audit_events` row naming the action as a transfer, so the
 *      reason is readable without diffing JSON.
 */
export async function assignIdentityManager(
  viewer: Viewer,
  identityId: string,
  toUserId: string | null,
  options: { readonly confirmed: boolean; readonly note: string | null },
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const current = await sql.query<{ id: string; managed_by_user_id: string | null }>(
        `select id, managed_by_user_id
           from public.outreach_identities
          where id = $1 and deleted_at is null`,
        [identityId],
      );
      const row = current.rows[0];
      if (row === undefined) return { ok: false, error: 'That identity no longer exists.' };

      const previousUserId = row.managed_by_user_id;
      if (previousUserId === toUserId) {
        return { ok: false, error: 'That identity is already assigned to this user.' };
      }

      // "Occupied by someone else" is the condition that needs confirmation. An
      // identity with no manager, or one being given up, does not.
      const needsConfirmation = previousUserId !== null;
      if (needsConfirmation && !options.confirmed) {
        return {
          ok: false,
          error:
            'This identity is assigned to another user. Tick the confirmation box to transfer it — the transfer is recorded and audited.',
        };
      }

      if (previousUserId !== null) {
        await sql.query(
          `insert into public.identity_transfers
             (outreach_identity_id, from_user_id, to_user_id, actor_user_id, confirmed, note)
           values ($1, $2, $3, $4, true, $5)`,
          [identityId, previousUserId, toUserId, viewer.userId, options.note],
        );
      }

      const updated = await sql.query<{ id: string }>(
        `update public.outreach_identities
            set managed_by_user_id = $2, updated_at = now()
          where id = $1 and deleted_at is null
          returning id`,
        [identityId, toUserId],
      );
      if (updated.rows[0] === undefined) {
        return { ok: false, error: 'That identity no longer exists.' };
      }

      await sql.query(
        `insert into public.audit_events
           (actor_type, actor_id, entity_type, entity_id, action, before_json, after_json, source_client)
         values ('user', $1, 'outreach_identities', $2, 'identity_transfer', $3::jsonb, $4::jsonb, 'web')`,
        [
          viewer.userId,
          identityId,
          JSON.stringify({ managed_by_user_id: previousUserId, confirmed: needsConfirmation }),
          JSON.stringify({ managed_by_user_id: toUserId, confirmed: needsConfirmation }),
        ],
      );

      return { ok: true, id: identityId };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* ------------------------------------------------------- lifecycle writes -- */

/**
 * What deleting this identity would orphan.
 *
 * `sentMessages` is the count that matters, and it is a count of `message_events` with
 * `event_type = 'sent'`: `message_instances` carries no identity column, so the sent event is the only
 * place the CRM records who actually reached a person. `message_events.outreach_identity_id` is
 * `on delete set null`, so deleting the identity would not fail — it would blank that column and
 * silently erase the attribution on every message the identity ever sent. The message text would
 * survive with no sender, which is exactly the state the duplicate-outreach warning and the audit
 * trail cannot work from.
 */
export interface IdentityAttribution {
  readonly sentMessages: number;
  readonly messageEvents: number;
  readonly conversations: number;
  readonly leads: number;
  readonly interactions: number;
  readonly browserSessions: number;
  readonly transfers: number;
}

const EMPTY_ATTRIBUTION: IdentityAttribution = {
  sentMessages: 0,
  messageEvents: 0,
  conversations: 0,
  leads: 0,
  interactions: 0,
  browserSessions: 0,
  transfers: 0,
};

function mapAttribution(value: unknown): IdentityAttribution {
  if (typeof value !== 'object' || value === null) return EMPTY_ATTRIBUTION;
  const row = value as Record<string, unknown>;
  const count = (key: string): number => asNumber(row[key]);
  return {
    sentMessages: count('sent_messages'),
    messageEvents: count('message_events'),
    conversations: count('conversations'),
    leads: count('leads'),
    interactions: count('interactions'),
    browserSessions: count('browser_sessions'),
    transfers: count('transfers'),
  };
}

/** Total attribution rows, and a breakdown for the refusal message. */
export function summariseAttribution(attribution: IdentityAttribution): {
  readonly total: number;
  readonly parts: readonly string[];
} {
  const labels: readonly (readonly [keyof IdentityAttribution, string])[] = [
    ['sentMessages', 'sent messages'],
    ['messageEvents', 'message events'],
    ['conversations', 'conversations'],
    ['leads', 'leads'],
    ['interactions', 'interactions'],
    ['browserSessions', 'browser sessions'],
    ['transfers', 'transfers'],
  ];
  const parts: string[] = [];
  let total = 0;
  for (const [key, label] of labels) {
    const value = attribution[key];
    if (value > 0) {
      parts.push(`${String(value)} ${label}`);
      total += value;
    }
  }
  return { total, parts };
}

export async function getIdentityAttribution(
  actor: Actor,
  identityId: string,
): Promise<IdentityAttribution> {
  return read(actor, async (sql) => {
    const result = await sql.query<{ attribution: unknown }>(
      `select public.identity_attribution($1) as attribution`,
      [identityId],
    );
    return mapAttribution(result.rows[0]?.attribution);
  });
}

/**
 * A mutation that decided the request was wrong, rather than one the database refused.
 *
 * `errorCode` is a stable identifier for the frontend to branch on. It exists because the alternative
 * — matching on the message text — breaks the moment a sentence is reworded, and the UI needs to
 * *offer the alternative action* rather than merely display an error: "this identity has history,
 * archive it instead" is a different screen state from "that did not work".
 */
export interface LifecycleResult extends MutationResult {
  readonly errorCode?: IdentityLifecycleErrorCode;
  /** Present when `errorCode` is `identity_has_attribution`: what archive would preserve. */
  readonly attribution?: IdentityAttribution;
}

export type IdentityLifecycleErrorCode =
  | 'identity_has_attribution'
  | 'identity_not_found'
  | 'identity_already_archived'
  | 'identity_not_archived'
  | 'identity_not_assigned'
  | 'confirmation_required';

/**
 * Releases an identity from its operator.
 *
 * This is the inverse of `assignIdentityManager`, and it deliberately does not go through it: an
 * unassign is not a transfer. `identity_transfers` requires a `to_user_id` or a `from_user_id` and its
 * CHECK constraint is about who is taking over, so recording "nobody has this now" as a transfer would
 * put a row in the transfer log that names no recipient, and the log is meant to answer "who has it".
 * The ownership change is audited in `audit_events` through the existing identity audit trigger, plus
 * an explicit row naming the action.
 *
 * An identity with no manager is unusable rather than broken: it drops out of its owner's sender
 * selector, records nothing new, and keeps every historical attribution.
 */
export async function unassignIdentity(
  viewer: Viewer,
  identityId: string,
  note?: string | null,
): Promise<LifecycleResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const current = await sql.query<{
        id: string;
        managed_by_user_id: string | null;
        status: string;
        display_name: string;
      }>(
        `select id, managed_by_user_id, status, display_name
           from public.outreach_identities
          where id = $1 and deleted_at is null
          for update`,
        [identityId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        return { ok: false, errorCode: 'identity_not_found', error: 'That identity could not be found.' };
      }
      if (row.managed_by_user_id === null) {
        return {
          ok: false,
          errorCode: 'identity_not_assigned',
          error: `${row.display_name} is not assigned to anyone.`,
        };
      }

      await sql.query(
        `update public.outreach_identities
            set managed_by_user_id = null, updated_at = now()
          where id = $1 and deleted_at is null`,
        [identityId],
      );

      await sql.query(
        `insert into public.audit_events
           (actor_type, actor_id, entity_type, entity_id, action, before_json, after_json, source_client)
         values ('user', $1, 'outreach_identities', $2, 'identity_unassign', $3::jsonb, $4::jsonb, 'web')`,
        [
          viewer.userId,
          identityId,
          JSON.stringify({ managed_by_user_id: row.managed_by_user_id }),
          JSON.stringify({ managed_by_user_id: null, note: note ?? null }),
        ],
      );

      return {
        ok: true,
        id: identityId,
        message: `${row.display_name} is unassigned. It will not appear in any operator's sender list until it is assigned again.`,
      };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Archives an identity: `status = 'retired'`, plus the side effects that make it actually stop.
 *
 * Setting the status alone would be a lie in three places:
 *
 *   1. **Live browser sessions.** A bound browser profile would keep sending. Every active session is
 *      revoked in the same transaction, so the extension's next request fails rather than silently
 *      continuing as a retired identity. `browser_sessions_active_identity_key` (0010) makes a
 *      concurrent bind fail loudly instead of racing the revocation.
 *   2. **Business bindings.** They are left in place. They are configuration, not activity, and
 *      removing them would lose the record of which businesses this identity served — which is part
 *      of its history. Use `revokeIdentityBusiness` if the binding itself should go.
 *   3. **New work.** `identity_usable_by_actor` now requires `status = 'active'` before any branch,
 *      so the identity is refused by `assert_identity_usable` in every send and bind path — including
 *      for an admin, which it previously was not.
 *
 * Archiving is terminal (migration 0025): an archived identity cannot be reactivated, because
 * "who may send as this account" is a decision with a history and reversing it silently would make
 * that history ambiguous. Create a new identity instead.
 */
export async function archiveIdentity(
  viewer: Viewer,
  identityId: string,
  note?: string | null,
): Promise<LifecycleResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const current = await sql.query<{ id: string; status: string; display_name: string }>(
        `select id, status, display_name
           from public.outreach_identities
          where id = $1 and deleted_at is null
          for update`,
        [identityId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        return { ok: false, errorCode: 'identity_not_found', error: 'That identity could not be found.' };
      }
      if (row.status === 'retired') {
        return {
          ok: false,
          errorCode: 'identity_already_archived',
          error: `${row.display_name} is already archived.`,
        };
      }

      const sessions = await sql.query<{ n: number }>(
        `with revoked as (
           update public.browser_sessions
              set status = 'revoked', revoked_at = now()
            where outreach_identity_id = $1 and status = 'active'
            returning id
         )
         select count(*)::int as n from revoked`,
        [identityId],
      );
      const revokedSessions = asNumber(sessions.rows[0]?.n);

      await sql.query(
        `update public.outreach_identities
            set status = 'retired', updated_at = now()
          where id = $1 and deleted_at is null`,
        [identityId],
      );

      const attribution = await sql.query<{ attribution: unknown }>(
        `select public.identity_attribution($1) as attribution`,
        [identityId],
      );

      await sql.query(
        `insert into public.audit_events
           (actor_type, actor_id, entity_type, entity_id, action, before_json, after_json, source_client)
         values ('user', $1, 'outreach_identities', $2, 'identity_archive', $3::jsonb, $4::jsonb, 'web')`,
        [
          viewer.userId,
          identityId,
          JSON.stringify({ status: row.status }),
          JSON.stringify({ status: 'retired', revoked_sessions: revokedSessions, note: note ?? null }),
        ],
      );

      return {
        ok: true,
        id: identityId,
        attribution: mapAttribution(attribution.rows[0]?.attribution),
        message:
          `${row.display_name} is archived. It is out of every sender and binding selector, and its history is preserved` +
          (revokedSessions > 0 ? `; ${String(revokedSessions)} live browser session(s) were revoked.` : '.'),
      };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Deletes an identity — but only one that never sent anything.
 *
 * The reason this returns a typed rejection rather than attempting the delete is that the delete would
 * *succeed*. Every referencing foreign key is `on delete set null`, so removing an identity that sent
 * a hundred messages quietly blanks the sender on all of them, and nothing reports it. There is no
 * error to catch and no constraint to trust, which is why the census is read first and the trigger in
 * migration 0025 repeats it.
 *
 * `confirmation` must be the identity's display name, typed by the operator: this is irreversible and
 * the database cannot ask.
 */
export async function deleteIdentitySafely(
  viewer: Viewer,
  identityId: string,
  confirmation: string,
): Promise<LifecycleResult> {
  try {
    const identity = await getIdentity(viewer.actor, identityId);
    if (identity === null) {
      return { ok: false, errorCode: 'identity_not_found', error: 'That identity could not be found.' };
    }

    if (confirmation.trim() !== identity.displayName) {
      return {
        ok: false,
        errorCode: 'confirmation_required',
        error: `Type "${identity.displayName}" exactly to confirm deleting this identity.`,
      };
    }

    const attribution = await getIdentityAttribution(viewer.actor, identityId);
    const { total, parts } = summariseAttribution(attribution);
    if (total > 0) {
      return {
        ok: false,
        errorCode: 'identity_has_attribution',
        attribution,
        error:
          `${identity.displayName} sent ${String(attribution.sentMessages)} message(s) and is referenced by history ` +
          `(${parts.join(', ')}). Deleting it would erase who sent them. Archive it instead — archiving removes it ` +
          'from every sender and binding selector and preserves all attribution.',
      };
    }

    await withActor(viewer.actor, async (sql) => {
      const deleted = await sql.query(
        `delete from public.outreach_identities where id = $1 and deleted_at is null`,
        [identityId],
      );
      if (deleted.affectedRows === 0) throw new Error('That identity no longer exists.');

      await sql.query(
        `insert into public.audit_events
           (actor_type, actor_id, entity_type, entity_id, action, before_json, source_client)
         values ('user', $1, 'outreach_identities', $2, 'identity_delete', $3::jsonb, 'web')`,
        [
          viewer.userId,
          identityId,
          JSON.stringify({
            display_name: identity.displayName,
            platform: identity.platform,
            status: identity.status,
          }),
        ],
      );
    });

    return { ok: true, id: identityId, message: `${identity.displayName} was deleted.` };
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}
