import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Stat, type Column } from '@nexus/ui';

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

export const dynamic = 'force-dynamic';

/**
 * A17 (index) â€” Outreach Identities.
 *
 * There is no A-number of its own in the spec's `screen_inventory`; it is the
 * navigable list that A17 sits under (`ADMIN_NAV`: "Outreach Identities"). It exists
 * because A17 can only be reached if the operator can see which identities exist.
 *
 * Visibility is RLS, not a filter written here: `public.identity_visible` gives an
 * admin every identity and a non-admin only the ones assigned to them
 * (spec `roles_and_permissions.user.can`: "Use only LinkedIn identities assigned to
 * them").
 */
export default async function IdentitiesPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/identities' });
  const [identities, users] = await Promise.all([
    listIdentities(context.viewer.actor),
    listAssignableUsers(context.viewer.actor),
  ]);

  // Reassigning an identity is an admin act (spec `roles_and_permissions.admin.can`:
  // "Assign/reassign LinkedIn outreach identities"); the insert is admin-only by RLS.
  const canCreate = context.viewer.role === 'admin';

  const conflicted = identities.filter((identity) => identity.concurrentSessions);

  const columns: readonly Column<IdentityListRow>[] = [
    {
      key: 'identity',
      header: 'Identity',
      cell: (identity) => (
        <div className="nx-stack nx-stack--sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/identities/${identity.id}`}>
            <strong>{identity.displayName}</strong>
          </a>
          {identity.profileUrl !== null && (
            <a className="nx-hint" href={identity.profileUrl} target="_blank" rel="noreferrer noopener">
              {identity.profileUrl}
            </a>
          )}
        </div>
      ),
    },
    { key: 'platform', header: 'Platform', cell: (identity) => identity.platform },
    {
      key: 'status',
      header: 'Status',
      cell: (identity) => (
        <Chip
          accent={identity.status === 'active' ? 'green' : identity.status === 'paused' ? 'amber' : 'neutral'}
        >
          {identity.status}
        </Chip>
      ),
    },
    {
      key: 'manager',
      header: 'Manager',
      cell: (identity) =>
        identity.managerName === null ? (
          <Chip accent="cyan">unassigned</Chip>
        ) : (
          <span>{identity.managerName}</span>
        ),
    },
    {
      key: 'businesses',
      header: 'Business access',
      cell: (identity) =>
        identity.businessNames.length === 0 ? (
          <span className="nx-hint">none granted</span>
        ) : (
          <div className="nx-row nx-row--wrap">
            {identity.businessNames.map((name) => (
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
      cell: (identity) =>
        identity.dailyTarget === 0
          ? String(identity.dailySentCount)
          : `${String(identity.dailySentCount)} / ${String(identity.dailyTarget)}`,
    },
    {
      key: 'sessions',
      header: 'Browser sessions',
      numeric: true,
      // spec `roles_and_permissions.same_user_multiple_browsers`: concurrent use of
      // one identity warns. The database also refuses a second binding through
      // `browser_sessions_active_identity_key` (0010).
      cell: (identity) => (
        <Chip accent={identity.concurrentSessions ? 'amber' : 'neutral'} title={conflictTitle(identity)}>
          {identity.activeSessionCount}
        </Chip>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (identity) => <span className="nx-table__mono">{identity.createdAt?.slice(0, 10) ?? 'â€”'}</span>,
    },
  ];

  return (
    <>
      <PageHead subtitle="Sender accounts, who manages them, and which businesses each one may work.">
        Outreach Identities
      </PageHead>

      {conflicted.length > 0 && (
        <Alert accent="amber" role="alert">
          {conflicted.length === 1
            ? `${conflicted[0]?.displayName ?? 'One identity'} has more than one live browser session.`
            : `${String(conflicted.length)} identities have more than one live browser session.`}{' '}
          spec `roles_and_permissions.same_user_multiple_browsers` asks for exactly this to be surfaced.
        </Alert>
      )}

      <Grid cols={4}>
        <Stat value={identities.length} label="Identities visible to you" />
        <Stat
          value={identities.filter((identity) => identity.status === 'active').length}
          label="Active"
          meta={`${String(identities.filter((identity) => identity.status !== 'active').length)} paused or retired`}
        />
        <Stat
          value={identities.filter((identity) => identity.managedByUserId === null).length}
          label="Unassigned"
          meta="available for self-assignment"
        />
        <Stat
          value={identities.reduce((sum, identity) => sum + identity.businessCount, 0)}
          label="Business grants"
          meta="per-identity access rows"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Identities">
        <DataTable
          columns={columns}
          rows={identities}
          rowKey={(identity) => identity.id}
          caption="Outreach identities you may see, with manager, business access and browser sessions"
          empty={
            <span className="nx-hint">
              No sender identity is assigned to you. An administrator assigns identities from this screen.
            </span>
          }
        />
      </Card>

      {canCreate && (
        <>
          <div style={{ height: 'var(--nx-space-lg)' }} />

          <Card
            title="Add identity"
            actions={<Chip accent="indigo">admin only</Chip>}
            footer={
              <span className="nx-hint">
                Business access is granted on the identity&rsquo;s own screen, because Companion visibility is the
                intersection of the operator&rsquo;s grants and the identity&rsquo;s grants.
              </span>
            }
          >
            <CreateIdentityForm
              users={users.map((user) => ({ value: user.id, label: user.label }))}
              platforms={IDENTITY_PLATFORMS}
              statuses={IDENTITY_STATUSES}
            />
          </Card>
        </>
      )}

      <p className="nx-hint" style={{ marginTop: 'var(--nx-space-md)' }}>
        Open any identity to edit its targets, business access, browser sessions and transfer history.
      </p>
    </>
  );
}

function conflictTitle(identity: IdentityListRow): string {
  if (identity.concurrentSessions) {
    return 'More than one live browser session is using this identity.';
  }
  if (identity.activeSessionCount > 0) {
    return 'One live browser session is using this identity.';
  }
  return 'No browser session is currently bound to this identity.';
}
