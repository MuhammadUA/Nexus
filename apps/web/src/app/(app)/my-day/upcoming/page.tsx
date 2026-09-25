import type { ReactNode } from 'react';

import { Card, Chip, DataTable, EmptyState, PageHead, type Column } from '@nexus/ui';

import { requireViewer } from '@/lib/current-viewer';
import { loadViewerContext } from '@/lib/viewer-context';
import { getTodayQueue, focusHref } from '@/lib/repo/today';
import { DueChip, LeadStatusChip } from '@nexus/ui';
import { MyDayNav } from '@/components/my-day-nav';

export const dynamic = 'force-dynamic';

/**
 * U03 — My Day · Upcoming.
 *
 * Contract: "Upcoming sequence actions and custom tasks/reminders."
 *
 * Separate route rather than a tab so an operator can bookmark or share the forward
 * view; the query is identical apart from the bucket.
 */
export default async function UpcomingPage(): Promise<ReactNode> {
  const viewer = await requireViewer();
  const context = await loadViewerContext();

  const items = (
    await Promise.all(
      context.businesses.map((business) =>
        getTodayQueue(context.viewer.actor, viewer.userId, { businessId: business.id, bucket: 'upcoming' }),
      ),
    )
  ).flat();

  const sorted = [...items].sort((a, b) => {
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    return a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0;
  });

  const columns: readonly Column<(typeof sorted)[number]>[] = [
    { key: 'lead', header: 'Lead', cell: (item) => <strong>{item.personName}</strong> },
    { key: 'company', header: 'Company', cell: (item) => item.companyName ?? 'No company' },
    { key: 'action', header: 'Action', cell: (item) => <Chip accent="amber">{item.stepOrder !== null && item.stepOrder > 1 ? `Follow-up ${String(item.stepOrder - 1)}` : item.category.replace(/_/g, ' ')}</Chip> },
    { key: 'due', header: 'Due', cell: (item) => <DueChip dueAt={item.dueAt} overdue={item.isOverdue} /> },
    { key: 'status', header: 'Status', cell: (item) => <LeadStatusChip state={item.leadState ?? 'new'} /> },
    { key: 'open', header: '', cell: (item) => <a className="nx-btn nx-btn--ghost nx-btn--sm" href={focusHref(item)}>Open</a> },
  ];

  return (
    <>
      <PageHead subtitle={context.businesses.length === 1 ? context.businesses[0]?.name : 'All accessible businesses'}>My Day</PageHead>

      <MyDayNav active="upcoming" />

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title={`${String(sorted.length)} scheduled`} actions={<><Chip accent="cyan">Tomorrow</Chip><Chip>This week</Chip></>}>
        {sorted.length === 0 ? (
          <EmptyState
            title="Nothing scheduled ahead"
            body="Future follow-ups and reminders appear here as they approach their due date."
          />
        ) : (
          <DataTable columns={columns} rows={sorted} rowKey={(item) => `${item.leadId}:${item.taskId ?? item.messageInstanceId ?? 'item'}`} caption="Upcoming work" />
        )}
      </Card>
    </>
  );
}
