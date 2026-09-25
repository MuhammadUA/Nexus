import type { ReactNode } from 'react';

import { Card, Chip, Grid, PageHead, Stat } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { getTodayQueue, todayCounts, TODAY_CATEGORIES, TODAY_CATEGORY_LABELS, type TodayCategory } from '@/lib/repo/today';
import { TodayList } from '@/components/today-list';
import { MyDayNav } from '@/components/my-day-nav';
import { requireViewer } from '@/lib/current-viewer';
export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly business?: string;
  readonly category?: string;
}

/**
 * U02 — My Day · Today.
 *
 * Contract: "Connections, Message 1, follow-ups, overdue; work-next behavior."
 *
 * spec `product_intent`: "Operators should work from My Day -> exact action ->
 * LinkedIn -> mark/capture result -> next." Each row therefore links to the exact
 * actionable step, not to a generic lead page.
 */
export default async function MyDayPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const viewer = await requireViewer();
  const context = await loadViewerContext();

  // Without a business in the URL, My Day rolls up every business the operator can
  // see, which is what makes it a single daily queue rather than a per-business one.
  const businessId =
    query.business !== undefined && context.businesses.some((b) => b.id === query.business)
      ? query.business
      : null;

  const categories: readonly TodayCategory[] | undefined =
    query.category !== undefined && (TODAY_CATEGORIES as readonly string[]).includes(query.category)
      ? [query.category as TodayCategory]
      : undefined;

  const todayItems = businessId === null
    ? (
        await Promise.all(
          context.businesses.map((business) =>
            getTodayQueue(context.viewer.actor, viewer.userId, { businessId: business.id, bucket: 'today' }),
          ),
        )
      ).flat()
    : await getTodayQueue(context.viewer.actor, viewer.userId, {
        businessId,
        bucket: 'today',
        ...(categories === undefined ? {} : { categories }),
      });

  const counts = todayCounts(todayItems);
  const overdue = todayItems.filter((item) => item.isOverdue).length;

  return (
    <>
      <PageHead
        subtitle={context.businesses.length === 1 ? context.businesses[0]?.name : 'All accessible businesses'}
      >
        My Day
      </PageHead>

      <MyDayNav active="today" />

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={4}>
        <Stat value={counts.connections} label={TODAY_CATEGORY_LABELS.connections} />
        <Stat value={counts.accepted_message1} label="Message 1" />
        <Stat value={counts.followups} label={TODAY_CATEGORY_LABELS.followups} />
        <Stat
          value={overdue}
          label="Overdue"
          meta={overdue > 0 ? 'needs attention first' : 'nothing overdue'}
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card>
        {context.businesses.length === 0 ? (
          <span className="nx-hint">An administrator has not granted you access to a business yet.</span>
        ) : (
          <TodayList
            items={todayItems}
            businesses={context.businesses.map((business) => ({ id: business.id, name: business.name }))}
            selectedBusinessId={businessId ?? ''}
            selectedCategory={query.category ?? ''}
            categories={TODAY_CATEGORIES.map((category) => ({
              value: category,
              label: TODAY_CATEGORY_LABELS[category],
              count: counts[category],
            }))}
          />
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />

      <p className="nx-hint"><Chip accent="cyan">tip</Chip> Completing an item moves it to Done and records its history immediately.</p>
    </>
  );
}
