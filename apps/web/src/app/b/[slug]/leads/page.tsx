import type { ReactNode } from 'react';

import { Card, Chip, DataTable, EmptyState, LeadStatusChip, PageHead, type Column } from '@nexus/ui';
import { notFound } from 'next/navigation';

import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';
import {
  listIcpOptions,
  listIdentityOptions,
  listLeads,
  listOwnerOptions,
  type LeadListItem,
} from '@/lib/repo/leads';

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
      return 'next_action';
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

  const [leads, icps, identities, owners] = await Promise.all([
    listLeads(context.viewer.actor, filter, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
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
    { key: 'icp', header: 'Primary ICP', cell: (lead) => lead.primaryIcpName ?? '—' },
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
      key: 'source',
      header: 'Source',
      cell: (lead) => lead.sourceType?.replace(/_/g, ' ') ?? '—',
    },
    { key: 'actions', header: '', cell: (lead) => <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/b/${business.key}/leads/${lead.id}`}>•••</a> },
  ];

  const totalPages = Math.max(Math.ceil(leads.total / PAGE_SIZE), 1);

  return (
    <>
      <PageHead
        subtitle="One active lead per person + business"
        actions={
          <>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/trash`}>
              Trash
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>Lead Sources</a>
            <a className="nx-btn nx-btn--primary" href={`/b/${business.key}/lead-sources`}>+ Lead</a>
          </>
        }
      >
        Leads
      </PageHead>

      <form className="nx-admin-filter-row" action={`/b/${business.key}/leads`}>
        <FilterSelect label="ICP" name="icp" value={query.icp ?? ''} empty="All ICPs" options={icps} />
        <FilterSelect label="Owner" name="owner" value={query.owner ?? ''} empty="All owners" options={owners} />
        <FilterSelect label="Sender" name="identity" value={query.identity ?? ''} empty="All identities" options={identities} />
        <FilterSelect label="Status" name="status" value={query.status ?? ''} empty="All active" options={[]} />
        <FilterSelect label="Saved view" name="sort" value={sort} options={[{ value: 'next_action', label: 'Needs attention' }, { value: 'recent_activity', label: 'Recent activity' }]} />
        <button className="nx-visually-hidden" type="submit">Apply filters</button>
      </form>
      <div className="nx-figma-status-row"><Chip accent="amber">FOLLOW-UPS</Chip><Chip accent="green">REPLIED</Chip><Chip accent="cyan">NEEDS PROFILE</Chip><Chip>DORMANT</Chip><Chip accent="red">DNC</Chip></div>

      <Card className="nx-admin-leads-table">
        <DataTable
          columns={columns}
          rows={leads.items.slice(0, 5)}
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

        <div className="nx-admin-bulk"><strong>Bulk actions</strong><span>Assign owner · Change Primary ICP · Change sender · Archive · Delete</span></div>

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

function FilterSelect({ label, name, value, options, empty }: { readonly label: string; readonly name: string; readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly empty?: string }): ReactNode {
  return <label className="nx-field"><span className="nx-label">{label}</span><select className="nx-select" name={name} defaultValue={value}>{empty !== undefined && <option value="">{empty}</option>}{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
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
