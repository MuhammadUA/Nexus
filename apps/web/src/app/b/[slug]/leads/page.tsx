import type { ReactNode } from 'react';

import { Card, Chip, DataTable, EmptyState, Grid, LeadStatusChip, PageHead, Stat, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import {
  getLeadCounts,
  listIcpOptions,
  listIdentityOptions,
  listLeads,
  listOwnerOptions,
  type LeadListItem,
} from '@/lib/repo/leads';
import { LeadFilterBar } from '@/components/lead-filter-bar';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly icp?: string;
  readonly identity?: string;
  readonly status?: string;
  readonly source?: string;
  readonly owner?: string;
  readonly q?: string;
  readonly sort?: string;
  readonly page?: string;
}

function parseSort(value: string | undefined): 'recent_activity' | 'name' | 'company' | 'next_action' | 'created' {
  switch (value) {
    case 'name':
    case 'company':
    case 'next_action':
    case 'created':
    case 'recent_activity':
      return value;
    default:
      return 'recent_activity';
  }
}

const PAGE_SIZE = 25;

/**
 * A03 — Leads.
 *
 * Contract: "Admin lead table with filters, bulk actions, owner/sender/ICP/source/
 * status, add lead, lead sources, Trash."
 *
 * Filters live in the URL, so a filtered view is shareable and survives a refresh —
 * which is also what lets the Companion restore an exact list state.
 */
export default async function LeadsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const page = Math.max(Number(query.page ?? '1') || 1, 1);
  const sort = parseSort(query.sort);

  const filter = {
    businessId: business.id,
    ...(query.icp === undefined || query.icp.length === 0 ? {} : { icpId: query.icp }),
    ...(query.identity === undefined || query.identity.length === 0 ? {} : { identityId: query.identity }),
    ...(query.status === undefined || query.status.length === 0 ? {} : { status: query.status }),
    ...(query.source === undefined || query.source.length === 0 ? {} : { sourceType: query.source }),
    ...(query.owner === undefined || query.owner.length === 0 ? {} : { ownerUserId: query.owner }),
    ...(query.q === undefined || query.q.trim().length === 0 ? {} : { search: query.q }),
    sort,
  };

  const [leads, counts, icps, identities, owners] = await Promise.all([
    listLeads(context.viewer.actor, filter, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    getLeadCounts(context.viewer.actor, business.id),
    listIcpOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
    listOwnerOptions(context.viewer.actor, business.id),
  ]);

  const columns: readonly Column<LeadListItem>[] = [
    {
      key: 'person',
      header: 'Person',
      cell: (lead) => (
        <div className="nx-stack nx-stack--sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/b/${business.key}/leads/${lead.id}`}>
            <strong>{lead.personName}</strong>
          </a>
          {lead.jobTitle !== null && <span className="nx-hint">{lead.jobTitle}</span>}
        </div>
      ),
    },
    {
      key: 'company',
      header: 'Company',
      cell: (lead) => lead.companyName ?? <span className="nx-hint">—</span>,
    },
    {
      key: 'icp',
      header: 'Primary ICP',
      cell: (lead) =>
        lead.primaryIcpName === null ? (
          <Chip accent="amber">unmatched</Chip>
        ) : (
          <Chip accent="indigo">{lead.primaryIcpName}</Chip>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (lead) => (
        <div className="nx-row nx-row--wrap">
          <LeadStatusChip state={lead.status} />
          {lead.isDnc && <Chip accent="red">DNC</Chip>}
          {lead.needsProfile && <Chip accent="cyan">needs profile</Chip>}
        </div>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      cell: (lead) => lead.ownerName ?? <span className="nx-hint">unassigned</span>,
    },
    {
      key: 'sender',
      header: 'Sender',
      // spec `identity_model.outreach_identity.rule`: the CRM lead owner and the
      // LinkedIn sender identity are separate dimensions, shown separately.
      cell: (lead) => lead.identityName ?? <span className="nx-hint">not bound</span>,
    },
    {
      key: 'next',
      header: 'Next action',
      cell: (lead) =>
        lead.nextActionAt === null ? (
          <span className="nx-hint">—</span>
        ) : (
          <span className="nx-table__mono">{lead.nextActionAt.slice(0, 10)}</span>
        ),
    },
  ];

  const totalPages = Math.max(Math.ceil(leads.total / PAGE_SIZE), 1);

  return (
    <>
      <PageHead
        subtitle={`${String(leads.total)} lead${leads.total === 1 ? '' : 's'} in ${business.name}`}
        actions={
          <>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>
              Lead sources
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/trash`}>
              Trash
            </a>
          </>
        }
      >
        Leads
      </PageHead>

      <Grid cols={4}>
        <Stat value={counts.total} label="Total leads" />
        <Stat value={counts.needsProfile} label="Needs profile" />
        <Stat value={counts.replied} label="Replied" />
        <Stat value={counts.dnc} label="Do Not Contact" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      <LeadFilterBar
        action={`/b/${business.key}/leads`}
        icps={icps}
        identities={identities}
        owners={owners}
        current={{
          icp: query.icp ?? '',
          identity: query.identity ?? '',
          status: query.status ?? '',
          source: query.source ?? '',
          q: query.q ?? '',
          sort,
        }}
      />

      <div style={{ height: 'var(--nx-space-md)' }} />

      <Card>
        <DataTable
          columns={columns}
          rows={leads.items}
          rowKey={(lead) => lead.id}
          caption="Leads visible to you in this business"
          empty={
            <EmptyState
              title="No leads match these filters"
              body="Adjust the filters, or add leads from Lead Sources."
              action={
                <a className="nx-btn nx-btn--primary" href={`/b/${business.key}/lead-sources`}>
                  Open Lead Sources
                </a>
              }
            />
          }
        />

        {totalPages > 1 && (
          <div className="nx-card__footer">
            <span className="nx-hint">
              Page {page} of {totalPages}
            </span>
            {page > 1 && (
              <a className="nx-btn nx-btn--secondary nx-btn--sm" href={pageHref(business.key, query, page - 1)}>
                Previous
              </a>
            )}
            {page < totalPages && (
              <a className="nx-btn nx-btn--secondary nx-btn--sm" href={pageHref(business.key, query, page + 1)}>
                Next
              </a>
            )}
          </div>
        )}
      </Card>
    </>
  );
}

/**
 * Builds a page link that preserves the current filters.
 *
 * Values are narrowed before reaching `URLSearchParams`: `Object.entries` on the
 * search-params interface widens them, and a non-string would end up in the URL as
 * `"[object Object]"`.
 */
function pageHref(slug: string, query: SearchParams, page: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key !== 'page' && typeof value === 'string' && value.length > 0) search.set(key, value);
  }
  search.set('page', String(page));
  return `/b/${slug}/leads?${search.toString()}`;
}
