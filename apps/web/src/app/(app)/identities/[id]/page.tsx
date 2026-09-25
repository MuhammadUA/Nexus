import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  PageHead,
  Stack,
  Stat,
  Timeline,
  TimelineItem,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import {
  GrantBusinessForm,
  IdentityEditForm,
  IdentityTransferForm,
  RevokeBusinessButton,
} from '@/components/identity-forms';
import { loadViewerContext } from '@/lib/viewer-context';
import { STALE_SESSION_MINUTES, evaluateSessionConflict } from '@/lib/identity-concurrency';
import { listBusinessOptions } from '@/lib/repo/team';
import {
  IDENTITY_PLATFORMS,
  IDENTITY_STATUSES,
  getIdentity,
  listAssignableUsers,
  listBrowserSessions,
  listIdentityBusinessAccess,
  listIdentityTransfers,
  type BrowserSessionRow,
  type IdentityBusinessAccess,
  type IdentityTransferRow,
} from '@/lib/repo/identities';

export const dynamic = 'force-dynamic';

/**
 * A17 — Outreach Identity Detail.
 *
 * Contract: "Manager, business access, targets, browser sessions, conversation
 * ownership, transfer behavior."
 *
 * spec `identity_model.outreach_identity.rule`: "CRM lead owner, actual sender
 * identity, and business are separate dimensions and may differ." The screen
 * therefore keeps the three apart — the manager is not the lead owner, and the
 * identity's business access is its own grant, not the manager's.
 */
export default async function IdentityDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  const context = await loadViewerContext();
  const identity = await getIdentity(context.viewer.actor, id);
  // An identity outside the viewer's scope is invisible through RLS, so it reads as
  // missing. Rendering "not found" rather than "forbidden" avoids confirming that
  // someone else's identity exists.
  if (identity === null) notFound();

  const [access, sessions, transfers, allBusinesses, users] = await Promise.all([
    listIdentityBusinessAccess(context.viewer.actor, id),
    listBrowserSessions(context.viewer.actor, id),
    listIdentityTransfers(context.viewer.actor, id),
    listBusinessOptions(context.viewer.actor),
    listAssignableUsers(context.viewer.actor),
  ]);

  /*
   * spec `roles_and_permissions.same_user_multiple_browsers`: "Concurrent use of the
   * same outreach identity in multiple active browser sessions should warn and can be
   * blocked by setting." The rule itself is `evaluateIdentityConcurrency` in
   * `@nexus/core`; nothing here re-implements it.
   */
  const conflict = evaluateSessionConflict(
    sessions.map((session) => ({
      id: session.id,
      userId: session.userId,
      installId: session.installId,
      status: session.status,
      lastActiveAt: session.lastActiveAt,
    })),
    { blockConcurrentIdentityUse: false, staleAfterMinutes: STALE_SESSION_MINUTES },
  );
  const conflicting = new Set(conflict.conflictingSessionIds);

  const grantedIds = new Set(access.map((row) => row.businessId));
  const grantable = allBusinesses.filter((business) => !grantedIds.has(business.id));

  const canManage = context.permissions.has('identity.manage');
  const remaining = Math.max(identity.dailyTarget - identity.dailySentCount, 0);

  const accessColumns: readonly Column<IdentityBusinessAccess>[] = [
    {
      key: 'business',
      header: 'Business',
      cell: (row) => (
        <a className="nx-nav__item" style={{ padding: 0 }} href={`/b/${row.businessKey}/overview`}>
          {row.businessName}
        </a>
      ),
    },
    {
      key: 'granted',
      header: 'Granted',
      cell: (row) => <span className="nx-table__mono">{row.createdAt?.slice(0, 10) ?? '—'}</span>,
    },
    {
      key: 'revoke',
      header: '',
      cell: (row) =>
        canManage ? (
          <RevokeBusinessButton identityId={identity.id} businessId={row.businessId} businessName={row.businessName} />
        ) : null,
    },
  ];

  const sessionColumns: readonly Column<BrowserSessionRow>[] = [
    {
      key: 'state',
      header: 'Session',
      cell: (session) => (
        <Stack size="sm">
          <Chip
            accent={
              conflicting.has(session.id)
                ? 'amber'
                : session.status === 'active'
                  ? 'green'
                  : session.status === 'revoked'
                    ? 'red'
                    : 'neutral'
            }
          >
            {conflicting.has(session.id) ? 'conflicting' : session.status}
          </Chip>
          <span className="nx-hint nx-table__mono">{session.installId}</span>
        </Stack>
      ),
    },
    { key: 'user', header: 'Operator', cell: (session) => session.userLabel },
    {
      key: 'business',
      header: 'Default business',
      cell: (session) => session.defaultBusinessName ?? <span className="nx-hint">none</span>,
    },
    {
      key: 'last',
      header: 'Last active',
      cell: (session) => (
        <span className="nx-table__mono">{session.lastActiveAt?.slice(0, 16).replace('T', ' ') ?? '—'}</span>
      ),
    },
    {
      key: 'created',
      header: 'Bound',
      cell: (session) => <span className="nx-table__mono">{session.createdAt?.slice(0, 10) ?? '—'}</span>,
    },
  ];

  return (
    <>
      <PageHead
        subtitle={
          <>
            {identity.platform}
            {identity.profileUrl === null ? '' : ' · '}
            {identity.profileUrl ?? ''}
          </>
        }
        actions={
          <>
            <Chip
              accent={identity.status === 'active' ? 'green' : identity.status === 'paused' ? 'amber' : 'neutral'}
            >
              {identity.status}
            </Chip>
            {identity.managerName === null ? (
              <Chip accent="cyan">unassigned</Chip>
            ) : (
              <Chip accent="indigo">managed by {identity.managerName}</Chip>
            )}
            {identity.profileUrl !== null && (
              <a
                className="nx-btn nx-btn--secondary"
                href={identity.profileUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open profile
              </a>
            )}
          </>
        }
      >
        {identity.displayName}
      </PageHead>

      {conflict.action !== 'allow' && (
        <Alert accent="amber" role="alert" title="Concurrent browser sessions">
          {conflict.reason}. {String(conflict.conflictingSessionIds.length)} of the sessions below are bound to this
          identity at the same time. spec `roles_and_permissions.same_user_multiple_browsers` requires this to warn.
        </Alert>
      )}

      <Grid cols={4}>
        <Stat
          value={identity.dailyTarget === 0 ? identity.dailySentCount : `${String(identity.dailySentCount)} / ${String(identity.dailyTarget)}`}
          label="Sent today"
          meta={identity.dailyTarget === 0 ? 'no target set' : `${String(remaining)} remaining`}
        />
        <Stat value={access.length} label="Business access" meta="per-identity grants" />
        <Stat
          value={sessions.filter((session) => session.status === 'active').length}
          label="Live browser sessions"
          meta={`${String(sessions.length)} total`}
        />
        <Stat value={transfers.length} label="Transfers recorded" meta="explicit and audited" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid split>
        <Stack size="lg">
          {canManage ? (
            <Card
              title="Identity"
              actions={<Chip accent="indigo">{identity.platform}</Chip>}
              footer={
                <span className="nx-hint">
                  The manager is edited below, because handing an identity to someone else is a confirmed, audited
                  transfer rather than an ordinary field edit.
                </span>
              }
            >
              <IdentityEditForm
                identityId={identity.id}
                platforms={IDENTITY_PLATFORMS}
                statuses={IDENTITY_STATUSES}
                current={{
                  displayName: identity.displayName,
                  platform: identity.platform,
                  status: identity.status,
                  dailyTarget: identity.dailyTarget,
                  profileUrl: identity.profileUrl ?? '',
                  notes: identity.notes ?? '',
                }}
              />
            </Card>
          ) : (
            <Card title="Identity">
              <span className="nx-hint">
                You do not hold <code>identity.manage</code>, so this identity is read-only for you.
              </span>
            </Card>
          )}

          <Card
            title="Business access"
            actions={<Chip accent="indigo">{access.length} granted</Chip>}
            footer={
              <span className="nx-hint">
                spec `extension_visibility_rule`: the businesses visible in the Companion are the operator&rsquo;s
                grants intersected with this list — never their union.
              </span>
            }
          >
            <Stack>
              <DataTable
                columns={accessColumns}
                rows={access}
                rowKey={(row) => row.businessId}
                caption="Businesses this sender identity may work"
                empty={
                  <EmptyState
                    title="No business access"
                    body="No business is granted to this identity, so it can send nothing anywhere."
                  />
                }
              />
              {canManage && (
                <GrantBusinessForm
                  identityId={identity.id}
                  businesses={grantable.map((business) => ({ value: business.id, label: business.name }))}
                />
              )}
            </Stack>
          </Card>

          <Card
            title="Browser sessions"
            actions={
              <Chip accent={conflict.action === 'allow' ? 'neutral' : 'amber'}>
                {conflict.action === 'allow' ? 'no conflict' : 'concurrent use'}
              </Chip>
            }
            footer={
              <span className="nx-hint">
                spec `identity_model.browser_session.rule`: binding a browser does not change canonical lead ownership.
              </span>
            }
          >
            <DataTable
              columns={sessionColumns}
              rows={sessions}
              rowKey={(session) => session.id}
              caption="Browser sessions bound to this identity"
              empty={
                <span className="nx-hint">No browser profile has bound this identity yet.</span>
              }
            />
          </Card>

          <Card title="Transfer history" actions={<Chip>{transfers.length}</Chip>}>
            {transfers.length === 0 ? (
              <EmptyState
                title="No transfers"
                body="This identity has never changed hands. A transfer is only recorded when an identity assigned to one user is taken over by another, with explicit confirmation."
              />
            ) : (
              <Timeline label="Identity transfer history">
                {transfers.map((transfer) => (
                  <TimelineItem key={transfer.id} dot={transfer.confirmed ? 'system' : 'danger'} meta={transferMeta(transfer)}>
                    {transferBody(transfer)}
                  </TimelineItem>
                ))}
              </Timeline>
            )}
          </Card>
        </Stack>

        <Stack size="lg">
          <Card title="Manager & transfer" actions={<Chip accent="amber">explicit confirmation</Chip>}>
            <Stack size="sm">
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Current manager</span>
                <span>{identity.managerName ?? 'Unassigned'}</span>
              </div>
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Identity owner is separate from lead owner</span>
                <span className="nx-hint">spec identity_model</span>
              </div>
              {canManage ? (
                <IdentityTransferForm
                  identityId={identity.id}
                  users={users.map((user) => ({ value: user.id, label: user.label }))}
                  currentManagerId={identity.managedByUserId}
                  currentManagerName={identity.managerName}
                />
              ) : (
                <span className="nx-hint">
                  Only an identity manager or an administrator may change this identity.
                </span>
              )}
            </Stack>
          </Card>

          <Card title="Conversation ownership">
            <Stack size="sm">
              <p className="nx-hint">
                spec `identity_model.conversation_ownership`: the first sender identity to touch a channel becomes its
                default conversation sender. A lead&rsquo;s recorded sender stays visible even when a different identity
                is selected, which is what triggers the duplicate-outreach warning on the lead screen.
              </p>
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Bound browser profiles</span>
                <Chip accent={sessions.some((session) => session.status === 'active') ? 'green' : 'neutral'}>
                  {sessions.filter((session) => session.status === 'active').length} live
                </Chip>
              </div>
            </Stack>
          </Card>

          <Card title="Daily count">
            <Stack size="sm">
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Sent today</span>
                <span>{identity.dailySentCount}</span>
              </div>
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Daily target</span>
                <span>{identity.dailyTarget}</span>
              </div>
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Counter last reset</span>
                <span className="nx-table__mono">
                  {identity.dailyCountResetAt?.slice(0, 16).replace('T', ' ') ?? 'never'}
                </span>
              </div>
              <p className="nx-hint">
                The counter is reset by the send path when it crosses midnight, so this figure is the live value for
                today.
              </p>
            </Stack>
          </Card>

          <Card title="Record">
            <Stack size="sm">
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Created</span>
                <span className="nx-table__mono">{identity.createdAt?.slice(0, 10) ?? '—'}</span>
              </div>
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Last updated</span>
                <span className="nx-table__mono">
                  {identity.updatedAt?.slice(0, 16).replace('T', ' ') ?? '—'}
                </span>
              </div>
              <div className="nx-row nx-row--between">
                <span className="nx-hint">Browser profile</span>
                <span className="nx-table__mono">{identity.optionalBrowserProfileId ?? '—'}</span>
              </div>
              {identity.normalizedProfileUrl !== null && (
                <div className="nx-row nx-row--between">
                  <span className="nx-hint">Normalized URL</span>
                  <span className="nx-table__mono">{identity.normalizedProfileUrl}</span>
                </div>
              )}
              {identity.notes !== null && <p>{identity.notes}</p>}
            </Stack>
          </Card>
        </Stack>
      </Grid>
    </>
  );
}

function transferMeta(transfer: IdentityTransferRow): ReactNode {
  return (
    <Stack size="sm">
      <span className="nx-table__mono">{transfer.createdAt?.slice(0, 16).replace('T', ' ') ?? '—'}</span>
      <div className="nx-row nx-row--wrap">
        <Chip accent={transfer.confirmed ? 'green' : 'red'}>
          {transfer.confirmed ? 'confirmed' : 'not confirmed'}
        </Chip>
        {transfer.actorName !== null && <span className="nx-hint">by {transfer.actorName}</span>}
      </div>
    </Stack>
  );
}

function transferBody(transfer: IdentityTransferRow): ReactNode {
  return (
    <span>
      {transfer.fromUserName ?? 'Unassigned'} → {transfer.toUserName ?? 'Unassigned'}
      {transfer.note === null ? '' : ` — ${transfer.note}`}
    </span>
  );
}
