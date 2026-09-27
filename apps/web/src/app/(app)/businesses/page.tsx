import type { ReactNode } from 'react';

import { Card, Chip, DataTable, Grid, PageHead, Stat, type Column } from '@nexus/ui';

import { BusinessLifecycleMenu } from '@/components/business-lifecycle-forms';
import { loadViewerContext } from '@/lib/viewer-context';
import { requireRouteAccess } from '@/lib/route-guard';
import { listBusinessSummaries, type BusinessSummary } from '@/lib/repo/businesses';

import './businesses.css';

export const dynamic = 'force-dynamic';

/**
 * A10 — Businesses Hub.
 *
 * Contract: "Create/manage business contexts; scratch/clone/template; no
 * lead/history cloning."
 *
 * RLS decides what appears here: an admin sees every business, a user sees the ones
 * granted to them.
 *
 * This is also the lifecycle screen, which is why archived businesses are listed here while
 * `listBusinesses()` keeps them out of the sidebar, the switcher and the Companion selector. Archive,
 * restore and the guarded permanent delete are `business.create` (admin-only) and are enforced again
 * inside each Server Action — the controls below are rendered only for a viewer who holds it, and that
 * hiding is convenience, not security.
 */
export default async function BusinessesPage(): Promise<ReactNode> {
  const context = await loadViewerContext();
  // Configuration surface: refused before the repository is touched, so a user without
  // `business.create` cannot even learn the shape of the hub.
  requireRouteAccess(context, { route: '/businesses' });

  const canManage = context.permissions.has('business.create');
  // `includeArchived` here and nowhere else: an archived business must leave the *active selectors*,
  // which `listBusinesses` implements, but it must remain reachable so it can be restored.
  const businesses = await listBusinessSummaries(context.viewer.actor, { includeArchived: true });
  const active = businesses.filter((business) => business.status !== 'archived');
  const archivedCount = businesses.length - active.length;

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
    {
      key: 'lifecycle',
      header: '',
      width: '11rem',
      // The row-level overflow menu: Archive (with an optional reason), Restore for an archived
      // business, and the typed-key guarded permanent delete. Each control posts to its own Server
      // Action; a refusal comes back typed and is rendered from its code.
      cell: (business) =>
        canManage ? (
          <BusinessLifecycleMenu
            businessId={business.id}
            businessKey={business.key}
            businessName={business.name}
            status={business.status}
          />
        ) : null,
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
        <Stat
          value={active.length}
          label="Active businesses"
          meta={archivedCount === 0 ? 'none archived' : `${String(archivedCount)} archived`}
        />
        <Stat value={active.reduce((sum, b) => sum + b.leadCount, 0)} label="Total leads" />
        <Stat value={active.reduce((sum, b) => sum + b.profileQueueCount, 0)} label="Profile queue" />
        <Stat value={active.reduce((sum, b) => sum + b.domainCount, 0)} label="Registered domains" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <Card
        title="All businesses"
        actions={archivedCount === 0 ? undefined : <Chip>{archivedCount} archived</Chip>}
        footer={
          <span className="nx-hint">
            An archived business is listed here so it can be restored, and is deliberately absent from the sidebar,
            the business switcher and the Companion selector. Permanent deletion is offered only for a business that
            owns no history; when the server refuses it, the counts and the Archive alternative are shown in place.
          </span>
        }
      >
        <DataTable
          columns={columns}
          rows={businesses}
          rowKey={(business) => business.id}
          caption="Businesses visible to you, including archived ones you may restore"
          empty={<span className="nx-hint">No businesses yet.</span>}
        />
      </Card>
    </>
  );
}
