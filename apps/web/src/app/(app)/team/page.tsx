import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Stat, type Column } from '@nexus/ui';

import { CreateUserForm } from '@/components/team-forms';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import { ACCESS_LEVELS, listBusinessOptions, listTeamUsers, type TeamUser } from '@/lib/repo/team';

/**
 * The `users.status` vocabulary is needed by the create form. It is declared here
 * rather than imported so this file's imports stay to what it renders with; the
 * action validates the same values with Zod.
 */
const STATUS_OPTIONS = ['active', 'invited', 'suspended', 'disabled'] as const;

export const dynamic = 'force-dynamic';

/**
 * A15 — Team & Accounts.
 *
 * Contract: "Users, roles, business access, lead access, managed LinkedIn
 * identities, daily counts/targets."
 *
 * spec `roles_and_permissions.admin.can`: "Create users and assign business
 * visibility." Both counts in the table are read live from the access and identity
 * tables rather than cached, so a figure here can always be traced to the rows the
 * operator sees on the user's own screen.
 */
export default async function TeamPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/team' });
  const [users, businesses] = await Promise.all([
    listTeamUsers(context.viewer.actor),
    listBusinessOptions(context.viewer.actor),
  ]);

  // Rendering is gated on the permission; the write itself is refused by RLS and
  // by `public.require_admin` regardless of what this screen shows.
  const canManage = context.permissions.has('user.manage');

  const grantAssignments = users.reduce((sum, user) => sum + user.businessCount, 0);
  const managedIdentities = users.reduce((sum, user) => sum + user.identityCount, 0);

  const columns: readonly Column<TeamUser>[] = [
    {
      key: 'user',
      header: 'User',
      cell: (user) => (
        <div className="nx-stack nx-stack--sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/team/${user.id}`}>
            <strong>{user.fullName ?? user.email}</strong>
          </a>
          {user.fullName !== null && <span className="nx-hint">{user.email}</span>}
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      cell: (user) => <Chip accent={user.role === 'admin' ? 'indigo' : 'neutral'}>{user.role}</Chip>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (user) => (
        <Chip accent={user.status === 'active' ? 'green' : user.status === 'disabled' ? 'red' : 'amber'}>
          {user.status}
        </Chip>
      ),
    },
    {
      key: 'businesses',
      header: 'Businesses',
      numeric: true,
      // A grant is the only way to see a business; a zero here means the user can
      // see nothing until an administrator grants one.
      cell: (user) => user.businessCount,
    },
    {
      key: 'identities',
      header: 'Identities',
      numeric: true,
      cell: (user) => user.identityCount,
    },
    {
      key: 'sessions',
      header: 'Browser sessions',
      numeric: true,
      cell: (user) => (
        <Chip accent={user.activeSessionCount > 1 ? 'amber' : 'neutral'}>{user.activeSessionCount}</Chip>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (user) => <span className="nx-table__mono">{user.createdAt?.slice(0, 10) ?? '—'}</span>,
    },
    {
      key: 'actions',
      header: '',
      cell: (user) => (
        <a className="nx-btn nx-btn--secondary nx-btn--sm" href={`/team/${user.id}`}>
          Permissions
        </a>
      ),
    },
  ];

  return (
    <>
      <PageHead subtitle="Who can sign in, what they may see, and which sender identities they hold.">
        Team &amp; Accounts
      </PageHead>

      {!canManage && (
        <Alert accent="amber" role="alert">
          You do not hold <code>user.manage</code>. Row-level security shows you your own profile row only, and every
          write on this screen is refused by the database.
        </Alert>
      )}

      <Grid cols={4}>
        <Stat value={users.length} label="Team members" meta={`${businesses.length} businesses`} />
        <Stat value={users.filter((user) => user.role === 'admin').length} label="Administrators" />
        <Stat value={grantAssignments} label="Business grants" meta="explicit grants only" />
        <Stat value={managedIdentities} label="Managed identities" meta="sender accounts" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="Users"
        actions={<Chip accent="cyan">invited until first sign-in</Chip>}
      >
        <DataTable
          columns={columns}
          rows={users}
          rowKey={(user) => user.id}
          caption="Users visible to you, with their business grants and managed sender identities"
          empty={<span className="nx-hint">No user profiles are visible to you.</span>}
        />
      </Card>

      {canManage && (
        <>
          <div style={{ height: 'var(--nx-space-lg)' }} />

          <Card
            title="Create user"
            actions={<Chip accent="indigo">admin only</Chip>}
            footer={
              <span className="nx-hint">
                The profile, its first business grant and the local password are written in one transaction, so a
                rejected password cannot leave a user who can never sign in.
              </span>
            }
          >
            <CreateUserForm
              businesses={businesses.map((business) => ({ value: business.id, label: business.name }))}
              accessLevels={ACCESS_LEVELS}
              statuses={STATUS_OPTIONS}
            />
          </Card>
        </>
      )}

      <p className="nx-hint" style={{ marginTop: 'var(--nx-space-md)' }}>
        Roles in use: admin · manager · user. Lead access is refined per business on each user&rsquo;s permissions
        screen.
      </p>
    </>
  );
}
