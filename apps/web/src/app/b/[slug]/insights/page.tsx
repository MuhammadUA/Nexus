import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  PageHead,
  Stat,
  type Column,
} from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  V1_2_WINDOWS,
  loadInsightsData,
  type AiDayRow,
  type AiTaskRow,
  type ChannelRow,
  type EnrichmentEventDay,
  type EnrichmentStateRow,
  type JobDayRow,
  type OutcomeRow,
  type QueueRow,
  type SourceRow,
  type StepRow,
} from '../overview/v1-2-metrics';
import {
  agentJobStatusAccent,
  agentJobStatusLabel,
  channelLabel,
  enrichmentStateAccent,
  enrichmentStateLabel,
} from '@/lib/channel-vocabulary';

export const dynamic = 'force-dynamic';

/**
 * A21 — Insights (V1.2, spec §54/§61 and the §71.2 metric definitions).
 *
 * **Rule for this screen: a metric with no rows is shown as no data, never as a
 * zero.** "0% cache hit rate" and "no AI runs recorded in this window" are different
 * statements, and only one of them is true when the ledger is empty. Every card
 * below therefore either renders its rows or an explicit empty state naming what is
 * missing; nothing is padded, extrapolated or defaulted to a number.
 *
 * **What is deliberately absent.**
 *
 *   * **Enrichment *state transitions*.** `lead_enrichment` stores each lead's
 *     current state plus three enrichment timestamps; no table stores a state
 *     history. So the throughput series counts the enrichment events that are
 *     actually recorded — a profile extraction, a company research pass, a context
 *     build — and says so. Calling it "state changes" would claim a history the CRM
 *     does not have. Where leads are *stuck* is the failures-by-state table.
 *   * **Cost is estimated.** `ai_runs.estimated_cost_usd` is a stored estimate, not
 *     an invoice, and is labelled "est." wherever it appears.
 *   * **Campaign or promotion performance.** Nothing in these tables supports it, so
 *     it is absent rather than approximated.
 *
 * Reply outcomes are the operator's own classification; the per-step attribution
 * caveat lives on Messaging Insights, which owns that reading.
 *
 * All reads live in the `[slug]/overview/v1-2-metrics` module shared with the Overview, issued in one `Promise.all`;
 * this file owns presentation only.
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

  const data = await loadInsightsData(context.viewer.actor, business.id);

  const enrichmentColumns: readonly Column<EnrichmentEventDay>[] = [
    { key: 'day', header: 'Day', cell: (row) => <span className="nx-table__mono">{row.day}</span> },
    { key: 'profiles', header: 'Profiles', numeric: true, cell: (row) => row.profiles },
    { key: 'companies', header: 'Company research', numeric: true, cell: (row) => row.companies },
    { key: 'context', header: 'Context builds', numeric: true, cell: (row) => row.context },
  ];

  const failureColumns: readonly Column<EnrichmentStateRow>[] = [
    {
      key: 'state',
      header: 'Enrichment state',
      cell: (row) => (
        <Chip accent={enrichmentStateAccent(row.status)} dataState={row.status}>
          {enrichmentStateLabel(row.status)}
        </Chip>
      ),
    },
    { key: 'leads', header: 'Leads', numeric: true, cell: (row) => row.leads },
    {
      key: 'errors',
      header: 'With an error code',
      numeric: true,
      cell: (row) => (row.withError === 0 ? <span className="nx-hint">none</span> : <Chip accent="red">{row.withError}</Chip>),
    },
    {
      key: 'completeness',
      header: 'Avg completeness',
      numeric: true,
      cell: (row) => `${String(row.avgCompleteness)}%`,
    },
  ];

  const jobColumns: readonly Column<JobDayRow>[] = [
    { key: 'day', header: 'Day', cell: (row) => <span className="nx-table__mono">{row.day}</span> },
    { key: 'completed', header: 'Completed', numeric: true, cell: (row) => row.completed },
    {
      key: 'failed',
      header: 'Failed',
      numeric: true,
      cell: (row) => (row.failed === 0 ? 0 : <Chip accent="red">{row.failed}</Chip>),
    },
    { key: 'attempts', header: 'Attempts', numeric: true, cell: (row) => row.attempts },
  ];

  const queueColumns: readonly Column<QueueRow>[] = [
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Chip accent={agentJobStatusAccent(row.status)} dataState={row.status}>
          {agentJobStatusLabel(row.status)}
        </Chip>
      ),
    },
    { key: 'jobs', header: 'Jobs', numeric: true, cell: (row) => row.jobs },
    { key: 'attempts', header: 'Attempts', numeric: true, cell: (row) => row.attempts },
    {
      key: 'oldest',
      header: 'Oldest',
      cell: (row) => <span className="nx-table__mono">{formatWhen(row.oldestCreatedAt)}</span>,
    },
  ];

  const aiDayColumns: readonly Column<AiDayRow>[] = [
    { key: 'day', header: 'Day', cell: (row) => <span className="nx-table__mono">{row.day}</span> },
    { key: 'runs', header: 'Runs', numeric: true, cell: (row) => row.runs },
    {
      key: 'cache',
      header: 'Cache hits',
      numeric: true,
      cell: (row) =>
        row.runs === 0 ? '—' : `${String(row.cacheHits)} (${String(percent(row.cacheHits, row.runs))}%)`,
    },
    {
      key: 'failures',
      header: 'Failures',
      numeric: true,
      cell: (row) => (row.failures === 0 ? 0 : <Chip accent="red">{row.failures}</Chip>),
    },
    {
      key: 'tokens',
      header: 'Tokens in / out',
      numeric: true,
      cell: (row) => `${row.tokensIn.toLocaleString('en-US')} / ${row.tokensOut.toLocaleString('en-US')}`,
    },
    { key: 'cost', header: 'Cost est.', numeric: true, cell: (row) => `$${row.costUsd.toFixed(4)}` },
  ];

  const aiTaskColumns: readonly Column<AiTaskRow>[] = [
    { key: 'task', header: 'Task', cell: (row) => <span className="nx-table__mono">{row.task}</span> },
    { key: 'runs', header: 'Runs', numeric: true, cell: (row) => row.runs },
    {
      key: 'cache',
      header: 'Cache hits',
      numeric: true,
      cell: (row) =>
        row.runs === 0 ? '—' : `${String(row.cacheHits)} (${String(percent(row.cacheHits, row.runs))}%)`,
    },
    {
      key: 'failures',
      header: 'Failures',
      numeric: true,
      cell: (row) => (row.failures === 0 ? 0 : <Chip accent="red">{row.failures}</Chip>),
    },
    { key: 'cost', header: 'Cost est.', numeric: true, cell: (row) => `$${row.costUsd.toFixed(4)}` },
    {
      key: 'duration',
      header: 'Avg duration',
      numeric: true,
      cell: (row) => (row.avgDurationMs === 0 ? '—' : `${String(Math.round(row.avgDurationMs))} ms`),
    },
  ];

  const sourceColumns: readonly Column<SourceRow>[] = [
    {
      key: 'source',
      header: 'Discovery source',
      cell: (row) => <Chip accent="cyan">{row.source.replace(/_/g, ' ')}</Chip>,
    },
    { key: 'leads', header: 'Leads', numeric: true, cell: (row) => row.leads },
  ];

  const channelColumns: readonly Column<ChannelRow>[] = [
    {
      key: 'channel',
      header: 'Outreach channel',
      cell: (row) => <Chip accent="indigo">{channelLabel(row.channel)}</Chip>,
    },
    { key: 'sent', header: 'Messages sent', numeric: true, cell: (row) => row.sent },
  ];

  const outcomeColumns: readonly Column<OutcomeRow>[] = [
    { key: 'outcome', header: 'Outcome', cell: (row) => row.outcome },
    { key: 'count', header: 'Replies', numeric: true, cell: (row) => row.count },
    {
      key: 'share',
      header: 'Share',
      numeric: true,
      cell: (row) => `${String(percent(row.count, data.replyTotal))}%`,
    },
  ];

  const stepColumns: readonly Column<StepRow>[] = [
    { key: 'name', header: 'Step', cell: (row) => row.stepName },
    { key: 'sent', header: 'Sent', numeric: true, cell: (row) => row.sent },
    { key: 'replies', header: 'Replies after', numeric: true, cell: (row) => row.repliesAfter },
  ];

  const historyDays = V1_2_WINDOWS.historyDays;
  const aiCacheRatio =
    data.aiRunsWindow === 0 ? null : percent(data.aiCacheHitsWindow, data.aiRunsWindow);

  return (
    <>
      <PageHead
        subtitle={`What the pipeline is actually producing for ${business.name}. Every series is read from stored rows; a series with no rows says so.`}
        actions={
          <a className="nx-btn nx-btn--secondary nx-btn--sm" href={`/b/${business.key}/insights/messaging`}>
            Messaging Insights
          </a>
        }
      >
        Insights
      </PageHead>

      <Grid cols={4}>
        <Stat
          value={data.readyForOutreach}
          label="Leads ready for outreach"
          meta="enrichment READY, no blocking sales state"
        />
        <Stat
          value={data.aiRunsWindow === 0 ? '—' : `$${data.aiCostWindow.toFixed(4)}`}
          label={`AI cost, ${String(historyDays)} days (est.)`}
          meta={
            data.aiRunsWindow === 0
              ? 'no AI runs recorded in the window'
              : `${String(data.aiRunsWindow)} runs · ${String(data.aiCacheHitsWindow)} cache hits`
          }
        />
        <Stat
          value={data.completedJobsWindow}
          label={`Jobs completed, ${String(historyDays)} days`}
          meta={
            data.attemptsPerCompletion === null
              ? 'no completions to average'
              : `${data.attemptsPerCompletion.toFixed(2)} attempts per completion`
          }
        />
        <Stat
          value={data.queueDepth}
          label="Queue depth"
          meta={data.queueDepth === 0 ? 'queue empty' : 'OPEN + RUNNING + WAITING_AI'}
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Card
          title="Enrichment throughput"
          actions={<Chip accent="indigo">{`last ${String(historyDays)} days`}</Chip>}
          footer={
            <span className="nx-hint">
              Counts the enrichment events actually recorded against each lead: a profile extraction, a company
              research pass, a context build. <code>lead_enrichment</code> stores one row per lead rather than a state
              history, so this is not a series of state transitions — the failures table beside it covers where leads
              are stuck.
            </span>
          }
        >
          <DataTable
            columns={enrichmentColumns}
            rows={data.enrichmentByDay}
            rowKey={(row) => row.day}
            caption="Enrichment events per day"
            empty={
              <EmptyState
                title="No enrichment recorded yet"
                body={`No profile, company research or context build has been recorded for this business in the last ${String(historyDays)} days.`}
              />
            }
          />
        </Card>

        <Card
          title="Enrichment failures by state"
          actions={
            <Chip accent={data.failedEnrichments === 0 ? 'neutral' : 'red'}>
              {`${String(data.failedEnrichments)} failed`}
            </Chip>
          }
          footer={
            <span className="nx-hint">
              Read from <code>lead_enrichment_funnel</code>. &ldquo;With an error code&rdquo; counts rows whose last
              attempt recorded a failure, which can be non-zero in a state that has since advanced.
            </span>
          }
        >
          <DataTable
            columns={failureColumns}
            rows={data.enrichmentStates}
            rowKey={(row) => row.status}
            caption="Leads and errors per enrichment state"
            empty={
              <EmptyState
                title="No enrichment rows yet"
                body="Every lead gets an enrichment row as it is created, so this is empty only when the business has no leads."
              />
            }
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Card
          title="Agent job throughput"
          actions={<Chip accent="indigo">{`last ${String(historyDays)} days`}</Chip>}
          footer={
            <span className="nx-hint">
              From <code>agent_job_events</code>, which is append-only — a completed job is counted on the day its
              completion was recorded, not the day it was created. &ldquo;Attempts&rdquo; counts claimed leases, which
              is what makes retries visible.
            </span>
          }
        >
          <DataTable
            columns={jobColumns}
            rows={data.jobsByDay}
            rowKey={(row) => row.day}
            caption="Completed and failed agent jobs per day"
            empty={
              <EmptyState
                title="No agent job history yet"
                body={`No agent job has been completed, failed or retried for this business in the last ${String(historyDays)} days.`}
              />
            }
          />
        </Card>

        <Card
          title="Queue depth now"
          actions={<Chip accent="indigo">{`${String(data.queueDepth)} queued`}</Chip>}
          footer={
            <span className="nx-hint">
              From <code>agent_job_queue_summary</code>. A WAITING_AI job with a lease expiry is already being
              extracted; one without is available for the processor to claim.
            </span>
          }
        >
          <DataTable
            columns={queueColumns}
            rows={data.queue}
            rowKey={(row) => row.status}
            caption="Agent jobs per status"
            empty={<span className="nx-hint">The queue is empty for this business.</span>}
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="AI usage and cost"
        actions={
          <Chip accent="indigo">
            {aiCacheRatio === null
              ? `last ${String(historyDays)} days · no cache hits`
              : `last ${String(historyDays)} days · ${String(aiCacheRatio)}% of runs were cache hits`}
          </Chip>
        }
        footer={
          <span className="nx-hint">
            From <code>ai_usage_daily</code>, which aggregates the <code>ai_runs</code> ledger by business, day and
            task. Cost is the stored <em>estimate</em> per run, not an invoice. A reuse is recorded as its own ledger
            row with <code>cache_hit = true</code>, so a cache hit counts as a run and costs nothing — which is why
            the ratio is of one to the other rather than a saving.
          </span>
        }
      >
        <DataTable
          columns={aiDayColumns}
          rows={data.aiByDay}
          rowKey={(row) => row.day}
          caption="AI runs, tokens and estimated cost per day"
          empty={
            <EmptyState
              title="No AI usage recorded"
              body={`No AI task has run for this business in the last ${String(historyDays)} days. Metrics that need the ledger are omitted rather than shown as zero.`}
            />
          }
        />
        {data.aiByDay.length > 0 && (
          <>
            <div style={{ height: 'var(--nx-space-lg)' }} />
            <DataTable
              columns={aiTaskColumns}
              rows={data.aiByTask}
              rowKey={(row) => row.task}
              caption="AI usage per task over the same window"
              empty={<span className="nx-hint">No AI task breakdown is available.</span>}
            />
          </>
        )}
      </Card>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Card
          title="Discovery sources"
          actions={<Chip accent="cyan">{`${String(data.sourceTotal)} leads`}</Chip>}
          footer={
            <span className="nx-hint">
              Where leads entered the CRM, for leads that are still being worked — an archived lead is not part of the
              mix. V1.1 stored this as <code>source_type</code>, so each legacy value is projected onto the V1.2{' '}
              <code>DISCOVERY_SOURCES</code> vocabulary by <code>normalizeDiscoverySource</code> rather than
              re-spelled here — which is also why <code>file_csv</code> and <code>file_xlsx</code> appear as one{' '}
              <code>csv</code> row.
            </span>
          }
        >
          <DataTable
            columns={sourceColumns}
            rows={data.bySource}
            rowKey={(row) => row.source}
            caption="Leads by discovery source"
            empty={<span className="nx-hint">No leads have been recorded for this business.</span>}
          />
        </Card>

        <Card
          title="Outreach channels"
          actions={
            <Chip accent="indigo">
              {`${String(data.sentWindow)} sent, ${String(V1_2_WINDOWS.sendDays)} days`}
            </Chip>
          }
          footer={
            <span className="nx-hint">
              Messages actually sent, by the channel of the account that sent them. Discovery source and outreach
              channel are independent: a lead found on Reddit can be emailed, and a LinkedIn-sourced lead can be
              contacted on Upwork. A send whose account was deleted is labelled rather than dropped, so these rows add
              up to the sends that happened.
            </span>
          }
        >
          <DataTable
            columns={channelColumns}
            rows={data.byChannel}
            rowKey={(row) => row.channel}
            caption="Messages sent per outreach channel"
            empty={
              <span className="nx-hint">
                No message has been sent for this business in the last {String(V1_2_WINDOWS.sendDays)} days.
              </span>
            }
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Card
          title="Reply outcomes"
          actions={<Chip accent="indigo">{`${String(data.replyTotal)} recorded`}</Chip>}
          footer={
            <span className="nx-hint">
              Outcomes are the operator&rsquo;s own classification, so they are only as good as the capture discipline
              on the Reply &amp; Notes screen. Per-step attribution is on Messaging Insights, with its caveat.
            </span>
          }
        >
          <DataTable
            columns={outcomeColumns}
            rows={data.outcomes}
            rowKey={(row) => row.outcome}
            caption="Recorded conversation outcomes"
            empty={<span className="nx-hint">No reply outcome has been recorded yet.</span>}
          />
        </Card>

        <Card title="Sequences" actions={<Chip accent="indigo">{`${String(data.stepCount)} steps`}</Chip>}>
          <DataTable
            columns={stepColumns}
            rows={data.steps}
            rowKey={(row) => String(row.stepOrder)}
            caption="Messages sent per sequence step"
            empty={<span className="nx-hint">Nothing has been sent yet.</span>}
          />
          <p className="nx-hint" style={{ marginTop: 'var(--nx-space-sm)' }}>
            &ldquo;Replies after&rdquo; counts replies recorded at or after that step was sent — not proof the step
            caused them.{' '}
            <a href={`/b/${business.key}/insights/messaging`}>Messaging Insights</a> carries the full step and theme
            reading.
          </p>
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="neutral" title="What this page will not claim">
        <span>
          Series with no rows are named rather than zeroed; cost is an estimate from the ledger, not an invoice;
          enrichment throughput counts recorded enrichment events, because no table stores enrichment state history.
          Reading promotion or campaign performance is not possible from these tables, so it is absent instead of
          approximated.
        </span>
      </Alert>
    </>
  );
}

/* --------------------------------------------------------------- display -- */

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function formatWhen(value: string | null): string {
  if (value === null || value.length === 0) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toISOString().replace('T', ' ').slice(0, 16);
}
