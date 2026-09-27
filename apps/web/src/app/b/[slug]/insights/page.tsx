import type { ReactNode } from 'react';

import { Card, Chip, DataTable, Grid, PageHead, Row, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  getOverview,
  getReplyThemes,
  getStepPerformance,
  type ReplyTheme,
  type StepPerformance,
} from '@/lib/repo/insights';

export const dynamic = 'force-dynamic';

/**
 * A21 — Insights (the `Insights` destination of the Admin sidebar).
 *
 * Final Figma places Insights under ADMIN and gives it one nested surface, Messaging Insights. This
 * screen is the parent: a real performance summary read from the same repositories the nested screen
 * uses, so the destination is a working overview rather than a link stub.
 *
 * It exists because the earlier navigation reached `/b/:slug/insights/messaging` directly and left the
 * parent undefined; a top-level destination that 404s is exactly the kind of orphaned route the
 * baseline must not contain.
 */
export default async function InsightsPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  requireRouteAccess(context, { route: '/b/:businessSlug/insights', businessId: business.id });

  const [overview, themes, steps] = await Promise.all([
    getOverview(context.viewer.actor, business.id),
    getReplyThemes(context.viewer.actor, business.id),
    getStepPerformance(context.viewer.actor, business.id),
  ]);

  const themeColumns: readonly Column<ReplyTheme>[] = [
    { key: 'outcome', header: 'Outcome', cell: (theme) => theme.outcome.replace(/_/g, ' ') },
    { key: 'count', header: 'Replies', numeric: true, cell: (theme) => theme.count },
    {
      key: 'share',
      header: 'Share',
      numeric: true,
      cell: (theme) => `${Math.round(theme.share * 100)}%`,
    },
  ];

  const stepColumns: readonly Column<StepPerformance>[] = [
    { key: 'order', header: 'Step', numeric: true, cell: (step) => step.stepOrder },
    { key: 'name', header: 'Name', cell: (step) => step.stepName },
    { key: 'sent', header: 'Sent', numeric: true, cell: (step) => step.sent },
    { key: 'replies', header: 'Replies after', numeric: true, cell: (step) => step.repliesAfter },
    {
      key: 'rate',
      header: 'Reply rate',
      numeric: true,
      cell: (step) => `${(step.replyRate * 100).toFixed(1)}%`,
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`Messaging performance for ${business.name}.`}
        actions={
          <a className="nx-btn nx-btn--secondary nx-btn--sm" href={`/b/${business.key}/insights/messaging`}>
            Messaging Insights
          </a>
        }
      >
        Insights
      </PageHead>

      <Grid cols={4}>
        <Stat value={overview.repliesRecorded} label="Replies recorded" meta={`${String(themes.length)} outcomes`} />
        <Stat value={overview.activeLeads} label="Active leads" meta={`${String(overview.dormant)} dormant`} />
        <Stat value={overview.dueToday} label="Follow-ups due" meta={overview.overdue > 0 ? `${String(overview.overdue)} overdue` : 'nothing overdue'} />
        <Stat value={overview.suppressed} label="Do Not Contact" meta="suppressed across senders" />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Card
          title="Reply outcomes"
          actions={<Chip accent="indigo">{themes.reduce((sum, theme) => sum + theme.count, 0)} replies</Chip>}
        >
          <DataTable
            columns={themeColumns}
            rows={themes}
            rowKey={(theme) => theme.outcome}
            caption="Inbound reply outcomes for this business"
            empty={<span className="nx-hint">No replies have been captured yet.</span>}
          />
        </Card>

        <Card title="Step performance" actions={<Chip accent="indigo">{steps.length} steps</Chip>}>
          <DataTable
            columns={stepColumns}
            rows={steps}
            rowKey={(step) => String(step.stepOrder)}
            caption="Reply rate by sequence step"
            empty={<span className="nx-hint">No messages have been sent yet.</span>}
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Messaging Insights" actions={<Chip accent="neutral">nested surface</Chip>}>
        <Row between>
          <span className="nx-hint">
            Per-sender volume, reply themes and step-by-step performance.
          </span>
          <a className="nx-btn nx-btn--primary nx-btn--sm" href={`/b/${business.key}/insights/messaging`}>
            Open Messaging Insights
          </a>
        </Row>
      </Card>
    </>
  );
}
