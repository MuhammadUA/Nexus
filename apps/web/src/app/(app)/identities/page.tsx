import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, EmptyState, Grid, PageHead, Stat, type Column } from '@nexus/ui';

import { CreateIdentityForm } from '@/components/identity-forms';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  IDENTITY_PLATFORMS,
  IDENTITY_STATUSES,
  listAssignableUsers,
  listIdentities,
  type IdentityListRow,
} from '@/lib/repo/identities';
import {
  CHANNEL_ACCOUNT_CHANNELS,
  CHANNEL_LABELS,
  CHANNEL_ORDER,
  channelLabel,
  isChannelAccountChannel,
  legacyPlatformLabel,
  listChannelAccounts,
  type ChannelAccountChannel,
} from '@/lib/channel-vocabulary';

export const dynamic = 'force-dynamic';

/**
 * A17 (index) — **Channel Accounts** (V1.1 name: "Outreach Identities").
 *
 * The product vocabulary moved in V1.2 (spec §23.1: *"V1.2's product-facing name
 * for an `outreach_identities` row is a channel account"*), so this screen is
 * renamed and re-columned. What did **not** move is the storage: the rows are
 * still `public.outreach_identities`, the RLS policy is still `identity_visible`,
 * and the Companion's LinkedIn binding still reads the same table through
 * `outreach_identity_business_access`. The rename is presentational, and the
 * `platform` column is now shown only as secondary history beside the channel.
 *
 * Visibility is RLS, not a filter written here: an admin sees every account and a
 * non-admin only the ones assigned to them. That is why this page can load the
 * session/manager columns from the identities repository and the channel column
 * from the channel-account read without either of them filtering by owner.
 *
 * spec §20 is the reason the channel is a column of its own: discovery source and
 * outreach channel are independent, so an account's channel is not derivable from
 * where its leads were found.
 */
export default async function ChannelAccountsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly channel?: string }>;
}): Promise<ReactNode> {
  const { channel: channelParam } = await searchParams;
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/identities' });

  const [identities, accounts, users] = await Promise.all([
    listIdentities(context.viewer.actor),
    listChannelAccounts(context.viewer.actor),
    listAssignableUsers(context.viewer.actor),
  ]);

  /*
   * The two reads are ordered by `display_name` and scoped by the same RLS policy,
   * so they describe the same rows. Joining by id — rather than by position —
   * keeps that a checked fact: a divergence throws instead of silently pairing a
   * manager with the wrong account.
   */
  const channelById = new Map(accounts.map((account) => [account.id, account]));
  const rows: readonly ChannelAccountListRow[] = identities.map((identity) => {
    const account = channelById.get(identity.id);
    if (account === undefined) {
      throw new Error(
        `channel account ${identity.id} is missing from the channel-accounts read; the two reads disagree`,
      );
    }
    return { ...identity, channel: account.channel };
  });

  const activeChannel: ChannelAccountChannel | null =
    channelParam !== undefined && isChannelAccountChannel(channelParam) ? channelParam : null;

  const visible = activeChannel === null ? rows : rows.filter((row) => row.channel === activeChannel);
  const grouped = groupByChannel(visible);
  const conflicted = visible.filter((row) => row.concurrentSessions);

  // Reassigning an account is an admin act (spec `roles_and_permissions.admin.can`:
  // "Assign/reassign LinkedIn outreach identities"); the insert is admin-only by RLS.
  const canCreate = context.viewer.role === 'admin';

  const columns: readonly Column<ChannelAccountListRow>[] = [
    {
      key: 'account',
      header: 'Channel account',
      cell: (row) => (
        <div className="nx-stack nx-stack--sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/identities/${row.id}`}>
            <strong>{row.displayName}</strong>
          </a>
          {row.profileUrl !== null && (
            <a className="nx-hint" href={row.profileUrl} target="_blank" rel="noreferrer noopener">
              {row.profileUrl}
            </a>
          )}
        </div>
      ),
    },
    {
      key: 'channel',
      header: 'Channel',
      cell: (row) => (
        <div className="nx-stack nx-stack--sm">
          <Chip accent="indigo" dataState={row.channel}>
            {channelLabel(row.channel)}
          </Chip>
          {legacyLabel(row) !== null && <span className="nx-hint">{legacyLabel(row)}</span>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Chip accent={row.status === 'active' ? 'green' : row.status === 'paused' ? 'amber' : 'neutral'}>
          {row.status}
        </Chip>
      ),
    },
    {
      key: 'manager',
      header: 'Managed by',
      cell: (row) =>
        row.managerName === null ? (
          <Chip accent="cyan">unassigned</Chip>
        ) : (
          <span>{row.managerName}</span>
        ),
    },
    {
      key: 'businesses',
      header: 'Business access',
      cell: (row) =>
        row.businessNames.length === 0 ? (
          <span className="nx-hint">none granted</span>
        ) : (
          <div className="nx-row nx-row--wrap">
            {row.businessNames.map((name) => (
              <Chip key={name} accent="indigo">
                {name}
              </Chip>
            ))}
          </div>
        ),
    },
    {
      key: 'target',
      header: 'Sent today',
      numeric: true,
      cell: (row) =>
        row.dailyTarget === 0
          ? String(row.dailySentCount)
          : `${String(row.dailySentCount)} / ${String(row.dailyTarget)}`,
    },
    {
      key: 'sessions',
      header: 'Browser sessions',
      numeric: true,
      // spec `roles_and_permissions.same_user_multiple_browsers`: concurrent use of
      // one account warns. The database also refuses a second binding through
      // `browser_sessions_active_identity_key` (0010).
      cell: (row) => (
        <Chip accent={row.concurrentSessions ? 'amber' : 'neutral'} title={conflictTitle(row)}>
          {row.activeSessionCount}
        </Chip>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (row) => <span className="nx-table__mono">{row.createdAt?.slice(0, 10) ?? '—'}</span>,
    },
  ];

  return (
    <>
      <PageHead
        subtitle="Channel accounts — one sending account per channel — who manages them, and which businesses each one may work."
        actions={
          <div className="nx-row nx-row--wrap">
            <Chip accent={activeChannel === null ? 'indigo' : 'neutral'}>
              <a href="/identities">All channels · {rows.length}</a>
            </Chip>
            {CHANNEL_ORDER.map((channel) => {
              const count = rows.filter((row) => row.channel === channel).length;
              return (
                <Chip key={channel} accent={activeChannel === channel ? 'indigo' : 'neutral'}>
                  <a href={`/identities?channel=${channel}`}>
                    {CHANNEL_LABELS[channel]} · {count}
                  </a>
                </Chip>
              );
            })}
          </div>
        }
      >
        Channel Accounts
      </PageHead>

      {conflicted.length > 0 && (
        <Alert accent="amber" role="alert">
          {conflicted.length === 1
            ? `${conflicted[0]?.displayName ?? 'One channel account'} has more than one live browser session.`
            : `${String(conflicted.length)} channel accounts have more than one live browser session.`}{' '}
          spec `roles_and_permissions.same_user_multiple_browsers` asks for exactly this to be surfaced.
        </Alert>
      )}

      <Grid cols={4}>
        <Stat value={rows.length} label="Channel accounts visible to you" meta={`${String(accounts.length)} channel-account rows`} />
        <Stat
          value={rows.filter((row) => row.status === 'active').length}
          label="Active"
          meta={`${String(rows.filter((row) => row.status !== 'active').length)} paused or retired`}
        />
        <Stat
          value={rows.filter((row) => row.managedByUserId === null).length}
          label="Unassigned"
          meta="available for self-assignment"
        />
        <Stat
          value={grouped.filter((group) => group.count > 0).length}
          label="Channels in use"
          meta={`of ${String(CHANNEL_ORDER.length)} supported`}
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="neutral" title="Discovery source and outreach channel are independent">
        <span>
          A lead discovered on Reddit can be contacted by email, and a LinkedIn-discovered lead can be contacted
          on Upwork. The channel below says how <em>this account</em> reaches people; a lead&rsquo;s discovery
          source says only how it was found. Neither constrains the other (spec §20).
        </span>
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {grouped.map((group) => (
        <div key={group.channel}>
          <Card
            title={group.label}
            actions={
              <div className="nx-row">
                <Chip accent={group.active === 0 ? 'neutral' : 'green'}>{`${String(group.active)} active`}</Chip>
                <Chip>{`${String(group.count)} account${group.count === 1 ? '' : 's'}`}</Chip>
              </div>
            }
          >
            <DataTable
              columns={columns}
              rows={group.rows}
              rowKey={(row) => row.id}
              caption={`Channel accounts on ${group.label}, with manager, business access and browser sessions`}
              empty={<span className="nx-hint">No account sends on this channel.</span>}
            />
          </Card>
          <div style={{ height: 'var(--nx-space-lg)' }} />
        </div>
      ))}

      {grouped.length === 0 && (
        <Card title="Channel accounts">
          <EmptyState
            title={activeChannel === null ? 'No channel account is assigned to you' : `No account sends on ${channelLabel(activeChannel)}`}
            body={
              activeChannel === null
                ? 'An administrator assigns channel accounts from this screen. An unassigned account appears in nobody’s sender list.'
                : 'Clear the channel filter to see every account you may manage.'
            }
          />
        </Card>
      )}

      {canCreate && (
        <Card
          title="Add channel account"
          actions={<Chip accent="indigo">admin only</Chip>}
          footer={
            <span className="nx-hint">
              Business access is granted on the account&rsquo;s own screen, because Companion visibility is the
              intersection of the operator&rsquo;s grants and the account&rsquo;s grants. The legacy platform column
              is kept for historical attribution and is set from the channel on creation.
            </span>
          }
        >
          <CreateIdentityForm
            users={users.map((user) => ({ value: user.id, label: user.label }))}
            channels={CHANNEL_ACCOUNT_CHANNELS.map((channel) => ({ value: channel, label: CHANNEL_LABELS[channel] }))}
            platforms={IDENTITY_PLATFORMS}
            statuses={IDENTITY_STATUSES}
          />
        </Card>
      )}

      <p className="nx-hint" style={{ marginTop: 'var(--nx-space-md)' }}>
        Open any account to edit its channel, targets, business access, browser sessions and transfer history.
      </p>
    </>
  );
}

/** An identity row plus the channel noun the Channel Accounts vocabulary adds. */
interface ChannelAccountListRow extends IdentityListRow {
  readonly channel: string;
}

interface ChannelGroup {
  readonly channel: ChannelAccountChannel;
  readonly label: string;
  readonly count: number;
  readonly active: number;
  readonly rows: readonly ChannelAccountListRow[];
}

/**
 * Accounts grouped by channel, in `CHANNEL_ORDER`.
 *
 * A channel with no accounts is **omitted** rather than rendered as an empty
 * group: the chip row above already states the zero, and four empty tables would
 * bury the two channels that are actually in use. Accounts on a channel this
 * build does not know are appended in their own group rather than dropped.
 */
function groupByChannel(rows: readonly ChannelAccountListRow[]): readonly ChannelGroup[] {
  const known = new Set<string>(CHANNEL_ORDER);
  const groups: ChannelGroup[] = [];
  for (const channel of CHANNEL_ORDER) {
    const inChannel = rows.filter((row) => row.channel === channel);
    if (inChannel.length === 0) continue;
    groups.push({
      channel,
      label: CHANNEL_LABELS[channel],
      count: inChannel.length,
      active: inChannel.filter((row) => row.status === 'active').length,
      rows: inChannel,
    });
  }

  const unknown = [...new Set(rows.filter((row) => !known.has(row.channel)).map((row) => row.channel))].sort();
  for (const channel of unknown) {
    const inChannel = rows.filter((row) => row.channel === channel);
    groups.push({
      channel: channel as ChannelAccountChannel,
      label: channelLabel(channel),
      count: inChannel.length,
      active: inChannel.filter((row) => row.status === 'active').length,
      rows: inChannel,
    });
  }

  return groups;
}

/** The legacy platform, shown only when it disagrees with the channel. */
function legacyLabel(row: ChannelAccountListRow): string | null {
  return legacyPlatformLabel(row.platform, row.channel);
}

function conflictTitle(row: ChannelAccountListRow): string {
  if (row.concurrentSessions) {
    return 'More than one live browser session is using this channel account.';
  }
  if (row.activeSessionCount > 0) {
    return 'One live browser session is using this channel account.';
  }
  return 'No browser session is currently bound to this channel account.';
}
