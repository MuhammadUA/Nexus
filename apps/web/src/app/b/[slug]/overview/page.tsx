import type { ReactNode } from 'react';

import { Card, Chip, DataTable, Grid, LeadStatusChip, PageHead, Row, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { getOverview, type ActivityEntry, type LeadHealthBucket } from '@/lib/repo/insights';
import { getLeadCounts } from '@/lib/repo/leads';

export const dynamic = 'force-dynamic';

/**
 * A02 — Overview.
 *
 * Contract: "Cross-workspace operational snapshot for selected business: active
 * leads, follow-ups, replies, profile queue, team activity, lead health, recent
 * activity."
 *
 * Every number is read live from the operational tables, so a figure here can
 * always be traced to rows the operator can open.
 */
export default async function OverviewPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const [overview, counts] = await Promise.all([
    getOverview(context.viewer.actor, business.id),
    getLeadCounts(context.viewer.actor, business.id),
  ]);

  const activityColumns: readonly Column<ActivityEntry>[] = [
    {
      key: 'when',
      header: 'When',
      width: '180px',
      cell: (entry) => <span className="nx-table__mono">{formatWhen(entry.at)}</span>,
    },
    { key: 'action', header: 'Action', cell: (entry) => <Chip accent="indigo">{entry.action}</Chip> },
    { key: 'entity', header: 'Record', cell: (entry) => entry.entityType.replace(/_/g, ' ') },
    { key: 'actor', header: 'Actor', cell: (entry) => entry.actorType.replace(/_/g, ' ') },
  ];

  const healthColumns: readonly Column<LeadHealthBucket>[] = [
    { key: 'status', header: 'Lead status', cell: (bucket) => <LeadStatusChip state={bucket.status} /> },
    { key: 'count', header: 'Leads', numeric: true, cell: (bucket) => bucket.count },
  ];

  return (
    <>
      <PageHead
        subtitle={`Operational snapshot for ${business.name}${business.focus === null ? '' : ` · ${business.focus}`}`}
      >
        Overview
      </PageHead>

      <Grid cols={4}>
        <Stat value={overview.activeLeads} label="Active leads" meta={`${String(counts.total)} total`} />
        <Stat
          value={overview.dueToday}
          label="Due today"
          meta={overview.overdue > 0 ? `${String(overview.overdue)} overdue` : 'nothing overdue'}
        />
        <Stat value={overview.repliesRecorded} label="Replies recorded" meta={`${String(overview.dormant)} dormant`} />
        <Stat
          value={overview.profileQueuePending}
          label="Profile queue"
          meta={`${String(overview.needsProfile)} need a profile`}
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid cols={4}>
        <Stat value={overview.openTasks} label="Open tasks" />
        <Stat value={overview.duplicateCandidatesOpen} label="Duplicates to review" />
        <Stat value={overview.importsLast30Days} label="Imports (30 days)" />
        <Stat
          value={overview.suppressed}
          label="Do Not Contact"
          meta="suppressed across every sender"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid cols={2}>
        <Card title="Lead health" actions={<Chip accent="indigo">{business.name}</Chip>}>
          <DataTable
            columns={healthColumns}
            rows={overview.leadHealth}
            rowKey={(bucket) => bucket.status}
            caption="Leads by lifecycle status"
            empty={<span className="nx-hint">No leads yet.</span>}
          />
        </Card>

        <Card title="Sender identities" actions={<Chip>{overview.senders.length}</Chip>}>
          <DataTable
            columns={[
              { key: 'name', header: 'Identity', cell: (sender) => sender.displayName },
              {
                key: 'target',
                header: 'Sent today',
                numeric: true,
                cell: (sender) =>
                  sender.dailyTarget === null
                    ? String(sender.sentToday)
                    : `${String(sender.sentToday)} / ${String(sender.dailyTarget)}`,
              },
              {
                key: 'sessions',
                header: 'Browsers',
                numeric: true,
                // Concurrent browser use of one identity is a warning condition per
                // spec `roles_and_permissions.same_user_multiple_browsers`.
                cell: (sender) => (
                  <Chip accent={sender.activeSessions > 1 ? 'amber' : 'neutral'}>
                    {sender.activeSessions}
                  </Chip>
                ),
              },
              { key: 'status', header: 'Status', cell: (sender) => sender.status },
            ]}
            rows={overview.senders}
            rowKey={(sender) => sender.identityId}
            caption="Sender identities for this business"
            empty={<span className="nx-hint">No sender identities are bound to this business.</span>}
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="Recent activity"
        actions={
          <Row>
            <Chip accent="neutral">audit trail</Chip>
          </Row>
        }
      >
        <DataTable
          columns={activityColumns}
          rows={overview.recentActivity}
          rowKey={(entry) => entry.id}
          caption="Recent audited activity for this business"
          empty={<span className="nx-hint">No audited activity yet.</span>}
        />
      </Card>
    </>
  );
}

function formatWhen(value: string): string {
  if (value.length === 0) return '—';
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}
