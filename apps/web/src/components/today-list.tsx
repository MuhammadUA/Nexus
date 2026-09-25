'use client';

import { useMemo, useState, type ReactElement } from 'react';

import { Button, EmptyState } from '@nexus/ui';
import { useRouter } from 'next/navigation';

import { focusHref, workNext, type TodayItem } from '@/lib/today-view';

/**
 * The Today queue.
 *
 * spec `tasks_and_my_day`:
 *   - "Opening an item should land on the exact actionable step, not a long generic
 *     conversation page."
 *   - "Completed items leave Today and appear in Done/history immediately."
 *   - "Work Next" keeps the operator moving without returning to the list.
 *
 * The filters are links (not local state) so the view is shareable and restorable,
 * matching the Companion's list-state requirement.
 */
export function TodayList({
  items,
  upcoming = false,
}: {
  readonly items: readonly TodayItem[];
  readonly businesses: readonly { readonly id: string; readonly name: string }[];
  readonly selectedBusinessId: string;
  readonly selectedCategory: string;
  readonly categories: readonly { readonly value: string; readonly label: string; readonly count: number }[];
  readonly upcoming?: boolean;
}): ReactElement {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => items.find((item) => item.leadId === selectedId) ?? null,
    [items, selectedId],
  );

  if (items.length === 0) {
    return (
      <EmptyState
        title={upcoming ? 'Nothing scheduled ahead' : 'Nothing due today'}
        body={
          upcoming
            ? 'Future sequence steps and reminders appear here as they approach.'
            : 'When a connection, message or follow-up becomes due it appears here.'
        }
      />
    );
  }

  return (
    <div className="nx-figma-queue">
      <div className="nx-table-wrap">
        <table className="nx-table nx-work-table">
          <caption className="nx-visually-hidden">Today work queue</caption>
          <thead>
            <tr>
              <th scope="col">Lead</th>
              <th scope="col">Company</th>
              <th scope="col">Action</th>
              <th scope="col">Due</th>
              <th scope="col">LinkedIn</th>
              <th scope="col"><span className="nx-visually-hidden">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 4).map((item) => (
              <tr
                key={`${item.leadId}:${item.taskId ?? item.messageInstanceId ?? 'lead'}`}
                aria-selected={item.leadId === selectedId ? true : undefined}
              >
                <td>
                  <strong>{item.personName}</strong>
                </td>
                <td>{item.companyName ?? 'No company'}</td>
                <td>{item.stepOrder !== null && item.stepOrder > 0
                  ? item.stepOrder <= 1 ? 'Message 1' : `Follow-up ${String(item.stepOrder - 1)}`
                  : item.category === 'connections' ? 'Connection' : item.category.replace(/_/g, ' ')}</td>
                <td>{item.isOverdue ? 'Overdue' : item.dueAt === null ? 'Now' : 'Today'}</td>
                <td>{item.senderIdentityId === null ? <span className="nx-hint">Unassigned</span> : 'Assigned'}</td>
                <td>
                  <button
                    type="button"
                    className="nx-btn nx-btn--ghost nx-btn--sm"
                    onClick={() => {
                      setSelectedId(item.leadId);
                      router.push(focusHref(item));
                    }}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!upcoming && (
        <div className="nx-figma-queue__footer">
          {selected !== null && <span className="nx-hint">Next: {selected.personName}</span>}
          <Button
            variant="primary"
            onClick={() => {
              const next = workNext(items, selectedId);
              if (next !== null) {
                setSelectedId(next.leadId);
                router.push(focusHref(next));
              }
            }}
          >
            Work next
          </Button>
        </div>
      )}
    </div>
  );
}
