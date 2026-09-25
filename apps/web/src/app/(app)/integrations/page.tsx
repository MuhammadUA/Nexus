import type { ReactNode } from 'react';

import { Alert, Card, Chip, DataTable, EmptyState, Grid, PageHead, Row, Stat, type Column } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import {
  listApiClients,
  listWebhooks,
  mcpToolCatalogue,
  type ApiClientRow,
  type WebhookRow,
} from '@/lib/repo/integrations';
import { ApiClientForm, RevokeTokenButton } from '@/components/integration-forms';

export const dynamic = 'force-dynamic';

/**
 * A18 — Integrations Gateway.
 *
 * Contract: "MCP, ingest API, webhooks, optional Google Sheets adapter; scoped auth;
 * no direct DB credentials."
 *
 * The screen's job is to make the security posture legible: which tokens exist, what
 * each may do, and what is deliberately absent. spec `mcp_contract.forbidden_tool`
 * names `database.execute_sql`, and this page states plainly that no tool exposes SQL
 * and no database credential is handed to an agent.
 */
export default async function IntegrationsPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  requireRouteAccess(context, { route: '/integrations' });
  const canManage = context.permissions.has('integration.manage');

  const [clients, webhooks] = canManage
    ? await Promise.all([listApiClients(context.viewer.actor), listWebhooks(context.viewer.actor)])
    : [[], []];

  const tools = mcpToolCatalogue();
  const active = clients.filter((client) => client.isActive && client.revokedAt === null);

  const clientColumns: readonly Column<ApiClientRow>[] = [
    {
      key: 'name',
      header: 'Client',
      cell: (client) => (
        <div className="nx-stack nx-stack--sm">
          <strong>{client.name}</strong>
          {/* The token itself is unrecoverable, so only its prefix can be shown. */}
          <span className="nx-table__mono">{client.tokenPrefix}…</span>
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', cell: (client) => <Chip accent="indigo">{client.kind}</Chip> },
    {
      key: 'scopes',
      header: 'Scopes',
      cell: (client) => (
        <Row wrap>
          {client.scopes.length === 0 ? (
            <span className="nx-hint">none</span>
          ) : (
            client.scopes.map((scope) => <Chip key={scope}>{scope}</Chip>)
          )}
        </Row>
      ),
    },
    {
      key: 'businesses',
      header: 'Businesses',
      numeric: true,
      // An empty allow-list means the token can reach nothing, not everything.
      cell: (client) =>
        client.businessIds.length === 0 ? <Chip accent="amber">none — token can do nothing</Chip> : client.businessIds.length,
    },
    {
      key: 'used',
      header: 'Last used',
      cell: (client) => <span className="nx-table__mono">{client.lastUsedAt?.slice(0, 16) ?? 'never'}</span>,
    },
    {
      key: 'state',
      header: 'State',
      cell: (client) =>
        client.revokedAt !== null ? (
          <Chip accent="red">revoked</Chip>
        ) : client.isActive ? (
          <Chip accent="green">active</Chip>
        ) : (
          <Chip>inactive</Chip>
        ),
    },
    {
      key: 'actions',
      header: '',
      cell: (client) =>
        canManage && client.revokedAt === null ? <RevokeTokenButton clientId={client.id} /> : null,
    },
  ];

  const webhookColumns: readonly Column<WebhookRow>[] = [
    { key: 'name', header: 'Endpoint', cell: (hook) => hook.name },
    { key: 'url', header: 'URL', cell: (hook) => <span className="nx-table__mono">{hook.url}</span> },
    {
      key: 'events',
      header: 'Events',
      cell: (hook) => (
        <Row wrap>
          {hook.events.length === 0 ? <span className="nx-hint">all</span> : hook.events.map((event) => <Chip key={event}>{event}</Chip>)}
        </Row>
      ),
    },
    {
      key: 'status',
      header: 'Last delivery',
      cell: (hook) => (
        <Chip accent={hook.lastStatus === 'ok' ? 'green' : hook.lastStatus === null ? 'neutral' : 'red'}>
          {hook.lastStatus ?? 'never'}
        </Chip>
      ),
    },
  ];

  return (
    <>
      <PageHead subtitle="Scoped access for external agents. No client receives a database credential.">
        Integrations Gateway
      </PageHead>

      {!canManage && (
        <Alert accent="amber">You need the integration management permission to see or change tokens.</Alert>
      )}

      <Grid cols={4}>
        <Stat value={active.length} label="Active tokens" />
        <Stat value={clients.length} label="Tokens total" />
        <Stat value={tools.length} label="MCP tools" />
        <Stat value={webhooks.length} label="Webhooks" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Alert accent="indigo" title="How external access works">
        An agent presents a scoped service token. Every tool call is checked against the token&apos;s scopes
        <em> and </em> its business allow-list, then runs through the same row-level security a signed-in
        person gets. Tokens are stored only as a SHA-256 hash, so a leaked database yields no usable
        credential. There is no tool that executes SQL.
      </Alert>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {canManage && (
        <Grid split>
          <Card title="Service tokens" actions={<Chip accent="indigo">{active.length} active</Chip>}>
            <DataTable
              columns={clientColumns}
              rows={clients}
              rowKey={(client) => client.id}
              caption="Service tokens"
              empty={
                <EmptyState
                  title="No tokens yet"
                  body="Issue a token for an agent, then copy it immediately — it cannot be shown again."
                />
              }
            />
          </Card>

          <Card title="Issue a service token">
            <ApiClientForm
              businesses={context.businesses.map((business) => ({ value: business.id, label: business.name }))}
            />
          </Card>
        </Grid>
      )}

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Grid cols={2}>
        <Card title="MCP tools" actions={<Chip>{tools.length}</Chip>}>
          <p className="nx-hint" style={{ marginBottom: 'var(--nx-space-sm)' }}>
            Every tool is intent-level. There is no query tool and no SQL parameter anywhere in the contract.
          </p>
          <DataTable
            columns={[
              { key: 'name', header: 'Tool', cell: (tool) => <span className="nx-table__mono">{tool.name}</span> },
              { key: 'scope', header: 'Required scope', cell: (tool) => <Chip>{tool.scope}</Chip> },
            ]}
            rows={tools}
            rowKey={(tool) => tool.name}
            caption="Available MCP tools"
          />
        </Card>

        {canManage && (
          <Card title="Webhooks" actions={<Chip>{webhooks.length}</Chip>}>
            <DataTable
              columns={webhookColumns}
              rows={webhooks}
              rowKey={(hook) => hook.id}
              caption="Webhook endpoints"
              empty={<span className="nx-hint">No webhook endpoints configured.</span>}
            />
          </Card>
        )}
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="Deliberately absent">
        <ul className="nx-stack nx-stack--sm" style={{ margin: 0, paddingLeft: 'var(--nx-space-lg)' }}>
          <li>No tool that executes arbitrary SQL, and no <span className="nx-table__mono">database.execute_sql</span>.</li>
          <li>No Supabase service-role key in the browser, the extension, or any agent.</li>
          <li>Google Sheets is an optional import/export adapter, never canonical CRM storage.</li>
          <li>Apollo enrichment and paid credits stay off unless explicitly enabled.</li>
        </ul>
      </Card>
    </>
  );
}
