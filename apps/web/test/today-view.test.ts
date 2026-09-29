import { describe, expect, it } from 'vitest';

import { focusHref, workNext, type TodayItem } from '@/lib/today-view';

function item(overrides: Partial<TodayItem> = {}): TodayItem {
  return {
    leadId: '13000000-0000-4000-8000-000000000007',
    businessId: 'a0000000-0000-4000-8000-000000000001',
    businessSlug: 'zemnas',
    personId: 'person-1',
    personName: 'Lisa Weber',
    companyName: 'Frame House',
    category: 'connections',
    actionType: 'connect',
    dueAt: '2026-09-29T09:00:00.000Z',
    isOverdue: false,
    messageInstanceId: null,
    sequenceStepId: null,
    stepOrder: null,
    stepKind: null,
    leadState: 'active',
    taskId: null,
    priority: null,
    senderIdentityId: null,
    ...overrides,
  };
}

describe('My Day lead destinations', () => {
  it.each([
    ['connection', item()],
    ['task', item({ category: 'custom_tasks', taskId: 'task-1' })],
    ['follow-up', item({ category: 'followups', stepOrder: 3 })],
    ['message 1', item({ category: 'accepted_message1', stepOrder: 1 })],
    ['overdue', item({ category: 'overdue', isOverdue: true })],
  ])('returns the canonical business-scoped route for a %s row', (_label, queueItem) => {
    expect(focusHref(queueItem)).toBe(
      '/b/zemnas/leads/13000000-0000-4000-8000-000000000007',
    );
  });

  it('uses the queue-provided business key instead of guessing a viewer default', () => {
    expect(focusHref(item({ businessSlug: 'second-business', businessId: 'business-2' }))).toBe(
      '/b/second-business/leads/13000000-0000-4000-8000-000000000007',
    );
  });

  it('sends Work next to the canonical route of the selected queue item', () => {
    const first = item();
    const second = item({
      leadId: '13000000-0000-4000-8000-000000000008',
      businessId: 'business-2',
      businessSlug: 'second-business',
      personId: 'person-2',
    });

    expect(focusHref(workNext([first, second], first.leadId)!)).toBe(
      '/b/second-business/leads/13000000-0000-4000-8000-000000000008',
    );
  });
});
