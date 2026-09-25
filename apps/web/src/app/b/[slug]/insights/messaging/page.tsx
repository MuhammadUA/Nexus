import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, Grid, PageHead, Row, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { getReplyThemes, getStepPerformance, type ReplyTheme, type StepPerformance } from '@/lib/repo/insights';
import { listAuditEvents, listAgentRuns, type AgentRunRow, type AuditRow } from '@/lib/repo/integrations';

export const dynamic = 'force-dynamic';

/**
 * A21 — Messaging Insights.
 *
 * Contract: "Reply themes, sequence step performance, no-reply, wrong-person signals;
 * feeds ICP/sequence improvement."
 *
 * Two honesty constraints shape this screen:
 *   1. Reply outcomes are counted as recorded — the operator's own classification —
 *      not inferred from message text.
 *   2. A reply is attributed to "at or after" a step was sent, not to that step
 *      causally. Claiming per-step causality would overstate what the data supports,
 *      and that is stated on the page.
 */
export default async function MessagingInsightsPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const [themes, steps, runs, audit] = await Promise.all([
    getReplyThemes(context.viewer.actor, business.id),
    getStepPerformance(context.viewer.actor, business.id),
    listAgentRuns(context.viewer.actor, business.id, 10),
    listAuditEvents(context.viewer.actor, business.id, 25),
  ]);

  const totalReplies = themes.reduce((sum, theme) => sum + theme.count, 0);
  const negative = themes
    .filter((theme) => ['Wrong person', 'Not interested', 'Do not contact', 'Already has supplier'].includes(theme.outcome))
    .reduce((sum, theme) => sum + theme.count, 0);
  const dnc = themes.find((theme) => theme.outcome === 'Do not contact')?.count ?? 0;

  const themeColumns: readonly Column<ReplyTheme>[] = [
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (theme) => (
        <Chip accent={themeAccent(theme.outcome)}>{theme.outcome}</Chip>
      ),
    },
    { key: 'count', header: 'Replies', numeric: true, cell: (theme) => theme.count },
    {
      key: 'share',
      header: 'Share',
      numeric: true,
      cell: (theme) => `${(theme.share * 100).toFixed(1)}%`,
    },
  ];

  const stepColumns: readonly Column<StepPerformance>[] = [
    { key: 'step', header: 'Step', cell: (step) => step.stepName },
    { key: 'sent', header: 'Sent', numeric: true, cell: (step) => step.sent },
    { key: 'replies', header: 'Replies after', numeric: true, cell: (step) => step.repliesAfter },
    {
      key: 'rate',
      header: 'Reply rate',
      numeric: true,
      cell: (step) => (step.sent === 0 ? '—' : `${(step.replyRate * 100).toFixed(1)}%`),
    },
  ];

  const runColumns: readonly Column<AgentRunRow>[] = [
    { key: 'agent', header: 'Agent', cell: (run) => run.agentName },
    { key: 'objective', header: 'Objective', cell: (run) => run.objective ?? '—' },
    {
      key: 'state',
      header: 'State',
      cell: (run) => (
        <Chip accent={run.state === 'completed' || run.state === 'succeeded' ? 'green' : 'amber'}>
          {run.state}
        </Chip>
      ),
    },
  ];

  const auditColumns: readonly Column<AuditRow>[] = [
    { key: 'at', header: 'When', cell: (row) => <span className="nx-table__mono">{row.at?.slice(0, 16).replace('T', ' ') ?? '—'}</span> },
    { key: 'action', header: 'Action', cell: (row) => <Chip accent="indigo">{row.action}</Chip> },
    { key: 'entity', header: 'Record', cell: (row) => row.entityType.replace(/_/g, ' ') },
    { key: 'actor', header: 'Actor', cell: (row) => row.actorType.replace(/_/g, ' ') },
    { key: 'client', header: 'Client', cell: (row) => row.sourceClient ?? '—' },
  ];

  return (
    <>
      <PageHead subtitle={`How outreach is landing for ${business.name}. Use it to sharpen ICPs and sequences.`}>
        Messaging Insights
      </PageHead>

      <Grid cols={4}>
        <Stat value={totalReplies} label="Replies recorded" />
        <Stat
          value={totalReplies === 0 ? 0 : themes.find((t) => t.outcome === 'Interested' || t.outcome === 'Positive / needs info')?.count ?? 0}
          label="Positive"
        />
        <Stat value={negative} label="Negative or wrong person" />
        <Stat
          value={dnc}
          label="Do Not Contact"
          meta="suppressed across every sender"
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={2}>
        <Card title="Reply themes" actions={<Chip accent="indigo">{business.name}</Chip>}>
          <DataTable
            columns={themeColumns}
            rows={themes}
            rowKey={(theme) => theme.outcome}
            caption="Recorded reply outcomes"
            empty={<span className="nx-hint">No replies recorded yet.</span>}
          />
        </Card>

        <Card title="Sequence step performance">
          <DataTable
            columns={stepColumns}
            rows={steps}
            rowKey={(step) => String(step.stepOrder)}
            caption="Messages sent per step"
            empty={<span className="nx-hint">Nothing has been sent yet.</span>}
          />
          <p className="nx-hint" style={{ marginTop: 'var(--nx-space-sm)' }}>
            &ldquo;Replies after&rdquo; counts replies recorded at or after that step was sent. It is not
            proof that the step caused the reply — a short sequence cannot support that claim, and pretending
            otherwise would mislead ICP decisions.
          </p>
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={2}>
        <Card title="Recent agent runs" actions={<Chip>{runs.length}</Chip>}>
          <DataTable
            columns={runColumns}
            rows={runs}
            rowKey={(run) => run.id}
            caption="Recent agent runs"
            empty={<span className="nx-hint">No agent runs for this business.</span>}
          />
        </Card>

        <Card title="Provenance & audit" actions={<Chip accent="neutral">last 25</Chip>}>
          <DataTable
            columns={auditColumns}
            rows={audit}
            rowKey={(row) => row.id}
            caption="Recent audited activity"
            empty={<span className="nx-hint">No audited activity yet.</span>}
          />
        </Card>
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="amber" title="How to read this">
        <Row wrap>
          <span>
            A high wrong-person rate points at ICP targeting, not message copy. A high no-reply rate with
            correct targeting points at the offer or the CTA. Outcomes are the operator&apos;s own
            classification, so they are only as good as the capture discipline on the Reply &amp; Notes screen.
          </span>
        </Row>
      </Alert>
    </>
  );
}

function themeAccent(outcome: string): 'green' | 'amber' | 'red' | 'cyan' | 'neutral' {
  switch (outcome) {
    case 'Interested':
    case 'Positive / needs info':
      return 'green';
    case 'Maybe later':
    case 'No current need':
      return 'amber';
    case 'Not interested':
    case 'Wrong person':
    case 'Already has supplier':
    case 'Do not contact':
      return 'red';
    case 'Other':
    default:
      return 'neutral';
  }
}
