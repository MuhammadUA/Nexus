/**
 * V1.2 presentation vocabulary shared by the Overview, Insights and Channel
 * Accounts screens.
 *
 * Two things live here, and nothing else.
 *
 *   1. **Pure labelling.** Discovery source, outreach channel and enrichment
 *      state each have exactly one human spelling in this application. They are
 *      declared once, as data, so the Overview funnel, the Insights tables and
 *      the Channel Accounts list cannot disagree about what `AGENT_RESEARCH_PENDING`
 *      or `upwork` should read as. Nothing in this half touches a database or a
 *      clock, which is what makes it assertable in `v1-2-channel-accounts.test.ts`.
 *
 *   2. **Channel-aware account reads.** `public.outreach_identities` gained a
 *      `channel` column in migration 0030 and `public.channel_accounts` was added
 *      as a SECURITY INVOKER projection of the same rows. `@/lib/repo/identities`
 *      predates both and exposes no `channel` field, and the Companion's LinkedIn
 *      binding still reads the same table through `outreach_identity_business_access`.
 *      These two functions are the narrow read path the vocabulary screens add on
 *      top: they select only nouns the screen renders (channel, legacy platform,
 *      manager, status, daily counter) and run through `withActor`, so the
 *      `identity_visible` policy — not a filter written here — decides which rows
 *      an operator may see. No write path, no RLS policy and no foreign key is
 *      touched.
 *
 * Discovery source and outreach channel are independent concepts (spec §20): a
 * lead discovered on Reddit may be contacted by email, and a LinkedIn-discovered
 * lead may be contacted on Upwork. Nothing here constrains one by the other.
 */
import 'server-only';

import { OUTREACH_CHANNELS, type EnrichmentState } from '@nexus/core';

import { withActor, type Actor } from './actor';
import type { Row } from './sql';
import { asIso, asNumber, asString, asStringOrNull } from './repo/common';

/* ------------------------------------------------------------- channels -- */

/**
 * The V1.2 channels, plus `other`.
 *
 * `other` is not a fifth channel the product schedules on — migration 0030 maps
 * the legacy `twitter` platform onto it, so a pre-V1.2 row survives the vocabulary
 * change without being re-labelled as something it never was. It is listed last so
 * a selector reads LinkedIn / Email / Instagram / Upwork / Other.
 */
export const CHANNEL_ACCOUNT_CHANNELS = [...OUTREACH_CHANNELS, 'other'] as const;
export type ChannelAccountChannel = (typeof CHANNEL_ACCOUNT_CHANNELS)[number];

/** Channel display names. One spelling per channel, used by every screen. */
export const CHANNEL_LABELS: Readonly<Record<ChannelAccountChannel, string>> = {
  linkedin: 'LinkedIn',
  email: 'Email',
  instagram: 'Instagram',
  upwork: 'Upwork',
  other: 'Other',
};

/** The order channels are listed in, so two screens sort identically. */
export const CHANNEL_ORDER: readonly ChannelAccountChannel[] = CHANNEL_ACCOUNT_CHANNELS;

/**
 * Whether a stored `channel` is one this build knows.
 *
 * A value written by a later migration must not blank the cell, so an unknown
 * channel is displayed verbatim rather than coerced to `other`.
 */
export function isChannelAccountChannel(value: string | null): value is ChannelAccountChannel {
  return value !== null && (CHANNEL_ACCOUNT_CHANNELS as readonly string[]).includes(value);
}

/** Human channel name; an unrecognised value is returned as it was stored. */
export function channelLabel(channel: string | null): string {
  if (channel === null || channel.trim().length === 0) return 'Unknown channel';
  return isChannelAccountChannel(channel) ? CHANNEL_LABELS[channel] : channel;
}

/**
 * The legacy `platform` value, shown **only** when it says something the channel
 * does not.
 *
 * This is the whole point of keeping the column: `platform` is a historical
 * attribution and must never be presented as the account's current channel. A
 * LinkedIn account created before V1.2 has `channel = 'linkedin'` and
 * `platform = 'linkedin'`, and printing "LinkedIn · LinkedIn" would be noise. A
 * Twitter-era account has `channel = 'other'` and `platform = 'twitter'`, and
 * hiding that would misreport what it is.
 */
export function legacyPlatformLabel(
  platform: string | null,
  channel: string | null,
): string | null {
  if (platform === null) return null;
  const trimmed = platform.trim();
  if (trimmed.length === 0) return null;
  if (isChannelAccountChannel(trimmed) && trimmed === channel) return null;
  return `legacy ${trimmed}`;
}

/* ---------------------------------------------------- enrichment funnel -- */

/**
 * Pipeline order, not alphabetical and not by count: the funnel reads top to
 * bottom as a progression from "we know almost nothing" to "ready to send".
 */
export const ENRICHMENT_STATE_ORDER: readonly EnrichmentState[] = [
  'MINIMAL',
  'NEEDS_PROFILE',
  'PROFILE_READY',
  'COMPANY_RESEARCH_PENDING',
  'AGENT_RESEARCH_PENDING',
  'AI_PROCESSING',
  'READY',
  'NEEDS_REVIEW',
  'FAILED',
];

const ENRICHMENT_STATE_LABELS: Readonly<Record<EnrichmentState, string>> = {
  MINIMAL: 'Minimal',
  NEEDS_PROFILE: 'Needs profile',
  PROFILE_READY: 'Profile ready',
  COMPANY_RESEARCH_PENDING: 'Company research pending',
  AGENT_RESEARCH_PENDING: 'Agent research pending',
  AI_PROCESSING: 'AI processing',
  READY: 'Ready for outreach',
  NEEDS_REVIEW: 'Needs review',
  FAILED: 'Failed',
};

/** Human state name. Every `ENRICHMENT_STATES` value has an entry above. */
export function enrichmentStateLabel(state: string): string {
  const known = ENRICHMENT_STATE_LABELS[state as EnrichmentState];
  return known ?? state.replace(/_/g, ' ').toLowerCase();
}

export type StatusTone = 'cyan' | 'green' | 'amber' | 'red' | 'indigo' | 'neutral';

/**
 * Accent per enrichment state, following the fixed semantics in
 * `@nexus/ui`'s `status_accents`: cyan = new/profile, amber = waiting/follow-up,
 * green = ready, red = failed, indigo = configuration. The label always renders
 * beside the colour, so state is never conveyed by colour alone.
 */
export function enrichmentStateAccent(state: string): StatusTone {
  switch (state) {
    case 'READY':
      return 'green';
    case 'FAILED':
      return 'red';
    case 'COMPANY_RESEARCH_PENDING':
    case 'AGENT_RESEARCH_PENDING':
    case 'AI_PROCESSING':
    case 'NEEDS_REVIEW':
      return 'amber';
    case 'PROFILE_READY':
      return 'indigo';
    case 'MINIMAL':
    case 'NEEDS_PROFILE':
      return 'cyan';
    default:
      return 'neutral';
  }
}

/** Accent per agent job status. Labels are always rendered alongside. */
export function agentJobStatusAccent(status: string): StatusTone {
  switch (status) {
    case 'COMPLETE':
      return 'green';
    case 'FAILED':
      return 'red';
    case 'WAITING_AI':
      return 'amber';
    case 'RUNNING':
      return 'indigo';
    case 'OPEN':
      return 'cyan';
    default:
      return 'neutral';
  }
}

/** `WAITING_AI` -> `Waiting AI`, `COMPLETE` -> `Complete`. */
export function agentJobStatusLabel(status: string): string {
  const known = AGENT_JOB_STATUS_LABELS[status];
  return known ?? status.replace(/_/g, ' ').toLowerCase();
}

const AGENT_JOB_STATUS_LABELS: Readonly<Record<string, string>> = {
  OPEN: 'Open',
  RUNNING: 'Running',
  WAITING_AI: 'Waiting AI',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/* ---------------------------------------------------- activity flavours -- */

/**
 * The four feeds the Overview's "recent activity" merges. `kind` is carried
 * through so the row can render the record it came from and link to it, rather
 * than every entry looking like an audit event.
 */
export type ActivityKind = 'audit' | 'interaction' | 'signal' | 'agent_job';

export function activityKindLabel(kind: string): string {
  switch (kind) {
    case 'audit':
      return 'audit';
    case 'interaction':
      return 'timeline';
    case 'signal':
      return 'signal';
    case 'agent_job':
      return 'agent job';
    default:
      return kind;
  }
}

export function activityKindAccent(kind: string): StatusTone {
  switch (kind) {
    case 'signal':
      return 'cyan';
    case 'agent_job':
      return 'indigo';
    case 'interaction':
      return 'amber';
    default:
      return 'neutral';
  }
}

/** Where an activity row points, so the feed is navigable rather than decorative. */
export interface ActivityLink {
  readonly href: string;
  readonly label: string;
}

/**
 * The route an activity row links to, or null when no screen matches it.
 *
 * Only two kinds can be linked *correctly*. A signal is recorded against a lead,
 * and an agent job has its own queue screen. An `audit_events` row carries a
 * generic `entity_id` and an interaction a `lead_id`, so linking those by id
 * alone would, for the ordinary cases, point at a record that is not a lead —
 * and a link that opens the wrong row is worse than plain text.
 */
export function activityLink(
  kind: string,
  leadId: string | null,
  businessKey: string,
): ActivityLink | null {
  if (kind === 'agent_job') return { href: `/b/${businessKey}/agent-jobs`, label: 'Agent jobs' };
  if ((kind === 'signal' || kind === 'interaction') && leadId !== null && leadId.length > 0) {
    return { href: `/b/${businessKey}/leads/${leadId}`, label: 'Open lead' };
  }
  return null;
}

/* --------------------------------------------- channel-aware DB reads -- */

/**
 * The channel nouns the Channel Accounts screens render.
 *
 * Deliberately not `IdentityListRow`: the account's manager, business grants and
 * browser sessions stay owned by `@/lib/repo/identities`, and duplicating them
 * here would create a second definition of "who may see this account".
 */
export interface ChannelAccountRow {
  readonly id: string;
  /** V1.2 outreach channel (`outreach_identities.channel`, not null since 0030). */
  readonly channel: string;
  /** Legacy historical attribution, display only. */
  readonly platform: string | null;
  readonly displayName: string;
  readonly status: string;
  readonly managedByUserId: string | null;
  readonly managerName: string | null;
  readonly dailyTarget: number;
  readonly dailySentCount: number;
  readonly profileUrl: string | null;
  readonly normalizedProfileUrl: string | null;
  readonly notes: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

const CHANNEL_ACCOUNT_COLUMNS = `
  i.id, i.channel, i.platform, i.display_name, i.status, i.managed_by_user_id,
  i.daily_target, i.daily_sent_count, i.profile_url, i.normalized_profile_url,
  i.notes, i.created_at, i.updated_at,
  coalesce(m.full_name, m.email) as manager_name
`;

const CHANNEL_ACCOUNT_FROM = `
  from public.outreach_identities i
  left join public.users m on m.id = i.managed_by_user_id
`;

/** Ordering, so a list and a detail screen never disagree, and paging is stable. */
const CHANNEL_ACCOUNT_ORDER = `
  order by i.channel, i.status, i.display_name
`;

function mapChannelAccount(row: Row): ChannelAccountRow {
  return {
    id: asString(row.id),
    channel: asString(row.channel, 'other'),
    platform: asStringOrNull(row.platform),
    displayName: asString(row.display_name),
    status: asString(row.status, 'active'),
    managedByUserId: asStringOrNull(row.managed_by_user_id),
    managerName: asStringOrNull(row.manager_name),
    dailyTarget: asNumber(row.daily_target),
    dailySentCount: asNumber(row.daily_sent_count),
    profileUrl: asStringOrNull(row.profile_url),
    normalizedProfileUrl: asStringOrNull(row.normalized_profile_url),
    notes: asStringOrNull(row.notes),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

/**
 * Every channel account the viewer may see.
 *
 * No owner filter is written here. `public.identity_visible` decides: an admin
 * sees every account, a non-admin only the ones assigned to them, and a legacy
 * grant in `outreach_identity_business_access` is irrelevant to that policy —
 * which is why the Companion's LinkedIn binding keeps working unchanged.
 */
export async function listChannelAccounts(actor: Actor): Promise<readonly ChannelAccountRow[]> {
  return withActor(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select ${CHANNEL_ACCOUNT_COLUMNS} ${CHANNEL_ACCOUNT_FROM}
        where i.deleted_at is null
        ${CHANNEL_ACCOUNT_ORDER}`,
    );
    return result.rows.map((row: Row) => mapChannelAccount(row));
  });
}

/** One account by id, or null — invisibility through RLS reads as absence. */
export async function getChannelAccount(
  actor: Actor,
  identityId: string,
): Promise<ChannelAccountRow | null> {
  return withActor(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select ${CHANNEL_ACCOUNT_COLUMNS} ${CHANNEL_ACCOUNT_FROM}
        where i.id = $1 and i.deleted_at is null`,
      [identityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapChannelAccount(row);
  });
}

/**
 * The channel every account bound to `businessId` currently sends on.
 *
 * Only the channel is read, and only for accounts already granted to the business
 * through `outreach_identity_business_access` — the same grant the Companion's
 * binding uses. This is the Overview's "accounts and channels serving this
 * business" row, not an identity-management surface.
 */
export async function listBusinessAccountChannels(
  actor: Actor,
  businessId: string,
): Promise<readonly string[]> {
  return withActor(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select distinct i.channel
         from public.outreach_identities i
         join public.outreach_identity_business_access a
           on a.outreach_identity_id = i.id
        where a.business_id = $1
          and i.deleted_at is null`,
      [businessId],
    );
    return result.rows.map((row: Row) => asString(row.channel, 'other'));
  });
}
