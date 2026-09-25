import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Stack, Stat, type Column } from '@nexus/ui';
import {
  ADMIN_ONLY_PERMISSIONS,
  defaultPermissionsForRole,
  effectivePermissions,
  type Permission,
  type UserBusinessGrant,
} from '@nexus/core';
import { notFound } from 'next/navigation';

import { GrantForm, ProfileEditForm, RevokeGrantButton, UserPasswordForm } from '@/components/team-forms';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import { listIcpOptions, type Option } from '@/lib/repo/leads';
import {
  ACCESS_LEVELS,
  LEAD_SCOPE_MODES,
  USER_ROLES,
  USER_STATUSES,
  getUser,
  listIdentitiesForUser,
  listUserGrants,
  listUserLeadScopes,
  type UserBusinessGrantRow,
  type UserLeadScope,
} from '@/lib/repo/team';

export const dynamic = 'force-dynamic';

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  all: 'All leads in the business',
  assigned: 'Only leads assigned to them',
  own: 'Only leads they created',
};

/** Which permission each `user_business_access` flag turns on or off. */
const MANAGED_LEAD_PERMISSIONS: readonly Permission[] = [
  'lead.update',
  'lead.assign_owner',
  'lead.change_primary_icp',
  'lead.change_sender_identity',
  'lead.archive',
];

interface BusinessGrantView {
  readonly grant: UserBusinessGrantRow;
  readonly scope: UserLeadScope | null;
  readonly effective: ReadonlySet<Permission>;
  readonly icps: readonly Option[];
}

/**
 * A16 — User Permissions.
 *
 * Contract: "Business visibility, lead scope, permitted actions, managed
 * identities."
 *
 * The screen shows three things side by side, and the distinction matters:
 *
 *   1. the **role default** from `@nexus/core` — read-only reference, because a role
 *      is a property of the account, not of one business;
 *   2. the **per-business grant** actually stored in `user_business_access` and
 *      `user_lead_scope` — the editable part;
 *   3. the **effective set**, which is the role default after those grants are
 *      applied and after `ADMIN_ONLY_PERMISSIONS` have been removed for a
 *      non-admin. That last step is why a mis-typed override can never escalate a
 *      normal user.
 */
export default async function UserPermissionsPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/team/:userId/permissions' });
  const user = await getUser(context.viewer.actor, id);
  // A user profile the viewer may not read is indistinguishable from one that does
  // not exist, which is exactly what RLS does to the row.
  if (user === null) notFound();

  const [grants, scopes, identities] = await Promise.all([
    listUserGrants(context.viewer.actor, id),
    listUserLeadScopes(context.viewer.actor, id),
    listIdentitiesForUser(context.viewer.actor, id),
  ]);

  const roleDefaults = defaultPermissionsForRole(user.role);
  const adminOnly = new Set<Permission>(ADMIN_ONLY_PERMISSIONS);
  const canManage = context.permissions.has('user.manage');

  // ICP lists are only needed for businesses that already have a grant, so they are
  // fetched per granted business rather than for every business in the workspace.
  const icpLists = await Promise.all(
    grants.map(async (grant) => ({
      businessId: grant.businessId,
      options: await listIcpOptions(context.viewer.actor, grant.businessId),
    })),
  );
  const icpsByBusiness = new Map(icpLists.map((entry) => [entry.businessId, entry.options]));

  const views: readonly BusinessGrantView[] = grants.map((grant) => {
    const scope = scopes.find((candidate) => candidate.businessId === grant.businessId) ?? null;
    return {
      grant,
      scope,
      effective: effectivePermissions(user.role, toCoreGrant(grant, scope), grant.businessId),
      icps: icpsByBusiness.get(grant.businessId) ?? [],
    };
  });

  const grantColumns: readonly Column<BusinessGrantView>[] = [
    {
      key: 'business',
      header: 'Business',
      cell: (view) => (
        <div className="nx-stack nx-stack--sm">
          <strong>{view.grant.businessName}</strong>
          <span className="nx-hint">access level: {view.grant.accessLevel}</span>
        </div>
      ),
    },
    {
      key: 'scope',
      header: 'Lead access',
      cell: (view) => (
        <div className="nx-stack nx-stack--sm">
          <Chip accent={view.scope === null ? 'neutral' : 'indigo'}>
            {view.scope?.mode ?? 'role default'}
          </Chip>
          <span className="nx-hint">
            {view.scope === null
              ? SCOPE_LABELS[view.grant.leadScope ?? ''] ?? 'No explicit scope recorded.'
              : SCOPE_LABELS[view.scope.mode] ?? view.scope.mode}
          </span>
          {view.scope !== null && view.scope.icpIds.length > 0 && (
            <span className="nx-hint">{view.scope.icpIds.length} ICPs allowed</span>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Permitted actions',
      cell: (view) => (
        <div className="nx-row nx-row--wrap">
          <Flag on={view.grant.canManageLeads} label="manage leads" />
          <Flag on={view.grant.canUseLeadSources} label="lead sources" />
          <Flag on={view.grant.canUseProfileQueue} label="profile queue" />
          <Flag on={view.grant.canDeleteLeads} label="delete leads" />
        </div>
      ),
    },
    {
      key: 'effective',
      header: 'Effective permissions',
      numeric: true,
      // The role default minus the grant's withdrawals minus the admin-only clamp.
      cell: (view) => (
        <span title={[...view.effective].sort().join(', ')}>
          {view.effective.size} / {roleDefaults.length}
        </span>
      ),
    },
    {
      key: 'edit',
      header: '',
      cell: (view) => (
        <details>
          <summary className="nx-hint">Edit access</summary>
          <div style={{ marginTop: 'var(--nx-space-sm)' }}>
            <GrantForm
              userId={id}
              businesses={[{ value: view.grant.businessId, label: view.grant.businessName }]}
              accessLevels={ACCESS_LEVELS}
              scopes={LEAD_SCOPE_MODES.map((mode) => ({ value: mode, label: mode }))}
              icps={view.icps.map((icp) => ({ value: icp.value, label: icp.label }))}
              current={{
                accessLevel: view.grant.accessLevel,
                leadScopeMode: view.scope?.mode ?? 'all',
                canManageLeads: view.grant.canManageLeads,
                canUseLeadSources: view.grant.canUseLeadSources,
                canUseProfileQueue: view.grant.canUseProfileQueue,
                canDeleteLeads: view.grant.canDeleteLeads,
                icpIds: view.scope?.icpIds ?? [],
              }}
            />
          </div>
        </details>
      ),
    },
    {
      key: 'revoke',
      header: '',
      cell: (view) =>
        canManage ? (
          <RevokeGrantButton
            userId={id}
            businessId={view.grant.businessId}
            businessName={view.grant.businessName}
          />
        ) : null,
    },
  ];

  const identityColumns: readonly Column<(typeof identities)[number]>[] = [
    {
      key: 'name',
      header: 'Identity',
      cell: (identity) => (
        <a className="nx-nav__item" style={{ padding: 0 }} href={`/identities/${identity.id}`}>
          {identity.displayName}
        </a>
      ),
    },
    { key: 'platform', header: 'Platform', cell: (identity) => identity.platform },
    {
      key: 'status',
      header: 'Status',
      cell: (identity) => (
        <Chip accent={identity.status === 'active' ? 'green' : identity.status === 'paused' ? 'amber' : 'neutral'}>
          {identity.status}
        </Chip>
      ),
    },
    {
      key: 'target',
      header: 'Sent today',
      numeric: true,
      cell: (identity) => `${String(identity.dailySentCount)} / ${String(identity.dailyTarget)}`,
    },
  ];

  return (
    <>
      <PageHead
        subtitle={
          <>
            {user.email}
            {user.fullName === null ? '' : ' · '}
            {user.fullName ?? ''}
          </>
        }
        actions={
          <>
            <Chip accent={user.role === 'admin' ? 'indigo' : 'neutral'}>{user.role}</Chip>
            <Chip accent={user.status === 'active' ? 'green' : 'amber'}>{user.status}</Chip>
          </>
        }
      >
        User Permissions
      </PageHead>

      <Grid cols={4}>
        <Stat value={grants.length} label="Business grants" meta="visibility is explicit" />
        <Stat value={roleDefaults.length} label="Role defaults" meta={`from the ${user.role} role`} />
        <Stat value={adminOnly.size} label="Admin-only" meta="never granted to a non-admin" />
        <Stat value={identities.length} label="Managed identities" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid split>
        <Stack size="lg">
          <Card
            title="Business access"
            actions={<Chip accent="indigo">{grants.length} granted</Chip>}
            footer={
              <span className="nx-hint">
                Revoking a grant also removes the matching lead scope, so an old restriction can never silently
                re-apply if the grant is recreated later.
              </span>
            }
          >
            <DataTable
              columns={grantColumns}
              rows={views}
              rowKey={(view) => view.grant.businessId}
              caption="Business grants for this user, with lead scope and permitted actions"
              empty={
                <span className="nx-hint">
                  {user.fullName ?? user.email} has no business grant, so no business is visible to them.
                </span>
              }
            />
          </Card>

          <Card title="Lead scope rules">
            <Stack size="sm">
              {LEAD_SCOPE_MODES.map((mode) => (
                <div key={mode} className="nx-row nx-row--between">
                  <Chip accent="indigo">{mode}</Chip>
                  <span>{SCOPE_LABELS[mode]}</span>
                </div>
              ))}
              <p className="nx-hint">
                A scope with no ICP selected covers every ICP in the business. Selecting ICPs narrows visibility
                further; it never widens it.
              </p>
            </Stack>
          </Card>

          {canManage && (
            <>
              <Card title="Profile">
                <ProfileEditForm
                  userId={user.id}
                  roles={USER_ROLES}
                  statuses={USER_STATUSES}
                  current={{
                    fullName: user.fullName ?? '',
                    role: user.role,
                    status: user.status,
                    timezone: user.timezone,
                  }}
                />
              </Card>

              <Card title="Local password" actions={<Chip accent="amber">local credential path</Chip>}>
                <Stack size="sm">
                  <p className="nx-hint">
                    Supabase Auth is the production provider. This sets the local development credential through
                    <code> public.set_user_credential</code>, which is admin-gated and audited.
                  </p>
                  <UserPasswordForm userId={user.id} />
                </Stack>
              </Card>
            </>
          )}
        </Stack>

        <Stack size="lg">
          <Card
            title={`Role defaults — ${user.role}`}
            actions={<Chip accent="neutral">read-only reference</Chip>}
          >
            <Stack size="sm">
              <div className="nx-row nx-row--wrap">
                {roleDefaults.map((permission) => (
                  <Chip key={permission} accent={adminOnly.has(permission) ? 'amber' : 'neutral'}>
                    {permission}
                  </Chip>
                ))}
              </div>
              <p className="nx-hint">
                These come from <code>@nexus/core</code> for the account&rsquo;s role and cannot be edited here. The
                per-business grants above are applied on top.
              </p>
            </Stack>
          </Card>

          <Card title="Admin-only permissions" actions={<Chip accent="red">never granted</Chip>}>
            <Alert accent="amber" role="alert">
              These permissions are held by administrators only. They can never be granted to a {user.role === 'admin' ? 'non-admin user' : `${user.role} account`},
              whatever the per-business overrides say.
            </Alert>
            <div className="nx-row nx-row--wrap" style={{ marginTop: 'var(--nx-space-sm)' }}>
              {ADMIN_ONLY_PERMISSIONS.map((permission) => (
                <Chip key={permission} accent="red">
                  {permission}
                </Chip>
              ))}
            </div>
          </Card>

          <Card title="Managed identities" actions={<Chip>{identities.length}</Chip>}>
            <DataTable
              columns={identityColumns}
              rows={identities}
              rowKey={(identity) => identity.id}
              caption="Outreach identities assigned to this user"
              empty={
                <span className="nx-hint">
                  No sender identity is assigned, so this account cannot perform outreach.
                </span>
              }
            />
          </Card>
        </Stack>
      </Grid>
    </>
  );
}

/**
 * Projects a stored grant into the shape `@nexus/core` reasons about.
 *
 * The `user_business_access` flags map onto *withdrawals* from the role default: a
 * `false` flag removes the permissions it governs. Nothing here grants extra
 * permissions, because the spec makes per-business access a narrowing of the role
 * rather than a second grant channel.
 */
function toCoreGrant(grant: UserBusinessGrantRow, scope: UserLeadScope | null): UserBusinessGrant {
  const revoked: Permission[] = [];
  if (!grant.canManageLeads) revoked.push(...MANAGED_LEAD_PERMISSIONS);
  if (!grant.canUseLeadSources) revoked.push('lead_source.use');
  if (!grant.canUseProfileQueue) revoked.push('profile_queue.use');
  if (!grant.canDeleteLeads) revoked.push('lead.soft_delete');

  return {
    businessId: grant.businessId,
    // Matches the `user_business_access.access_level` CHECK: admin | manager | user.
    accessLevel: grant.accessLevel,
    canManageLeads: grant.canManageLeads,
    canUseLeadSources: grant.canUseLeadSources,
    canUseProfileQueue: grant.canUseProfileQueue,
    canDeleteLeads: grant.canDeleteLeads,
    ...(revoked.length === 0 ? {} : { revokedPermissions: revoked }),
    ...(scope === null ? {} : { leadScope: scope.mode, icpIds: scope.icpIds }),
  };
}

/** A toggle rendered as a labelled chip: status is never colour alone. */
function Flag({ on, label }: { readonly on: boolean; readonly label: string }): ReactNode {
  return <Chip accent={on ? 'green' : 'neutral'}>{on ? label : `no ${label}`}</Chip>;
}
