/**
 * My Day / Companion Today presentation helpers.
 *
 * These are pure functions and types with NO database access, deliberately kept out
 * of `repo/today.ts` because that module is `server-only` and client components must
 * be able to import them. Splitting them here is what makes the queue's routing rules
 * shared between the server-rendered list and the client-side list, instead of
 * duplicated in both.
 *
 * spec `tasks_and_my_day.today_categories`.
 */

export const TODAY_CATEGORIES = [
  'connections',
  'accepted_message1',
  'followups',
  'overdue',
  'custom_tasks',
] as const;

export type TodayCategory = (typeof TODAY_CATEGORIES)[number];

export const TODAY_CATEGORY_LABELS: Readonly<Record<TodayCategory, string>> = {
  connections: 'Connections',
  accepted_message1: 'Accepted / Message 1',
  followups: 'Follow-ups',
  overdue: 'Overdue',
  custom_tasks: 'Tasks',
};

export type TodayBucket = 'today' | 'upcoming' | 'done';

export interface TodayItem {
  readonly leadId: string;
  readonly businessId: string;
  readonly personId: string;
  readonly personName: string;
  readonly companyName: string | null;
  readonly category: TodayCategory;
  readonly actionType: string | null;
  readonly dueAt: string | null;
  readonly isOverdue: boolean;
  readonly messageInstanceId: string | null;
  readonly sequenceStepId: string | null;
  readonly stepOrder: number | null;
  readonly stepKind: string | null;
  readonly leadState: string | null;
  readonly taskId: string | null;
  readonly priority: string | null;
  readonly senderIdentityId: string | null;
}

export function todayCounts(items: readonly TodayItem[]): Readonly<Record<TodayCategory, number>> {
  const counts: Record<TodayCategory, number> = {
    connections: 0,
    accepted_message1: 0,
    followups: 0,
    overdue: 0,
    custom_tasks: 0,
  };
  for (const item of items) counts[item.category] += 1;
  return counts;
}

/**
 * spec `tasks_and_my_day.today_action_rule`: "Opening an item should land on the
 * exact actionable step, not a long generic conversation page."
 *
 * Every list — My Day, the Companion Today tab, the Work Next button — resolves to
 * the same destination through this one function.
 */
export function focusHref(item: TodayItem): string {
  if (item.taskId !== null) return `/leads/${item.leadId}?task=${item.taskId}`;
  if (item.category === 'connections') return `/leads/${item.leadId}?focus=connection`;
  if (item.stepOrder !== null && item.stepOrder >= 2) {
    return `/leads/${item.leadId}?focus=followup&step=${String(item.stepOrder)}`;
  }
  if (item.category === 'accepted_message1') return `/leads/${item.leadId}?focus=message1`;
  if (item.category === 'overdue') return `/leads/${item.leadId}?focus=overdue`;
  return `/leads/${item.leadId}`;
}

/**
 * "Work Next": the item after the given one, wrapping to the first.
 *
 * Wrapping is deliberate — an operator working a queue should never be told there is
 * nothing to do while items remain.
 */
export function workNext(items: readonly TodayItem[], currentItemId: string | null): TodayItem | null {
  if (items.length === 0) return null;
  if (currentItemId === null) return items[0] ?? null;

  const index = items.findIndex((item) => item.leadId === currentItemId);
  if (index === -1) return items[0] ?? null;
  return items[index + 1] ?? items[0] ?? null;
}
