/**
 * Platform-admin operations that are not owned by another repository:
 *
 *   - screen A29 `admin_self_assignment_and_domains.admin_self_assignment`:
 *     "Admin may grant themselves business access … Admin may self-assign an
 *      unassigned outreach identity. If identity is assigned to someone else,
 *      require explicit transfer confirmation and audit event."
 *   - screen A22: clearing a business-level `platform_settings` override so the
 *     global default applies again.
 *
 * Every write runs inside `withActor`, and RLS is the enforcement point:
 * `user_business_access`, `outreach_identities` and `identity_transfers` all require
 * `public.is_admin()` for the write shown here, so a non-admin gets a privilege
 * error rather than a partial change.
 *
 * A transfer is one transaction: the `identity_transfers` row, the ownership update
 * and the `audit_events` row either all land or none do. An ownership change that
 * left no audit trail would be exactly the silent change the spec forbids.
 */
import 'server-only';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Db, Row } from '../sql';
import {
  asBoolean,
  asIso,
  asNumber,
  asString,
  asStringArray,
  asStringOrNull,
  describeDbError,
  read,
  type MutationResult,
} from './common';

/* ------------------------------------------------------------- identities -- */

export interface IdentityRow {
  readonly id: string;
  readonly platform: string;
  readonly displayName: string;
  readonly profileUrl: string | null;
  readonly status: 'active' | 'paused' | 'retired';
  readonly dailyTarget: number;
  readonly managedByUserId: string | null;
  readonly managerLabel: string | null;
  readonly businessIds: readonly string[];
  readonly businessNames: readonly string[];
}

/**
 * Identities the viewer can see.
 *
 * `identity_visible` gives an admin every identity and a normal user only the ones
 * they manage, so this list is already scoped correctly without a hand-written
 * `where` clause — and the screen filters it into mine / unassigned / someone else's.
 */
export async function listIdentities(actor: Actor): Promise<readonly IdentityRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select i.id, i.platform, i.display_name, i.profile_url, i.status, i.daily_target,
              i.managed_by_user_id,
              coalesce(nullif(u.full_name, ''), u.email) as manager_label,
              coalesce(
                array_agg(distinct a.business_id::text)
                  filter (where a.business_id is not null), array[]::text[]
              ) as business_ids,
              coalesce(
                array_agg(distinct b.name) filter (where b.name is not null), array[]::text[]
              ) as business_names
         from public.outreach_identities i
         left join public.users u on u.id = i.managed_by_user_id
         left join public.outreach_identity_business_access a on a.outreach_identity_id = i.id
         left join public.businesses b on b.id = a.business_id and b.deleted_at is null
        where i.deleted_at is null
        group by i.id, u.full_name, u.email
        order by i.display_name`,
    );

    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      platform: asString(row.platform, 'linkedin'),
      displayName: asString(row.display_name),
      profileUrl: asStringOrNull(row.profile_url),
      status: asString(row.status, 'active') as IdentityRow['status'],
      dailyTarget: asNumber(row.daily_target),
      managedByUserId: asStringOrNull(row.managed_by_user_id),
      managerLabel: asStringOrNull(row.manager_label),
      businessIds: asStringArray(row.business_ids),
      businessNames: asStringArray(row.business_names),
    }));
  });
}

export interface IdentityTransferRow {
  readonly id: string;
  readonly identityId: string;
  readonly identityName: string;
  readonly fromUserId: string | null;
  readonly toUserId: string | null;
  readonly confirmed: boolean;
  readonly note: string | null;
  readonly createdAt: string | null;
}

/** Transfers this viewer is party to — RLS also lets an admin see every transfer. */
export async function listIdentityTransfers(
  actor: Actor,
  userId: string,
): Promise<readonly IdentityTransferRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select t.id, t.outreach_identity_id, i.display_name as identity_name,
              t.from_user_id, t.to_user_id, t.confirmed, t.note, t.created_at
         from public.identity_transfers t
         left join public.outreach_identities i on i.id = t.outreach_identity_id
        where t.from_user_id = $1 or t.to_user_id = $1 or t.actor_user_id = $1
        order by t.created_at desc
        limit 50`,
      [userId],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      identityId: asString(row.outreach_identity_id),
      identityName: asString(row.identity_name, 'identity'),
      fromUserId: asStringOrNull(row.from_user_id),
      toUserId: asStringOrNull(row.to_user_id),
      confirmed: asBoolean(row.confirmed),
      note: asStringOrNull(row.note),
      createdAt: asIso(row.created_at),
    }));
  });
}

/* --------------------------------------------------------- self-assignment -- */

export interface SelfAssignOptions {
  /** Explicit transfer confirmation. Required when the identity belongs to someone else. */
  readonly confirmed: boolean;
  readonly note?: string | null;
}

/**
 * Self-assign an outreach identity.
 *
 * Unassigned (or already mine)  -> plain assignment, audited.
 * Assigned to another user      -> `identity_transfers` row with `confirmed = true`
 *                                  plus an audit event, and the matching DB check
 *                                  constraint refuses a transfer row that is not
 *                                  confirmed (`confirmed = true or from_user_id is null`).
 */
export async function selfAssignIdentity(
  viewer: Viewer,
  identityId: string,
  options: SelfAssignOptions,
): Promise<MutationResult> {
  if (viewer.userId === null) return { ok: false, error: 'Your session has expired. Sign in again.' };
  const targetUserId = viewer.userId;

  try {
    return await withActor(viewer.actor, async (sql) => {
      const current = await sql.query<Row>(
        `select id, managed_by_user_id, display_name
           from public.outreach_identities
          where id = $1 and deleted_at is null
          for update`,
        [identityId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        // RLS hides an identity you neither manage nor administer, so "not visible" and
        // "does not exist" are indistinguishable here — say both rather than guess.
        return {
          ok: false,
          error: 'That identity is not visible to you, or no longer exists. Only an admin can take over an identity they do not already manage.',
        };
      }

      const previousUserId = asStringOrNull(row.managed_by_user_id);
      const identityName = asString(row.display_name, 'This identity');

      if (previousUserId === targetUserId) {
        return { ok: true, id: identityId, message: `${identityName} is already assigned to you.` };
      }

      if (previousUserId !== null && !options.confirmed) {
        return {
          ok: false,
          error:
            `${identityName} is currently assigned to another user. Tick the transfer confirmation box to take it over — ` +
            'the change is recorded as a transfer and written to the audit log.',
        };
      }

      if (previousUserId !== null) {
        await sql.query(
          `insert into public.identity_transfers
             (outreach_identity_id, from_user_id, to_user_id, actor_user_id, confirmed, note)
           values ($1, $2, $3, $3, true, $4)`,
          [identityId, previousUserId, targetUserId, options.note ?? null],
        );
      }

      await sql.query(
        `update public.outreach_identities
            set managed_by_user_id = $2, updated_at = now()
          where id = $1`,
        [identityId, targetUserId],
      );

      await writeAudit(sql, viewer, null, 'outreach_identities', identityId, 'self_assign_identity', {
        from_user_id: previousUserId,
        to_user_id: targetUserId,
        confirmed: previousUserId !== null,
        note: options.note ?? null,
      });

      return {
        ok: true,
        id: identityId,
        message:
          previousUserId === null
            ? `${identityName} is now assigned to you.`
            : `${identityName} transferred to you and recorded in the transfer log.`,
      };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Bind a business to an identity the viewer manages.
 *
 * spec `extension_visibility_rule`: Companion visibility is the intersection of user
 * access and the selected identity's business access — an identity with no business
 * bound is unusable, so this is the second half of self-assignment.
 */
export async function bindIdentityBusiness(
  viewer: Viewer,
  identityId: string,
  businessId: string,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      await sql.query(
        `insert into public.outreach_identity_business_access (outreach_identity_id, business_id, created_by)
         values ($1, $2, $3)
         on conflict (outreach_identity_id, business_id) do nothing`,
        [identityId, businessId, viewer.userId],
      );

      await writeAudit(sql, viewer, businessId, 'outreach_identity_business_access', identityId, 'bind_identity_business', {
        business_id: businessId,
      });

      return { ok: true, id: identityId, message: 'Business bound to the identity.' };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* ------------------------------------------------------- platform settings -- */

/**
 * The typed A22 catalogue.
 *
 * spec `screen_inventory` A22 contract: "Security, retention, soft-delete, DNC
 * suppression, uniqueness defaults, reply pause, dormant defaults." These are the
 * exact keys seeded by migrations 0010 and 0015, with the kind the UI must use to
 * edit them. A22 has to be edited through typing, never through a raw JSON textarea,
 * so the authoritative kind lives here next to the writer and is handed to the client
 * component as data.
 */
export const PLATFORM_SETTING_DEFS = [
  {
    key: 'security.hard_delete_requires_confirmation',
    label: 'Permanent delete requires typed confirmation',
    group: 'Security',
    kind: 'boolean',
    help: 'Trash keeps a delete recoverable; this gate guards the irreversible one.',
  },
  {
    key: 'security.soft_delete_default',
    label: 'Soft delete by default',
    group: 'Security',
    kind: 'boolean',
    help: 'spec `security_and_reliability.rules`: deletes move records to Trash instead of destroying them.',
  },
  {
    key: 'retention.trash_days',
    label: 'Trash retention (days)',
    group: 'Retention & soft delete',
    kind: 'number',
    help: 'How long a soft-deleted record stays restorable before it can be purged.',
  },
  {
    key: 'dnc.suppress_person_across_identities',
    label: 'Do Not Contact applies across every sender identity',
    group: 'Do Not Contact',
    kind: 'boolean',
    help: 'spec `sequence_engine.do_not_contact`: a suppression must not be bypassed via another account.',
  },
  {
    key: 'uniqueness.normalized_linkedin_url',
    label: 'Match people on the normalized LinkedIn URL',
    group: 'Uniqueness defaults',
    kind: 'boolean',
    help: 'Trailing slashes, query strings and locale prefixes are ignored when deciding "same person".',
  },
  {
    key: 'uniqueness.normalized_company_domain',
    label: 'Match companies on the normalized domain',
    group: 'Uniqueness defaults',
    kind: 'boolean',
    help: 'spec `admin_self_assignment_and_domains.business_domains`: matching a domain never auto-merges leads across businesses.',
  },
  {
    key: 'reply.pause_sequence',
    label: 'Pause the sequence when a reply is captured',
    group: 'Reply pause',
    kind: 'boolean',
    help: 'spec `reply_and_notes`: an inbound reply stops further steps for that lead.',
  },
  {
    key: 'reply.cancel_pending_steps',
    label: 'Cancel pending steps when a reply is captured',
    group: 'Reply pause',
    kind: 'boolean',
    help: 'Pausing keeps the steps; cancelling removes them from the queue.',
  },
  {
    key: 'dormant.reactivation_days',
    label: 'Dormant after (days without activity)',
    group: 'Dormant & cooldown',
    kind: 'number',
    help: 'A completed sequence with no reply becomes dormant after this many days.',
  },
  {
    key: 'cooldown.ordinary_not_interested_days',
    label: 'Cooling period after "not interested" (days)',
    group: 'Dormant & cooldown',
    kind: 'number',
    help: 'Ordinary, non-hostile rejections get a cooling period rather than a permanent suppression.',
  },
  {
    key: 'browser.allow_concurrent_identity_sessions',
    label: 'Allow the same identity in several browser profiles',
    group: 'Concurrency & sequence defaults',
    kind: 'boolean',
    help: 'spec `roles_and_permissions.same_user_multiple_browsers`: off means concurrent use is blocked, on means it only warns.',
  },
  {
    key: 'sequence.default_followup_delays_days',
    label: 'Default follow-up delays (days)',
    group: 'Concurrency & sequence defaults',
    kind: 'number_list',
    help: 'Message 1 then follow-ups, e.g. 3, 4, 7 — three gaps for the three follow-ups.',
  },
] as const;

export type PlatformSettingKind = (typeof PLATFORM_SETTING_DEFS)[number]['kind'];
export type PlatformSettingDef = (typeof PLATFORM_SETTING_DEFS)[number];
export type PlatformSettingValue = boolean | number | readonly number[];

/** Fast, authoritative kind lookup. Unknown keys are never writable from A22. */
export function platformSettingDef(key: string): PlatformSettingDef | undefined {
  return PLATFORM_SETTING_DEFS.find((definition) => definition.key === key);
}

export interface PlatformSettingEntry {
  readonly key: string;
  readonly value: PlatformSettingValue;
}

/**
 * Write a batch of `platform_settings` rows and/or delete overrides in ONE
 * transaction, scoped to `businessId` (`null` = the global defaults).
 *
 * A whole settings form is one operator intent, so a half-applied save would be a
 * silent inconsistency; one transaction plus one audit event is the honest shape.
 *
 * UPDATE-then-INSERT rather than `on conflict (business_id, key)`: the table's unique
 * constraint is NULLS DISTINCT, so a global row (`business_id IS NULL`) can never be
 * matched by that conflict target — the upsert would insert a second global row and
 * then trip the partial unique index `platform_settings_global_key`. Matching with
 * `business_id is not distinct from $1` handles the global scope correctly.
 */
export async function savePlatformSettings(
  viewer: Viewer,
  scope: string | null,
  upserts: readonly PlatformSettingEntry[],
  clears: readonly string[] = [],
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      for (const entry of upserts) {
        const updated = await sql.query(
          `update public.platform_settings
              set value = $3::jsonb, updated_by = $4, updated_at = now()
            where business_id is not distinct from $1 and key = $2`,
          [scope, entry.key, JSON.stringify(entry.value), viewer.userId],
        );

        if (updated.affectedRows === 0) {
          await sql.query(
            `insert into public.platform_settings (business_id, key, value, updated_by, updated_at)
             values ($1, $2, $3::jsonb, $4, now())`,
            [scope, entry.key, JSON.stringify(entry.value), viewer.userId],
          );
        }
      }

      for (const key of clears) {
        await sql.query(`delete from public.platform_settings where key = $1 and business_id = $2`, [
          key,
          scope,
        ]);
      }

      await writeAudit(sql, viewer, scope, 'platform_settings', null, 'save_settings', {
        scope: scope === null ? 'global' : 'business',
        keys: upserts.map((entry) => entry.key),
        cleared: [...clears],
      });

      return {
        ok: true,
        message:
          scope === null
            ? 'Global defaults saved.'
            : 'Business overrides saved.',
      };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Remove a business-level `platform_settings` override so the global row applies
 * again. A22 settings are "defaults + overrides"; without this an override could
 * never be undone.
 */
export async function clearPlatformSetting(
  viewer: Viewer,
  key: string,
  businessId: string,
): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `delete from public.platform_settings where key = $1 and business_id = $2`,
        [key, businessId],
      );
      if (result.affectedRows === 0) {
        return { ok: false, error: 'That business does not override this setting.' };
      }

      await writeAudit(sql, viewer, businessId, 'platform_settings', null, 'clear_setting_override', { key });
      return { ok: true, message: 'Override removed; the global value applies again.' };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/* ------------------------------------------------------------------ audit -- */

/** Append-only audit row (`audit_events` has no UPDATE or DELETE policy). */
async function writeAudit(
  sql: Db,
  viewer: Viewer,
  businessId: string | null,
  entityType: string,
  entityId: string | null,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await sql.query(
    `insert into public.audit_events
       (actor_type, actor_id, business_id, entity_type, entity_id, action, after_json, source_client)
     values ('user', $1, $2, $3, $4, $5, $6::jsonb, 'web')`,
    [viewer.userId, businessId, entityType, entityId, action, JSON.stringify(after)],
  );
}
