import type { ReactNode } from 'react';

import { Card, Chip, DataTable, Grid, PageHead, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { getOverview, type ActivityEntry } from '@/lib/repo/insights';

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

  const overview = await getOverview(context.viewer.actor, business.id);

  const activityColumns: readonly Column<ActivityEntry>[] = [
    {
      key: 'when',
      header: 'Time',
      width: '110px',
      cell: (entry) => <span className="nx-table__mono">{formatWhen(entry.at)}</span>,
    },
    { key: 'action', header: 'Event', cell: (entry) => entry.action.replace(/_/g, ' ') },
    { key: 'actor', header: 'Actor', cell: (entry) => entry.actorType.replace(/_/g, ' ') },
    { key: 'entity', header: 'Lead / detail', cell: (entry) => entry.entityType.replace(/_/g, ' ') },
  ];

  return (
    <>
      <PageHead
        subtitle={`${business.name.split(' ')[0] ?? business.name} · admin roll-up`}
      >
        Overview
      </PageHead>

      <div className="nx-overview-stats">
        <Stat value={overview.activeLeads} label="Active leads" />
        <Stat value={overview.dueToday} label="Follow-ups due" />
        <Stat value={overview.repliesRecorded} label="Replies today" />
        <Stat value={overview.profileQueuePending} label="Needs profile" />
      </div>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <div className="nx-overview-panels"><Grid cols={2}>
        <Card title="Team activity">
          <DataTable
            columns={[
              { key: 'user', header: 'User', cell: (sender) => sender.displayName },
              { key: 'connect', header: 'Connect', numeric: true, cell: (sender) => sender.sentToday },
              { key: 'msg', header: 'Msg', numeric: true, cell: (sender) => sender.activeSessions },
              { key: 'fu', header: 'FU', numeric: true, cell: (sender) => sender.dailyTarget ?? 0 },
            ]}
            rows={overview.senders.slice(0, 3)}
            rowKey={(sender) => sender.identityId}
            caption="Team activity"
            empty={<span className="nx-hint">No activity yet.</span>}
          />
        </Card>

        <Card title="Lead health">
          <div className="nx-lead-health-chips">
            <Chip>DORMANT {overview.dormant}</Chip>
            <Chip accent="red">DNC {overview.suppressed}</Chip>
            <Chip accent="amber">DUPLICATES {overview.duplicateCandidatesOpen}</Chip>
            <Chip accent="amber">OVERDUE {overview.overdue}</Chip>
          </div>
          <div className="nx-lead-health-row"><span>Profile queue</span><strong>{overview.profileQueuePending}</strong></div>
          <div className="nx-lead-health-row"><span>Reactivation due</span><strong>{overview.dormant}</strong></div>
        </Card>
      </Grid></div>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="Recent activity"
      >
        <DataTable
          columns={activityColumns}
          rows={overview.recentActivity.slice(0, 3)}
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
