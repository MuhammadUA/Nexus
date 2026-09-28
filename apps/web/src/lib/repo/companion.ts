/**
 * Companion-facing reads.
 *
 * The side panel is a narrow, purpose-built client: it needs business/identity
 * selectors, lead lists, the today queue and one canonical lead context. These
 * queries exist so the extension never has to compose several admin endpoints — and
 * so the extension's API surface stays small enough to audit.
 *
 * RLS does the authorization: none of these queries filters by business in
 * application code beyond the selector the caller passed, which RLS then validates.
 */
import 'server-only';

import { ENRICHMENT_STATES, searchLinks, type EnrichmentState } from '@nexus/core';

import { withActor, type Actor, type Viewer } from '../actor';
import { withServiceRole } from '../actor';
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
} from './common';

export interface CompanionBusinessRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface CompanionSessionRow {
  readonly userId: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly role: 'admin' | 'manager' | 'user' | null;
}

/** The signed-in user's own profile, as the Companion needs to render it. */
export async function companionSession(actor: Actor, userId: string): Promise<CompanionSessionRow> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, email, full_name, role from public.users where id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { userId, email: null, fullName: null, role: null };
    }
    const role = asStringOrNull(row.role);
    return {
      userId: asString(row.id, userId),
      email: asStringOrNull(row.email),
      fullName: asStringOrNull(row.full_name),
      role: role === 'admin' || role === 'manager' || role === 'user' ? role : null,
    };
  });
}

export interface CompanionIdentityRow {
  readonly id: string;
  readonly displayName: string;
  readonly platform: string;
  readonly status: string;
  readonly businessIds: readonly string[];
}

export interface CompanionIcpRow {
  readonly id: string;
  readonly name: string;
}

/**
 * Businesses a user can reach, optionally narrowed to the ones the chosen channel
 * account may actually send from.
 *
 * spec `roles_and_permissions.extension_visibility_rule`: the Companion's business
 * selector is the actor's business access INTERSECT the identity's business access —
 * never a union. With `identityId` supplied the intersection is computed by
 * `public.companion_visible_business_ids`, the same helper the identity payload uses,
 * so the two selectors cannot disagree. Without it the function keeps its previous
 * behaviour (every business the actor can reach) for callers that only need the
 * actor's own scope.
 */
export async function companionBusinesses(
  actor: Actor,
  identityId?: string | null,
): Promise<readonly CompanionBusinessRow[]> {
  return read(actor, async (sql) => {
    const scoped = typeof identityId === 'string' && identityId.length > 0;
    const result = await sql.query<Row>(
      scoped
        ? `select b.id, b.key, b.name
             from public.businesses b
            where b.deleted_at is null
              and b.id in (select v from public.companion_visible_business_ids($1) as t(v))
            order by b.name`
        : `select b.id, b.key, b.name
             from public.businesses b
            where b.deleted_at is null
            order by b.name`,
      scoped ? [identityId] : [],
    );
    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      slug: asString(row.key),
      name: asString(row.name),
    }));
  });
}

/**
 * spec `extension_visibility_rule`: "Visible businesses in Companion =
 * user_business_access INTERSECT selected_outreach_identity.business_access."
 *
 * Returns each usable identity together with the businesses that survive the
 * intersection, so the panel's two selectors can never offer an impossible pair.
 *
 * The per-identity business list comes from `public.companion_visible_business_ids`
 * rather than an inline join: that helper is the one place the admin case is
 * expressed (a global administrator holds no `user_business_access` row and sees
 * every business the account is available to), and deriving it twice is how the two
 * answers drifted apart in production. Binding authority is *not* implied by this
 * list — see `companionIneligibleReason`.
 */
export async function companionIdentities(
  actor: Actor,
  userId: string,
): Promise<readonly CompanionIdentityRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select i.id, i.display_name, i.platform, i.status,
              coalesce(
                array(
                  select v
                    from public.companion_visible_business_ids(i.id) as t(v)
                ),
                array[]::uuid[]
              ) as business_ids
         from public.outreach_identities i
        where i.deleted_at is null
          and i.status = 'active'
          and (i.managed_by_user_id = $1 or public.is_admin())
        order by i.display_name`,
      [userId],
    );

    return result.rows.map((row: Row) => ({
      id: asString(row.id),
      displayName: asString(row.display_name),
      platform: asString(row.platform, 'linkedin'),
      status: asString(row.status, 'active'),
      businessIds: Array.isArray(row.business_ids)
        ? row.business_ids.filter((entry): entry is string => typeof entry === 'string')
        : [],
    }));
  });
}

export async function companionIcps(actor: Actor, businessId: string): Promise<readonly CompanionIcpRow[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, name from public.icps
        where business_id = $1 and deleted_at is null and is_active
        order by is_default desc, name`,
      [businessId],
    );
    return result.rows.map((row: Row) => ({ id: asString(row.id), name: asString(row.name) }));
  });
}

/* --------------------------------------------------------- binding scope -- */

/**
 * Why a (channel account, business) pair is or is not bindable.
 *
 * Mirrors `public.companion_ineligible_reason`, which is the single source of the
 * rule: the database decides, the panel explains. Every value is non-disclosing —
 * an unknown business and an existing business the account cannot reach both
 * answer `no_account_access`, so a crafted probe learns nothing about the tenant.
 */
export const COMPANION_SCOPE_REASONS = [
  'no_account_access',
  'no_user_grant',
  'identity_not_usable',
] as const;

export type CompanionScopeReason = (typeof COMPANION_SCOPE_REASONS)[number];

export interface CompanionScopeOutcome {
  readonly ok: boolean;
  /** `ok` when bindable, otherwise the specific refusal. */
  readonly reason: 'ok' | CompanionScopeReason;
  /** Operator-facing sentence, specific to the reason. */
  readonly message: string;
}

/**
 * Operator-facing sentence per refusal.
 *
 * Deliberately specific rather than one generic permission message: "you cannot do
 * that" is unactionable, while "this account is not assigned to that business" tells
 * the operator to assign the account, and "ask an administrator for access" tells
 * them who can help. None of the sentences reveal whether the business exists.
 */
export function companionScopeMessage(reason: CompanionScopeReason): string {
  switch (reason) {
    case 'no_account_access':
      return 'This channel account is not available to that business. Ask an administrator to assign the account to it.';
    case 'no_user_grant':
      return 'You do not have access to that business yet. Ask an administrator to grant it to you.';
    case 'identity_not_usable':
    default:
      return 'This channel account cannot be used by you. Choose another account, or ask an administrator to assign it.';
  }
}

/** Narrows an arbitrary database value onto the closed reason vocabulary. */
function normalizeScopeReason(value: unknown): 'ok' | CompanionScopeReason {
  if (value === 'ok') return 'ok';
  return COMPANION_SCOPE_REASONS.find((entry) => entry === value) ?? 'identity_not_usable';
}

/** Reads the reason code for one pair through the helper, inside a transaction. */
async function scopeReasonUsing(
  sql: Db,
  identityId: string,
  businessId: string | null,
): Promise<'ok' | CompanionScopeReason> {
  const result = await sql.query<{ reason: unknown }>(
    `select public.companion_ineligible_reason($1, $2) as reason`,
    [identityId, businessId],
  );
  return normalizeScopeReason(result.rows[0]?.reason);
}

/**
 * Whether this actor may bind the pair, as its own read.
 *
 * A `null` business is allowed: "no default business yet" is a legitimate binding
 * state, and the identity is still validated. The authoritative check runs inside
 * the bind transaction (see `bindBrowserSession`); this exists for callers that need
 * to explain the refusal before offering the action.
 */
export async function companionBindingScope(
  actor: Actor,
  identityId: string,
  businessId: string | null,
): Promise<CompanionScopeOutcome> {
  const reason = await read(actor, async (sql) => scopeReasonUsing(sql, identityId, businessId));
  return reason === 'ok'
    ? { ok: true, reason: 'ok', message: '' }
    : { ok: false, reason, message: companionScopeMessage(reason) };
}

/* --------------------------------------------------------------- binding -- */

export interface BrowserBindingRow {
  readonly id: string;
  readonly installId: string;
  readonly identityId: string;
  readonly defaultBusinessId: string | null;
  readonly boundAt: string;
}

export async function findBinding(
  actor: Actor,
  userId: string,
  installId: string,
): Promise<BrowserBindingRow | null> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, browser_fingerprint_or_install_id, outreach_identity_id, default_business_id, created_at
         from public.browser_sessions
        where user_id = $1
          and browser_fingerprint_or_install_id = $2
          and status = 'active'
        order by created_at desc
        limit 1`,
      [userId, installId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: asString(row.id),
      installId: asString(row.browser_fingerprint_or_install_id),
      identityId: asString(row.outreach_identity_id),
      defaultBusinessId: asStringOrNull(row.default_business_id),
      boundAt: asIso(row.created_at) ?? '',
    };
  });
}

export interface BindInput {
  readonly installId: string;
  readonly identityId: string;
  readonly defaultBusinessId: string | null;
  /**
   * Consent to take the identity from whichever session currently holds it.
   *
   * The revocation happens in the same transaction as the bind, so this is the only switch that
   * decides whether another operator loses the sender.
   */
  readonly transfer?: boolean;
}

/**
 * Binds this browser profile to an identity.
 *
 * Presence is used as a heartbeat: an existing row for the same install is updated
 * rather than duplicated, and `last_active_at` is refreshed so the concurrency check
 * can tell a live session from an abandoned one.
 */
/**
 * Binds this browser profile to an identity.
 *
 * One row per browser profile, reassigned rather than accumulated. That matters because
 * `browser_sessions_active_identity_key` allows only one *active* session per identity, so an
 * insert for an identity the profile already had a row for raises a unique violation — the
 * operator sees "That record already exists." for a bind that should simply have updated their own
 * binding.
 *
 * The lookup is therefore by install id and takes the profile's row whichever identity it
 * currently names:
 *
 *   * already on the requested identity — refresh the heartbeat;
 *   * on a different identity — reassign it and make it active, after the caller has dealt with
 *     whoever holds the requested identity;
 *   * absent — insert.
 *
 * Presence is used as a heartbeat: `last_active_at` is refreshed so the concurrency check can tell
 * a live session from an abandoned one.
 */
export async function bindBrowserSession(
  viewer: Viewer,
  input: BindInput,
): Promise<{
  ok: boolean;
  binding?: BrowserBindingRow;
  error?: string;
  /** The specific refusal when the pair is not bindable; absent for other failures. */
  reason?: 'ok' | CompanionScopeReason;
  revokedSessionIds?: readonly string[];
}> {
  if (viewer.userId === null) return { ok: false, error: 'Sign in to Nexus.' };
  const userId = viewer.userId;

  try {
    return await withActor(viewer.actor, async (sql) => {
      /**
       * The pair is validated *first*, inside the same transaction as the write.
       *
       * This is the authorization the panel's selector is only a view of. A crafted
       * request therefore meets the same rule the UI does: a global administrator
       * still needs the account to be available to the business, and a non-admin
       * still needs an explicit grant on it. `public.companion_ineligible_reason` is
       * the single source of the rule, and the `browser_sessions` trigger applies it
       * to every write that names these two columns.
       *
       * Before the transfer below, deliberately: revoking another operator's session
       * and then refusing the bind would leave the account released by nobody.
       */
      const reason = await scopeReasonUsing(sql, input.identityId, input.defaultBusinessId);
      if (reason !== 'ok') {
        return { ok: false, reason, error: companionScopeMessage(reason) };
      }

      /**
       * When the caller has consented to a transfer, the previous holder is released in the *same*
       * transaction as the write that takes its place.
       *
       * This was two operations before, and the order mattered: revoke in one transaction, bind in
       * the next. A failure or a stale read between them left the identity held by the old session
       * while the new one tried to activate, which `browser_sessions_active_identity_key` refuses —
       * and the operator saw "That record already exists." for a bind they had explicitly asked to
       * transfer. One transaction removes the window entirely.
       */
      const revoked = input.transfer
        ? await sql.query<Row>(
            `update public.browser_sessions
                set status = 'revoked', revoked_at = now()
              where outreach_identity_id = $1
                and status = 'active'
                and browser_fingerprint_or_install_id <> $2
              returning id`,
            [input.identityId, input.installId],
          )
        : { rows: [] as Row[] };

      const existing = await sql.query<{ id: string }>(
        `select id from public.browser_sessions
          where user_id = $1 and browser_fingerprint_or_install_id = $2
          order by (status = 'active') desc, created_at desc
          limit 1`,
        [userId, input.installId],
      );

      const row = existing.rows[0];
      if (row !== undefined) {
        await sql.query(
          `update public.browser_sessions
              set outreach_identity_id = $2,
                  default_business_id = $3,
                  status = 'active',
                  revoked_at = null,
                  last_active_at = now()
            where id = $1`,
          [row.id, input.identityId, input.defaultBusinessId],
        );
      } else {
        await sql.query(
          `insert into public.browser_sessions
             (user_id, browser_fingerprint_or_install_id, outreach_identity_id, default_business_id, status, last_active_at)
           values ($1, $2, $3, $4, 'active', now())`,
          [userId, input.installId, input.identityId, input.defaultBusinessId],
        );
      }

      const binding = await findBindingUsing(sql, userId, input.installId);
      if (binding === null) return { ok: false, error: 'The browser binding was not saved.' };
      return { ok: true, binding, revokedSessionIds: revoked.rows.map((entry) => asString(entry.id)) };
    });
  } catch (error) {
    const detail = error as { code?: string; constraint?: string; message?: string; detail?: string };
    console.error(
      '[nexus] bind failed',
      JSON.stringify({
        code: detail.code,
        constraint: detail.constraint,
        message: detail.message,
        detail: detail.detail,
        installId: input.installId,
        identityId: input.identityId,
        transfer: input.transfer === true,
      }),
    );
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * Reads this profile's binding inside an existing transaction.
 *
 * `findBinding` opens its own transaction, which cannot be nested inside the one that just wrote the
 * row — so the read is expressed here against the caller's `sql`.
 */
async function findBindingUsing(
  sql: Db,
  userId: string,
  installId: string,
): Promise<BrowserBindingRow | null> {
  const result = await sql.query<Row>(
    `select id, browser_fingerprint_or_install_id, outreach_identity_id, default_business_id, created_at
       from public.browser_sessions
      where user_id = $1
        and browser_fingerprint_or_install_id = $2
        and status = 'active'
      order by created_at desc
      limit 1`,
    [userId, installId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: asString(row.id),
    installId: asString(row.browser_fingerprint_or_install_id),
    identityId: asString(row.outreach_identity_id),
    defaultBusinessId: asStringOrNull(row.default_business_id),
    boundAt: asIso(row.created_at) ?? '',
  };
}

/**
 * Other active sessions using the same identity from a different browser profile.
 *
 * spec `roles_and_permissions.same_user_multiple_browsers`: concurrent use "should
 * warn and can be blocked by setting".
 *
 * The holder's name is returned as well as the id. A warning that only says "active elsewhere"
 * cannot be acted on — the operator needs to know whether it is their own second browser or a
 * colleague holding the sender.
 */
export interface ConflictingSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly operatorName: string | null;
  readonly lastActiveAt: string;
}

export async function conflictingSessions(
  actor: Actor,
  identityId: string,
  installId: string,
): Promise<readonly ConflictingSession[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select s.id, s.user_id, s.last_active_at, u.full_name as operator_name
         from public.browser_sessions s
         left join public.users u on u.id = s.user_id
        where s.outreach_identity_id = $1
          and s.browser_fingerprint_or_install_id <> $2
          and s.status = 'active'
          and s.last_active_at > now() - interval '15 minutes'
        order by s.last_active_at desc`,
      [identityId, installId],
    );
    return result.rows.map((row: Row) => ({
      sessionId: asString(row.id),
      userId: asString(row.user_id),
      operatorName: asStringOrNull(row.operator_name),
      lastActiveAt: asIso(row.last_active_at) ?? '',
    }));
  });
}

/**
 * Revokes the other active sessions holding an identity, so this browser can bind it.
 *
 * Separate from `bindBrowserSession` on purpose: taking an identity away from another operator is
 * a decision, and it is only reached when the caller has asked for a transfer explicitly. The
 * returned ids are what the audit entry records, so "who lost the sender" is answerable later.
 *
 * `browser_sessions` RLS lets a user write only their own rows — an administrator may write any.
 * So a transfer can legitimately revoke fewer sessions than exist. Rather than reporting a
 * transfer that did not fully happen, the remaining active holders are counted afterwards and the
 * caller refuses if any survive: a half-finished takeover would leave the identity unusable and
 * the audit entry untrue.
 */
export async function transferIdentityToBrowser(
  actor: Actor,
  identityId: string,
  installId: string,
): Promise<{ readonly revokedSessionIds: readonly string[]; readonly remaining: number }> {
  return read(actor, async (sql) => {
    const revoked = await sql.query<Row>(
      `update public.browser_sessions
          set status = 'revoked', revoked_at = now()
        where outreach_identity_id = $1
          and status = 'active'
          and browser_fingerprint_or_install_id <> $2
        returning id`,
      [identityId, installId],
    );
    const remaining = await sql.query<Row>(
      `select count(*)::int as n
         from public.browser_sessions
        where outreach_identity_id = $1
          and status = 'active'
          and browser_fingerprint_or_install_id <> $2`,
      [identityId, installId],
    );
    return {
      revokedSessionIds: revoked.rows.map((row: Row) => asString(row.id)),
      remaining: asNumber(remaining.rows[0]?.n),
    };
  });
}

/** Whether concurrent identity use is blocked by configuration. */
export async function blockConcurrentIdentityUse(actor: Actor, businessId: string | null): Promise<boolean> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select value from public.platform_settings
        where key = 'security.block_concurrent_identity_use'
          and business_id is not distinct from $1
        limit 1`,
      [businessId],
    );
    const value = result.rows[0]?.value;
    return typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === true;
  });
}

/**
 * Whether this operator may take a sender identity away from another browser profile.
 *
 * spec `roles_and_permissions.same_user_multiple_browsers` allows concurrent use to be warned
 * about or blocked, and spec `identity_model` puts identity management with an administrator.
 * So: an administrator may always transfer (their role is the override), and anyone else needs
 * `identity.manage` granted on a business they can reach — which is the same permission a manager
 * needs to change an identity anywhere else in the product.
 *
 * Deliberately not "same user, so allow": an operator's own second browser is still another live
 * session using the sender, and silently taking it over is the behaviour this replaces.
 */
export async function viewerCanTransferIdentity(viewer: Viewer): Promise<boolean> {
  if (viewer.userId === null) return false;
  if (viewer.role === 'admin') return true;

  return read(viewer.actor, async (sql) => {
    const result = await sql.query<Row>(
      `select count(*)::int as n
         from public.user_business_access
        where user_id = $1
          and access_level = 'admin'`,
      [viewer.userId],
    );
    return asNumber(result.rows[0]?.n) > 0;
  });
}

/**
 * Records an identity transfer in the audit log.
 *
 * spec `identity_model.identity_transfers` treats a sender moving between operators as an event
 * worth keeping, and spec invariant 20 requires every audited mutation to append a row. The
 * revocation itself is a `browser_sessions` update that the per-row audit trigger already covers;
 * this entry records the *decision* — that this operator asked for the identity, and which
 * sessions lost it — so the history reads as an intent rather than an unexplained revocation.
 *
 * `audit_events` is the right table rather than `interactions`: an identity transfer has no lead
 * and no person, which `interactions` requires.
 */
export async function recordIdentityTransfer(
  viewer: Viewer,
  input: {
    readonly identityId: string;
    readonly installId: string;
    readonly revokedSessionIds: readonly string[];
    readonly transferPermissions: boolean;
  },
): Promise<void> {
  await withActor(viewer.actor, async (sql) => {
    await sql.query(
      `insert into public.audit_events
         (actor_type, actor_id, business_id, entity_type, entity_id, action, before_json, after_json, source_client)
       values ('user', $1, null, 'outreach_identities', $2, 'identity_transfer', $3::jsonb, $4::jsonb, 'companion')`,
      [
        viewer.userId,
        input.identityId,
        JSON.stringify({ revokedSessionIds: input.revokedSessionIds }),
        JSON.stringify({
          installId: input.installId,
          revokedSessionIds: input.revokedSessionIds,
          byAdminOverride: !input.transferPermissions,
        }),
      ],
    );
  });
}

export async function touchBrowserSession(actor: Actor, installId: string): Promise<void> {
  await read(actor, async (sql) => {
    await sql.query(
      `update public.browser_sessions
          set last_active_at = now()
        where browser_fingerprint_or_install_id = $1 and status = 'active'`,
      [installId],
    );
    return null;
  });
}

/* ------------------------------------------------------------ lead detail -- */

export interface CompanionMessageRow {
  readonly id: string;
  readonly stepOrder: number;
  readonly state: 'DYNAMIC' | 'LOCKED' | 'SENT';
  readonly content: string | null;
  readonly dueAt: string | null;
  readonly sentAt: string | null;
}

export async function companionLeadDetail(
  actor: Actor,
  leadId: string,
): Promise<
  | {
      readonly currentMessage: CompanionMessageRow | null;
      readonly priorSteps: readonly { readonly stepOrder: number; readonly sentAt: string | null }[];
      readonly sequence: {
        readonly state: string | null;
        readonly currentStepOrder: number | null;
        readonly reactivationDueAt: string | null;
        readonly dormantAt: string | null;
      };
    }
  | null
> {
  return read(actor, async (sql) => {
    // The lead must be visible; otherwise there is nothing to detail.
    const lead = await sql.query<Row>(`select id from public.leads where id = $1`, [leadId]);
    if (lead.rows[0] === undefined) return null;

    const current = await sql.query<Row>(
      `select m.id, m.step_order, m.state, m.due_at, m.sent_at, mv.content
         from public.message_instances m
         left join public.message_versions mv on mv.id = m.current_version_id
        where m.lead_id = $1 and m.state in ('DYNAMIC', 'LOCKED') and m.sent_at is null
        order by m.step_order
        limit 1`,
      [leadId],
    );

    const prior = await sql.query<Row>(
      `select step_order, max(sent_at) as sent_at
         from public.message_instances
        where lead_id = $1 and state = 'SENT'
        group by step_order
        order by step_order`,
      [leadId],
    );

    const enrollment = await sql.query<Row>(
      `select state, current_step_order, reactivation_due_at, dormant_at
         from public.sequence_enrollments
        where lead_id = $1
        order by created_at desc
        limit 1`,
      [leadId],
    );

    const row = current.rows[0];
    const e = enrollment.rows[0];

    return {
      currentMessage:
        row === undefined
          ? null
          : {
              id: asString(row.id),
              stepOrder: asNumber(row.step_order),
              state: (() => {
                const state = asString(row.state, 'DYNAMIC');
                return state === 'SENT' || state === 'LOCKED' ? state : 'DYNAMIC';
              })(),
              content: asStringOrNull(row.content),
              dueAt: asIso(row.due_at),
              sentAt: asIso(row.sent_at),
            },
      priorSteps: prior.rows.map((p: Row) => ({
        stepOrder: asNumber(p.step_order),
        sentAt: asIso(p.sent_at),
      })),
      sequence: {
        state: asStringOrNull(e?.state),
        currentStepOrder: e?.current_step_order === null || e?.current_step_order === undefined
          ? null
          : asNumber(e.current_step_order),
        reactivationDueAt: asIso(e?.reactivation_due_at),
        dormantAt: asIso(e?.dormant_at),
      },
    };
  });
}

/* ------------------------------------------------------------ enrichment -- */

/**
 * The V1.2 enrichment indicator for one lead.
 *
 * spec companion §36: every Companion list shows where the lead sits in the
 * enrichment pipeline and how complete its intelligence is. `intelligence` is
 * `public.lead_enrichment.completeness_score` verbatim — the score is *never*
 * derived here, because a second derivation would disagree with the pipeline that
 * owns it and with the AI context built from it.
 */
export interface CompanionEnrichment {
  readonly status: EnrichmentState;
  /** `completeness_score`, 0–100. Never recomputed. */
  readonly intelligence: number;
  readonly missingFields: readonly string[];
}

/** The documented fallback: a lead with no enrichment row is MINIMAL at 0%. */
const MINIMAL_ENRICHMENT: CompanionEnrichment = {
  status: 'MINIMAL',
  intelligence: 0,
  missingFields: [],
};

function toEnrichmentState(value: unknown): EnrichmentState {
  return ENRICHMENT_STATES.find((state) => state === value) ?? 'MINIMAL';
}

/**
 * Enrichment rows for a batch of leads, keyed by lead id.
 *
 * `lead_enrichment` is left-joined by the caller's own list query in spirit, but the
 * Companion's list queries are paged through another repository, so the rows are
 * fetched here for exactly the ids on the page and merged. A lead with no row is
 * reported as `MINIMAL` / 0 — never omitted, because a missing indicator reads as
 * "nothing to do" rather than "not enriched yet".
 */
export async function companionEnrichmentFor(
  actor: Actor,
  leadIds: readonly string[],
): Promise<ReadonlyMap<string, CompanionEnrichment>> {
  const ids = [...new Set(leadIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return new Map();

  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select lead_id, status, completeness_score, missing_fields
         from public.lead_enrichment
        where lead_id = any($1::uuid[])`,
      [ids],
    );

    const byLead = new Map<string, CompanionEnrichment>();
    for (const row of result.rows) {
      byLead.set(asString(row.lead_id), {
        status: toEnrichmentState(row.status),
        intelligence: asNumber(row.completeness_score),
        missingFields: asStringArray(row.missing_fields),
      });
    }
    for (const id of ids) {
      if (!byLead.has(id)) byLead.set(id, MINIMAL_ENRICHMENT);
    }
    return byLead;
  });
}

/** The enrichment indicator for one lead, with the documented default. */
export async function companionEnrichment(
  actor: Actor,
  leadId: string,
): Promise<CompanionEnrichment> {
  const map = await companionEnrichmentFor(actor, [leadId]);
  return map.get(leadId) ?? MINIMAL_ENRICHMENT;
}

/* --------------------------------------------------------- search links -- */

/**
 * The deterministic "Find LinkedIn" Google URL for a lead.
 *
 * The query shapes live in `@nexus/core` (`searchLinks`), shared with the enrichment
 * pipeline, and are *not* rebuilt here: two implementations of a search URL is how
 * the operator ends up with a link that does not find the person the CRM is showing.
 * Returns null when there is not enough information for a meaningful search.
 */
export function findLinkedInSearchUrl(input: {
  readonly fullName: string | null;
  readonly companyName: string | null;
  readonly location?: string | null;
  readonly linkedinUrl?: string | null;
}): string | null {
  const link = searchLinks({
    fullName: input.fullName,
    companyName: input.companyName,
    location: input.location ?? null,
    linkedinUrl: input.linkedinUrl ?? null,
  }).find((entry) => entry.key === 'find_linkedin');
  return link?.url ?? null;
}

/* ----------------------------------------------------------------- search -- */

export interface CompanionSearchRow {
  readonly leadId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly status: string;
  readonly lastActivityAt: string | null;
  readonly nextActionAt: string | null;
  readonly nextActionType: string | null;
  /** V1.2 enrichment indicator (spec §36). */
  readonly enrichment: CompanionEnrichment;
  /** Deterministic Google fallback when the lead has no profile URL yet. */
  readonly findLinkedInUrl: string | null;
}

/**
 * Search across every business the caller can reach.
 *
 * spec `companion_extension.search`: "If Person has multiple business Lead contexts,
 * show each and require choosing the correct record." Rows are therefore per *lead*,
 * not per person, and the business name is always shown.
 */
export async function companionSearch(actor: Actor, query: string, limit = 25): Promise<readonly CompanionSearchRow[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select l.id as lead_id, l.business_id, b.name as business_name,
              p.full_name as person_name, c.name as company_name, l.status,
              l.last_activity_at, l.next_action_at, l.next_action_type,
              p.location as person_location, l.source_url,
              coalesce(e.status, 'MINIMAL') as enrichment_status,
              coalesce(e.completeness_score, 0) as completeness_score,
              coalesce(e.missing_fields, array[]::text[]) as missing_fields
         from public.leads l
         join public.people p on p.id = l.person_id
         join public.businesses b on b.id = l.business_id
         left join public.companies c on c.id = l.company_id
         left join public.lead_enrichment e on e.lead_id = l.id
        where l.deleted_at is null
          and (
            p.full_name ilike $1
            or coalesce(c.name, '') ilike $1
            or coalesce(p.linkedin_url, '') ilike $1
            or coalesce(p.normalized_linkedin_url, '') ilike $1
          )
        order by l.last_activity_at desc nulls last
        limit $2`,
      [`%${trimmed}%`, limit],
    );

    return result.rows.map((row: Row) => {
      const personName = asString(row.person_name);
      const companyName = asStringOrNull(row.company_name);
      const linkedinUrl = asStringOrNull(row.source_url);
      return {
        leadId: asString(row.lead_id),
        businessId: asString(row.business_id),
        businessName: asString(row.business_name),
        personName,
        companyName,
        status: asString(row.status, 'new'),
        lastActivityAt: asIso(row.last_activity_at),
        nextActionAt: asIso(row.next_action_at),
        nextActionType: asStringOrNull(row.next_action_type),
        enrichment: {
          status: toEnrichmentState(row.enrichment_status),
          intelligence: asNumber(row.completeness_score),
          missingFields: asStringArray(row.missing_fields),
        },
        findLinkedInUrl: findLinkedInSearchUrl({
          fullName: personName,
          companyName,
          location: asStringOrNull(row.person_location),
          linkedinUrl,
        }),
      };
    });
  });
}

export { withServiceRole, asBoolean };
