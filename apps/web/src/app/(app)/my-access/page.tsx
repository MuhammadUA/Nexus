import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Row, Stack, Stat, type Column } from '@nexus/ui';

import {
  BindIdentityBusinessForm,
  IdentityAssignForm,
  SelfGrantForm,
} from '@/components/my-access-forms';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  listIdentities,
  listIdentityTransfers,
  type IdentityRow,
  type IdentityTransferRow,
} from '@/lib/repo/admin-access';
import { listUserGrants, type UserBusinessGrantRow } from '@/lib/repo/businesses';

export const dynamic = 'force-dynamic';

/**
 * A29 — Admin · My Access & Assignment.
 *
 * Contract: "Admin can assign self allowed businesses/domains and available LinkedIn
 * identities; transfer requires confirmation/audit."
 *
 * The screen shows only the signed-in user's own rows. spec
 * `admin_self_assignment_and_domains.admin_self_assignment` allows an admin to grant
 * themselves access and to take an unassigned identity, but a takeover of somebody
 * else's identity is deliberately not a one-click action: it needs a confirmation and
 * produces an `identity_transfers` row plus an audit event.
 */
export default async function MyAccessPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/my-access' });
  const userId = context.viewer.userId;

  const [grants, visibleIdentities, transfers] = await Promise.all([
    userId === null ? Promise.resolve<readonly UserBusinessGrantRow[]>([]) : listUserGrants(context.viewer.actor, userId),
    listIdentities(context.viewer.actor),
    userId === null ? Promise.resolve<readonly IdentityTransferRow[]>([]) : listIdentityTransfers(context.viewer.actor, userId),
  ]);

  const myIdentities = visibleIdentities.filter((identity) => identity.managedByUserId === userId);
  const unassigned = visibleIdentities.filter((identity) => identity.managedByUserId === null);
  const assignedToOthers = visibleIdentities.filter(
    (identity) => identity.managedByUserId !== null && identity.managedByUserId !== userId,
  );

  // `identity.self_assign` is what the nav entry is gated on; RLS still refuses the
  // write for a non-admin, because `outreach_identities_update` only admits an admin
  // (or the identity's current manager).
  const canSelfAssign = context.permissions.has('identity.self_assign');
  const grantedIds = new Set(grants.map((grant) => grant.businessId));

  const grantColumns: readonly Column<UserBusinessGrantRow>[] = [
    { key: 'business', header: 'Business', cell: (grant) => grant.businessName },
    { key: 'level', header: 'Access level', cell: (grant) => <Chip accent="indigo">{grant.accessLevel}</Chip> },
    {
      key: 'capabilities',
      header: 'Capabilities',
      cell: (grant) => (
        <Row wrap>
          {grant.canManageLeads && <Chip accent="green">manage leads</Chip>}
          {grant.canUseLeadSources && <Chip accent="cyan">lead sources</Chip>}
          {grant.canUseProfileQueue && <Chip accent="cyan">profile queue</Chip>}
          {grant.canDeleteLeads && <Chip accent="amber">soft delete</Chip>}
          {!grant.canManageLeads &&
            !grant.canUseLeadSources &&
            !grant.canUseProfileQueue &&
            !grant.canDeleteLeads && <span className="nx-hint">read only</span>}
        </Row>
      ),
    },
    {
      key: 'scope',
      header: 'Lead scope',
      cell: (grant) =>
        grant.leadScope === null ? <span className="nx-hint">role default</span> : grant.leadScope,
    },
  ];

  const identityColumns: readonly Column<IdentityRow>[] = [
    {
      key: 'name',
      header: 'Identity',
      cell: (identity) => (
        <div className="nx-stack nx-stack--sm">
          <strong>{identity.displayName}</strong>
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
        <Chip accent={identity.status === 'active' ? 'green' : identity.status === 'paused' ? 'amber' : 'neutral'}>
          {identity.status}
        </Chip>
      ),
    },
    { key: 'target', header: 'Daily target', numeric: true, cell: (identity) => identity.dailyTarget },
    {
      key: 'businesses',
      header: 'Businesses bound',
      cell: (identity) =>
        identity.businessNames.length === 0 ? (
          <Chip accent="amber">none — unusable in the Companion</Chip>
        ) : (
          <Row wrap>
            {identity.businessNames.map((name) => (
              <Chip key={name} accent="cyan">
                {name}
              </Chip>
            ))}
          </Row>
        ),
    },
  ];

  const transferColumns: readonly Column<IdentityTransferRow>[] = [
    {
      key: 'when',
      header: 'When',
      cell: (transfer) => (
        <span className="nx-table__mono">{formatWhen(transfer.createdAt)}</span>
      ),
    },
    { key: 'identity', header: 'Identity', cell: (transfer) => transfer.identityName },
    {
      key: 'from',
      header: 'From',
      cell: (transfer) => (transfer.fromUserId === null ? <span className="nx-hint">unassigned</span> : shortId(transfer.fromUserId, userId)),
    },
    { key: 'to', header: 'To', cell: (transfer) => shortId(transfer.toUserId, userId) },
    {
      key: 'confirmed',
      header: 'Confirmed',
      cell: (transfer) => (
        <Chip accent={transfer.confirmed ? 'green' : 'amber'}>{transfer.confirmed ? 'confirmed' : 'not confirmed'}</Chip>
      ),
    },
    { key: 'note', header: 'Note', cell: (transfer) => transfer.note ?? '—' },
  ];

  return (
    <>
      <PageHead
        subtitle="Your own business grants and LinkedIn identities, with the transfer rules that protect other operators."
        actions={
          <Row wrap>
            <Chip accent="indigo">{grants.length} business grants</Chip>
            <Chip accent="cyan">{myIdentities.length} identities</Chip>
          </Row>
        }
      >
        My access &amp; assignment
      </PageHead>

      <Grid cols={4}>
        <Stat value={grants.length} label="Businesses I can see" />
        <Stat value={myIdentities.length} label="Identities assigned to me" />
        <Stat
          value={unassigned.length}
          label="Unassigned identities"
          meta={unassigned.length > 0 ? 'available to take' : 'none available'}
        />
        <Stat value={transfers.length} label="Transfers I am party to" meta="audited" />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card title="My business access" actions={<Chip accent="indigo">user_business_access</Chip>}>
        <DataTable
          columns={grantColumns}
          rows={grants}
          rowKey={(grant) => grant.businessId}
          caption="Your business access grants"
          empty={
            <span className="nx-hint">
              You hold no explicit grant yet. Visibility is never implied — grant yourself one below, or ask an
              administrator.
            </span>
          }
        />

        {canSelfAssign && context.businesses.length > 0 && (
          <div style={{ marginTop: 'var(--nx-space-lg)' }}>
            <Stack size="sm">
              <h3 className="nx-section-title">Grant myself a business</h3>
              <p className="nx-hint">
                spec `admin_self_assignment_and_domains.admin_self_assignment`: an admin may grant themselves
                business access. The write is admin-only in the database, so it is refused for anybody else.
              </p>
              <SelfGrantForm
                businesses={context.businesses.map((business) => ({
                  id: business.id,
                  name: business.name,
                  granted: grantedIds.has(business.id),
                }))}
              />
            </Stack>
          </div>
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="My LinkedIn identities"
        actions={<Chip accent="indigo">outreach_identities</Chip>}
      >
        <DataTable
          columns={identityColumns}
          rows={myIdentities}
          rowKey={(identity) => identity.id}
          caption="Outreach identities assigned to you"
          empty={
            <span className="nx-hint">
              No LinkedIn identity is assigned to you yet. Take an unassigned one below.
            </span>
          }
        />

        {myIdentities.length > 0 && (
          <Stack size="lg">
            {myIdentities.map((identity) => {
              const bound = new Set(identity.businessIds);
              const bindable = context.businesses.filter((business) => !bound.has(business.id));
              return (
                <div key={identity.id} className="nx-stack nx-stack--sm" style={{ marginTop: 'var(--nx-space-lg)' }}>
                  <h3 className="nx-section-title">{identity.displayName} · business access</h3>
                  <p className="nx-hint">
                    spec `extension_visibility_rule`: the Companion shows the intersection of your business access
                    and this identity&apos;s business access. An identity bound to nothing can never be used.
                  </p>
                  {bindable.length === 0 ? (
                    <span className="nx-hint">Every business you can see is already bound to this identity.</span>
                  ) : (
                    <BindIdentityBusinessForm
                      identityId={identity.id}
                      businesses={bindable.map((business) => ({ id: business.id, name: business.name }))}
                    />
                  )}
                </div>
              );
            })}
          </Stack>
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="Available identities"
        actions={<Chip accent={unassigned.length > 0 ? 'green' : 'neutral'}>{unassigned.length} unassigned</Chip>}
      >
        <Stack size="lg">
          {unassigned.length === 0 ? (
            <span className="nx-hint">
              No unassigned outreach identity is visible to you. An identity you cannot see belongs to another
              operator and is not listed here.
            </span>
          ) : (
            unassigned.map((identity) => (
              <Stack key={identity.id} size="sm">
                <Row between>
                  <Row wrap>
                    <strong>{identity.displayName}</strong>
                    <Chip accent="cyan">{identity.platform}</Chip>
                    <Chip accent={identity.status === 'active' ? 'green' : 'neutral'}>{identity.status}</Chip>
                  </Row>
                  <span className="nx-hint">unassigned</span>
                </Row>
                {canSelfAssign ? (
                  <IdentityAssignForm
                    identityId={identity.id}
                    displayName={identity.displayName}
                    currentManagerLabel={null}
                  />
                ) : (
                  <span className="nx-hint">
                    Self-assignment needs the <code>identity.self_assign</code> permission.
                  </span>
                )}
              </Stack>
            ))
          )}

          {assignedToOthers.length > 0 && (
            <>
              <Stack size="sm">
                <h3 className="nx-section-title">Managed by another operator</h3>
                <Alert accent="amber" title="These need an explicit transfer confirmation">
                  spec: if an identity is assigned to someone else, taking it over requires explicit transfer
                  confirmation and an audit event. Nothing here changes silently.
                </Alert>
              </Stack>
              {assignedToOthers.map((identity) => (
                <Stack key={identity.id} size="sm">
                  <Row between>
                    <Row wrap>
                      <strong>{identity.displayName}</strong>
                      <Chip accent="cyan">{identity.platform}</Chip>
                    </Row>
                    <span className="nx-hint">managed by {identity.managerLabel ?? 'another user'}</span>
                  </Row>
                  {canSelfAssign ? (
                    <IdentityAssignForm
                      identityId={identity.id}
                      displayName={identity.displayName}
                      currentManagerLabel={identity.managerLabel ?? 'another user'}
                    />
                  ) : (
                    <span className="nx-hint">
                      Transferring an identity needs the <code>identity.self_assign</code> permission.
                    </span>
                  )}
                </Stack>
              ))}
            </>
          )}
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Transfer history" actions={<Chip accent="neutral">audited</Chip>}>
        <DataTable
          columns={transferColumns}
          rows={transfers}
          rowKey={(transfer) => transfer.id}
          caption="Identity transfers you are party to"
          empty={<span className="nx-hint">No identity transfer has been recorded for you.</span>}
        />
      </Card>

      {!canSelfAssign && (
        <>
          <div style={{ height: 'var(--nx-space-lg)' }} />
          <Alert accent="amber" role="alert">
            This screen is read-only for you. Granting access and assigning identities need the{' '}
            <code>identity.self_assign</code> permission, and the database refuses the write regardless.
          </Alert>
        </>
      )}
    </>
  );
}

function formatWhen(value: string | null): string {
  if (value === null || value.length === 0) return '—';
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}

/** Shows user ids compactly; the actor's own id is labelled so the log stays readable. */
function shortId(id: string | null, selfId: string | null): ReactNode {
  if (id === null) return <span className="nx-hint">—</span>;
  if (selfId !== null && id === selfId) return <Chip accent="indigo">me</Chip>;
  return <span className="nx-table__mono">{id.slice(0, 8)}…</span>;
}
