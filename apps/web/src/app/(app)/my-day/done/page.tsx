import type { ReactNode } from 'react';

import { Card, Chip, DataTable, EmptyState, PageHead, type Column } from '@nexus/ui';

import { requireViewer } from '@/lib/current-viewer';
import { loadViewerContext } from '@/lib/viewer-context';
import { getRecentCompletions, type CompletionEntry } from '@/lib/repo/activity';
import { MyDayNav } from '@/components/my-day-nav';

export const dynamic = 'force-dynamic';

/**
 * U04 — My Day · Done.
 *
 * Contract: "Completed connections/messages/follow-ups/reply capture with
 * sender/business."
 *
 * spec `tasks_and_my_day.done`: "Completed items leave Today and appear in
 * Done/history immediately." This reads the same interaction and event records the
 * queue writes, so Done is never a separate bookkeeping system.
 */
export default async function DonePage(): Promise<ReactNode> {
  const viewer = await requireViewer();
  const context = await loadViewerContext();

  const entries = (
    await Promise.all(
      context.businesses.map((business) =>
        getRecentCompletions(context.viewer.actor, business.id, viewer.userId),
      ),
    )
  ).flat();

  const sorted = [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const columns: readonly Column<CompletionEntry>[] = [
    {
      key: 'when',
      header: 'When',
      width: '170px',
      cell: (entry) => <span className="nx-table__mono">{entry.at.slice(0, 16).replace('T', ' ')}</span>,
    },
    {
      key: 'what',
      header: 'Completed',
      cell: (entry) => <Chip accent="green">{entry.summary}</Chip>,
    },
    { key: 'person', header: 'Person', cell: (entry) => entry.personName ?? '—' },
    { key: 'business', header: 'Business', cell: (entry) => entry.businessName },
    {
      key: 'sender',
      header: 'Sender',
      // spec `reply_and_notes.history_rule` requires the sender identity to be visible.
      cell: (entry) => entry.identityName ?? <span className="nx-hint">—</span>,
    },
    {
      key: 'lead',
      header: '',
      cell: (entry) => (
        <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/leads/${entry.leadId}`}>
          Open
        </a>
      ),
    },
  ];

  return (
    <>
      <div className="nx-figma-my-day">
      <PageHead subtitle={context.businesses.length === 1 ? context.businesses[0]?.name.split(' ')[0] : 'All accessible businesses'}>
        My Day
      </PageHead>
      <MyDayNav active="done" showTask={false} />
      <div className="nx-day-subfilters"><Chip accent="green">TODAY {sorted.length}</Chip><Chip>THIS WEEK {sorted.length}</Chip></div>
      <Card className="nx-day-table nx-day-table--done">
        <DataTable
          columns={columns}
          rows={sorted.slice(0, 3)}
          rowKey={(entry) => entry.id}
          caption="Completed work"
          empty={
            <EmptyState
              title="Nothing completed yet"
              body="Connections, messages and replies you record appear here immediately."
            />
          }
        />
      </Card>
      </div>
    </>
  );
}
