import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  PageHead,
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';
import { OUTREACH_BLOCKING_LEAD_STATES } from '@nexus/core';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  loadOverviewSnapshot,
  type OverviewActivityRow,
  type OverviewAgentStatusRow,
  type OverviewFunnelRow,
  type OverviewSignalRow,
} from './v1-2-metrics';
import {
  ENRICHMENT_STATE_ORDER,
  activityKindAccent,
  activityKindLabel,
  activityLink,
  agentJobStatusAccent,
  agentJobStatusLabel,
  channelLabel,
  enrichmentStateAccent,
  enrichmentStateLabel,
  listBusinessAccountChannels,
  listChannelAccounts,
  type ChannelAccountRow,
} from '@/lib/channel-vocabulary';

import './overview.css';

export const dynamic = 'force-dynamic';

/**
 * A02 — Overview (V1.2, spec §71).
 *
 * **Eight metrics, exactly.** Active Leads, Needs Enrichment, Agent Jobs Open,
 * Waiting AI, Ready for Outreach, Replies Today, AI usage today and Failed
 * enrichments — plus an enrichment funnel and a recent activity feed, which is the
 * whole of §71.1.
 *
 * **Every number is a query result.** Where a source has no rows the screen says so
 * ("no AI runs recorded today") rather than printing a `0` as though it were a
 * measurement. Nothing on this page calls a model: a render that invoked the AI
 * pipeline would make the same figure differ between two loads and spend money
 * doing it.
 *
 * The metrics live in `./v1-2-metrics`, so this screen and Insights cannot
 * disagree about what "needs enrichment" or "ready for outreach" means; this file
 * owns only how they are presented.
 *
 * One deliberate difference from the V1.1 screen: "Active Leads" is
 * `deleted_at is null and status not in ('archived','deleted')`. spec §71.2 says
 * `status != 'deleted'`; `archived` is excluded too because an archived lead is out
 * of every working view, and counting it would make the headline disagree with the
 * Leads screen the operator opens next.
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

  // The layout resolves the slug but does not gate the route; the destination's own
  // permission is enforced here, where the read happens.
  requireRouteAccess(context, { route: '/b/:businessSlug/overview', businessId: business.id });

  const [snapshot, accounts, accountChannels] = await Promise.all([
    loadOverviewSnapshot(context.viewer.actor, business.id),
    listChannelAccounts(context.viewer.actor),
    listBusinessAccountChannels(context.viewer.actor, business.id),
  ]);

  // Pipeline order, not count order: the funnel is a progression, and sorting it by
  // size would present it as a ranking instead.
  const funnelRows: readonly OverviewFunnelRow[] = snapshot.funnel
    .slice()
    .sort(
      (left, right) =>
        funnelIndex(left.status) - funnelIndex(right.status) || right.leads - left.leads,
    );

  const funnelColumns: readonly Column<OverviewFunnelRow>[] = [
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
      key: 'share',
      header: 'Share',
      width: '120px',
      cell: (row) => {
        const share = percent(row.leads, snapshot.enrichmentTotal);
        return (
          <span className="nx-funnel">
            <span className="nx-funnel__bar" style={{ width: `${String(share)}%` }} aria-hidden="true" />
            <span className="nx-funnel__value">
              {snapshot.enrichmentTotal === 0 ? '—' : `${String(share)}%`}
            </span>
          </span>
        );
      },
    },
    {
      key: 'completeness',
      header: 'Avg completeness',
      numeric: true,
      cell: (row) => (row.leads === 0 ? '—' : `${String(row.avgCompleteness)}%`),
    },
    {
      key: 'errors',
      header: 'With error',
      numeric: true,
      cell: (row) => (row.withError === 0 ? <span className="nx-hint">none</span> : <Chip accent="red">{row.withError}</Chip>),
    },
  ];

  const agentColumns: readonly Column<OverviewAgentStatusRow>[] = [
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

  const signalColumns: readonly Column<OverviewSignalRow>[] = [
    {
      key: 'when',
      header: 'Observed',
      cell: (row) => <span className="nx-table__mono">{formatWhen(row.at)}</span>,
    },
    {
      key: 'kind',
      header: 'Signal',
      cell: (row) => <Chip accent={signalAccent(row.polarity)}>{row.summary}</Chip>,
    },
    {
      key: 'detail',
      header: 'Detail',
      cell: (row) =>
        row.detail === null ? (
          <span className="nx-hint">no detail recorded</span>
        ) : (
          <span className="nx-hint">{row.detail}</span>
        ),
    },
    {
      key: 'lead',
      header: 'Lead',
      cell: (row) =>
        row.leadId === null ? (
          <span className="nx-hint">not attached</span>
        ) : (
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/b/${business.key}/leads/${row.leadId}`}>
            Open lead
          </a>
        ),
    },
  ];

  const activityColumns: readonly Column<OverviewActivityRow>[] = [
    {
      key: 'when',
      header: 'When',
      width: '160px',
      cell: (row) => <span className="nx-table__mono">{formatWhen(row.at)}</span>,
    },
    {
      key: 'kind',
      header: 'Feed',
      cell: (row) => <Chip accent={activityKindAccent(row.kind)}>{activityKindLabel(row.kind)}</Chip>,
    },
    { key: 'what', header: 'What happened', cell: (row) => row.summary },
    { key: 'record', header: 'Record', cell: (row) => row.recordType.replace(/_/g, ' ') },
    {
      key: 'actor',
      header: 'Actor',
      cell: (row) => <span className="nx-hint">{row.actorType.replace(/_/g, ' ')}</span>,
    },
    {
      key: 'open',
      header: '',
      cell: (row) => {
        const link = activityLink(row.kind, row.leadId, business.key);
        return link === null ? null : (
          <a className="nx-btn nx-btn--secondary nx-btn--sm" href={link.href}>
            {link.label}
          </a>
        );
      },
    },
  ];

  const accountColumns: readonly Column<ChannelAccountRow>[] = [
    {
      key: 'name',
      header: 'Channel account',
      cell: (account) => (
        <div className="nx-stack nx-stack--sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/identities/${account.id}`}>
            <strong>{account.displayName}</strong>
          </a>
          {account.managerName === null && <span className="nx-hint">unassigned</span>}
        </div>
      ),
    },
    {
      key: 'channel',
      header: 'Channel',
      cell: (account) => <Chip accent="indigo">{channelLabel(account.channel)}</Chip>,
    },
    {
      key: 'sent',
      header: 'Sent today',
      numeric: true,
      cell: (account) =>
        account.dailyTarget === 0
          ? String(account.dailySentCount)
          : `${String(account.dailySentCount)} / ${String(account.dailyTarget)}`,
    },
    { key: 'status', header: 'Status', cell: (account) => account.status },
  ];

  const statesWithLeads = snapshot.funnel.filter((row) => row.leads > 0).length;
  const blockedStates: readonly string[] = OUTREACH_BLOCKING_LEAD_STATES;

  return (
    <>
      <PageHead
        subtitle={`Operational snapshot for ${business.name}${business.focus === null ? '' : ` · ${business.focus}`}`}
      >
        Overview
      </PageHead>

      <Grid cols={4}>
        <Stat
          value={snapshot.activeLeads}
          label="Active leads"
          meta={`${String(snapshot.enrichmentTotal)} with an enrichment record`}
        />
        <Stat
          value={snapshot.needsEnrichment}
          label="Needs enrichment"
          meta={`${String(snapshot.readyForOutreach)} ready for outreach`}
        />
        <Stat
          value={snapshot.jobsOpen}
          label="Agent jobs open"
          meta={snapshot.oldestOpenJobAt === null ? 'queue empty' : `oldest ${formatWhen(snapshot.oldestOpenJobAt)}`}
        />
        <Stat value={snapshot.jobsWaitingAi} label="Waiting AI" meta="queued for the model" />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid cols={4}>
        <Stat
          value={snapshot.readyForOutreach}
          label="Ready for outreach"
          meta="enrichment READY, no blocking sales state"
        />
        <Stat value={snapshot.repliesToday} label="Replies today" meta="inbound replies recorded today" />
        <Stat
          value={snapshot.aiRunsToday}
          label="AI usage today"
          meta={
            snapshot.aiRunsToday === 0
              ? 'no AI runs recorded today'
              : `${tokenSummary(snapshot.aiTokensIn, snapshot.aiTokensOut)} · ${formatCost(snapshot.aiCostUsd)}`
          }
        />
        <Stat
          value={snapshot.failedEnrichments}
          label="Failed enrichments"
          meta={
            snapshot.failedEnrichments === 0
              ? 'no failures recorded'
              : `${String(snapshot.enrichmentWithError)} with an error code`
          }
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Card
          title="Enrichment funnel"
          actions={
            <Chip accent="indigo">
              {`${String(statesWithLeads)} of ${String(ENRICHMENT_STATE_ORDER.length)} states in use`}
            </Chip>
          }
          footer={
            <span className="nx-hint">
              States are the pipeline&rsquo;s own states, not the sales statuses — spec §71.4 keeps the two
              vocabularies apart. A state with no leads is omitted rather than shown as a zero-length bar. Read from{' '}
              <code>lead_enrichment_funnel</code>, so the average completeness is the database&rsquo;s own.
            </span>
          }
        >
          <DataTable
            columns={funnelColumns}
            rows={funnelRows}
            rowKey={(row) => row.status}
            caption="Leads per enrichment state, with average completeness"
            empty={
              <EmptyState
                title="No enrichment rows yet"
                body="Every lead gets an enrichment row when it is created, so an empty funnel means this business has no leads."
              />
            }
          />
        </Card>

        <Card
          title="Agent activity"
          actions={
            <Chip accent="indigo">{`${String(snapshot.jobsOpen + snapshot.jobsWaitingAi)} queued`}</Chip>
          }
          footer={
            <span className="nx-hint">
              Read from <code>agent_job_queue_summary</code>, so the counts are the queue&rsquo;s own.
              &ldquo;Oldest&rdquo; is the oldest job in that status; a WAITING_AI job with a lease expiry is
              already being extracted.
            </span>
          }
        >
          <DataTable
            columns={agentColumns}
            rows={snapshot.agentStates}
            rowKey={(row) => row.status}
            caption="Agent jobs per status"
            empty={
              <EmptyState
                title="No agent jobs yet"
                body="Research, capture and context jobs appear here as soon as the pipeline queues them."
              />
            }
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Grid split>
        <Card
          title="Recent signals"
          actions={<Chip accent="cyan">{snapshot.recentSignals.length}</Chip>}
          footer={
            <span className="nx-hint">
              Active signals observed against this business&rsquo;s leads. A signal is a reason to make contact now;
              it is never a substitute for the lead&rsquo;s own state.
            </span>
          }
        >
          <DataTable
            columns={signalColumns}
            rows={snapshot.recentSignals}
            rowKey={(row) => row.id}
            caption="Most recent active signals"
            empty={<span className="nx-hint">No active signals are recorded for this business.</span>}
          />
        </Card>

        <Card
          title="Channel accounts"
          actions={<Chip>{accounts.length}</Chip>}
          footer={
            <span className="nx-hint">
              {accountChannels.length === 0
                ? 'No channel account is bound to this business, so nothing can be sent from here yet.'
                : `Serving this business on ${accountChannels.map((channel) => channelLabel(channel)).join(', ')}.`}{' '}
              The list is RLS-scoped: a non-admin sees only the accounts assigned to them. Discovery source and
              outreach channel are independent — this column says how an account reaches people, not where its leads
              were found.
            </span>
          }
        >
          <DataTable
            columns={accountColumns}
            rows={accounts}
            rowKey={(account) => account.id}
            caption="Channel accounts visible to you, with the channel each one sends on"
            empty={<span className="nx-hint">No channel account is visible to you.</span>}
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-xl)' }} />

      <Card
        title="Recent activity"
        actions={
          <Stack size="sm">
            <Chip accent="neutral">merged feed</Chip>
            <Chip>{snapshot.activityTotal} events</Chip>
          </Stack>
        }
        footer={
          <span className="nx-hint">
            The four audited feeds merged — audit trail, lead timeline, signals and agent job history — newest first,
            bounded to the most recent events. A row with no screen of its own is plain text rather than a link, and
            an audit row is never linked as a lead: its <code>entity_id</code> may name any record.
          </span>
        }
      >
        <DataTable
          columns={activityColumns}
          rows={snapshot.activity}
          rowKey={(row) => row.id}
          caption="Most recent activity across the business"
          empty={<span className="nx-hint">No activity has been recorded for this business yet.</span>}
        />
      </Card>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="neutral" title="How to read this page">
        <span>
          Every figure is a bounded query over stored rows, and a source with no rows says so instead of printing a
          zero. {blockedStates.length} sales states block outreach entirely (
          {blockedStates.map((state) => state.replace(/_/g, ' ')).join(', ')}), which is why &ldquo;Ready for
          outreach&rdquo; can be lower than the number of leads whose enrichment is <code>READY</code>.
        </span>
      </Alert>
    </>
  );
}

/* --------------------------------------------------------------- display -- */

function funnelIndex(status: string): number {
  const index = (ENRICHMENT_STATE_ORDER as readonly string[]).indexOf(status);
  return index === -1 ? ENRICHMENT_STATE_ORDER.length : index;
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function signalAccent(polarity: string): 'cyan' | 'green' | 'red' | 'neutral' {
  switch (polarity) {
    case 'positive':
      return 'green';
    case 'negative':
      return 'red';
    case 'neutral':
      return 'cyan';
    default:
      return 'neutral';
  }
}

function formatWhen(value: string | null): string {
  if (value === null || value.length === 0) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toISOString().replace('T', ' ').slice(0, 16);
}

function tokenSummary(tokensIn: number, tokensOut: number): string {
  return `${tokensIn.toLocaleString('en-US')} in / ${tokensOut.toLocaleString('en-US')} out`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)} est.`;
}
