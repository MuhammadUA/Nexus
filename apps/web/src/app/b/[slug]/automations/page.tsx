import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, EmptyState, Grid, PageHead, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  getJobHealth,
  listAgentRuns,
  listAutomations,
  type AgentRunRow,
  type AutomationRow,
} from '@/lib/repo/integrations';
import { listIcpOptions } from '@/lib/repo/leads';
import { AutomationForm } from '@/components/automation-forms';

export const dynamic = 'force-dynamic';

/**
 * A19 — Automation Mapping.
 *
 * Contract: "Map BrowserOS/OpenCode/other scouts to business + ICP + source + schedule
 * + data contract."
 *
 * The screen's emphasis is the *contract*: a scout is only as safe as the narrow tool
 * surface it is given, so each mapping names its runner, source type and ICP, and the
 * page restates that these runners receive Nexus tools rather than database access.
 */
export default async function AutomationsPage({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  // Business-scoped configuration: judged against this business's grant alone.
  requireRouteAccess(context, { route: '/b/:businessSlug/automations', businessId: business.id });

  const canManage = context.permissions.has('automation.manage');

  const [automations, runs, health, icps] = await Promise.all([
    listAutomations(context.viewer.actor, business.id),
    listAgentRuns(context.viewer.actor, business.id),
    getJobHealth(context.viewer.actor, business.id),
    listIcpOptions(context.viewer.actor, business.id),
  ]);

  const automationColumns: readonly Column<AutomationRow>[] = [
    { key: 'name', header: 'Automation', cell: (row) => <strong>{row.name}</strong> },
    { key: 'runner', header: 'Runner', cell: (row) => <Chip accent="indigo">{row.runner}</Chip> },
    { key: 'source', header: 'Source', cell: (row) => row.sourceType ?? '—' },
    { key: 'schedule', header: 'Schedule', cell: (row) => row.schedule ?? 'manual' },
    {
      key: 'state',
      header: 'State',
      cell: (row) => <Chip accent={row.isActive ? 'green' : 'neutral'}>{row.isActive ? 'active' : 'paused'}</Chip>,
    },
    {
      key: 'last',
      header: 'Last run',
      cell: (row) => <span className="nx-table__mono">{row.lastRunAt?.slice(0, 16) ?? 'never'}</span>,
    },
  ];

  const runColumns: readonly Column<AgentRunRow>[] = [
    { key: 'agent', header: 'Agent', cell: (run) => run.agentName },
    { key: 'objective', header: 'Objective', cell: (run) => run.objective ?? '—' },
    {
      key: 'state',
      header: 'State',
      cell: (run) => (
        <Chip
          accent={
            run.state === 'completed' || run.state === 'succeeded'
              ? 'green'
              : run.state === 'failed' || run.state === 'error'
                ? 'red'
                : 'amber'
          }
        >
          {run.state}
        </Chip>
      ),
    },
    { key: 'started', header: 'Started', cell: (run) => <span className="nx-table__mono">{run.startedAt?.slice(0, 16) ?? '—'}</span> },
    { key: 'summary', header: 'Summary', cell: (run) => run.summary ?? run.error ?? '—' },
  ];

  return (
    <>
      <PageHead subtitle={`Discovery, research and scout mappings for ${business.name}.`}>
        Automation Mapping
      </PageHead>

      <Grid cols={4}>
        <Stat value={automations.length} label="Mappings" meta={`${String(automations.filter((a) => a.isActive).length)} active`} />
        <Stat value={health.completed} label="Completed runs" />
        <Stat value={health.running + health.pending} label="In flight" />
        <Stat
          value={health.failed}
          label="Failed runs"
          meta={health.lastFailureAt === null ? 'none' : `last ${health.lastFailureAt.slice(0, 16)}`}
        />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="indigo" title="What a scout receives">
        BrowserOS, OpenCode, n8n and any other runner get narrow Nexus tools and a scoped
        token — never database credentials and never a SQL escape hatch. Every submission is
        schema-validated, deduplicated and audited before it touches a lead.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid split>
        <Card title="Mappings" actions={<Chip>{automations.length}</Chip>}>
          <DataTable
            columns={automationColumns}
            rows={automations}
            rowKey={(row) => row.id}
            caption="Automation mappings for this business"
            empty={
              <EmptyState
                title="No automations mapped"
                body="Map a runner to a business, ICP and source so its submissions land in the right context."
              />
            }
          />
        </Card>

        {canManage && (
          <Card title="Add a mapping">
            <AutomationForm businessId={business.id} icps={icps} />
          </Card>
        )}
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Recent agent runs" actions={<Chip accent="neutral">job health</Chip>}>
        <DataTable
          columns={runColumns}
          rows={runs}
          rowKey={(run) => run.id}
          caption="Recent agent runs"
          empty={<span className="nx-hint">No agent runs recorded yet.</span>}
        />
      </Card>
    </>
  );
}
