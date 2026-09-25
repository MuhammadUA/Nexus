import type { ReactNode } from 'react';

import { Card, Chip, DataTable, Grid, PageHead, Stat, type Column } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import { listBusinessSummaries, type BusinessSummary } from '@/lib/repo/businesses';

export const dynamic = 'force-dynamic';

/**
 * A10 — Businesses Hub.
 *
 * Contract: "Create/manage business contexts; scratch/clone/template; no
 * lead/history cloning."
 *
 * RLS decides what appears here: an admin sees every business, a user sees the ones
 * granted to them.
 */
export default async function BusinessesPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  const businesses = await listBusinessSummaries(context.viewer.actor);

  const columns: readonly Column<BusinessSummary>[] = [
    {
      key: 'name',
      header: 'Business',
      cell: (business) => (
        <div className="nx-stack nx-stack--sm">
          {context.viewer.role === 'admin' ? (
            <a className="nx-nav__item" style={{ padding: 0 }} href={`/b/${business.key}/overview`}>
              <strong>{business.name}</strong>
            </a>
          ) : (
            <strong>{business.name}</strong>
          )}
          <span className="nx-hint">key: {business.key}</span>
        </div>
      ),
    },
    { key: 'focus', header: 'Focus', cell: (business) => business.focus ?? '—' },
    {
      key: 'regions',
      header: 'Regions',
      cell: (business) =>
        business.regions.length === 0 ? (
          <span className="nx-hint">—</span>
        ) : (
          <div className="nx-row nx-row--wrap">
            {business.regions.map((region) => (
              <Chip key={region}>{region}</Chip>
            ))}
          </div>
        ),
    },
    { key: 'leads', header: 'Leads', numeric: true, cell: (business) => business.leadCount },
    { key: 'queue', header: 'Profile queue', numeric: true, cell: (business) => business.profileQueueCount },
    { key: 'domains', header: 'Domains', numeric: true, cell: (business) => business.domainCount },
    {
      key: 'status',
      header: 'Status',
      cell: (business) => (
        <Chip accent={business.status === 'active' ? 'green' : 'neutral'}>{business.status}</Chip>
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle="Business contexts. Configuration can be cloned; leads and history never are."
        actions={
          context.viewer.role === 'admin' ? (
            <a className="nx-btn nx-btn--primary" href="/businesses/new">
              Add business
            </a>
          ) : null
        }
      >
        Businesses
      </PageHead>

      <Grid cols={4}>
        <Stat value={businesses.length} label="Businesses" />
        <Stat value={businesses.reduce((sum, b) => sum + b.leadCount, 0)} label="Total leads" />
        <Stat value={businesses.reduce((sum, b) => sum + b.profileQueueCount, 0)} label="Profile queue" />
        <Stat value={businesses.reduce((sum, b) => sum + b.domainCount, 0)} label="Registered domains" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card title="All businesses">
        <DataTable
          columns={columns}
          rows={businesses}
          rowKey={(business) => business.id}
          caption="Businesses visible to you"
          empty={<span className="nx-hint">No businesses yet.</span>}
        />
      </Card>
    </>
  );
}
