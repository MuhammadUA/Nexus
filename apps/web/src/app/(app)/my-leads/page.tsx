import type { ReactNode } from 'react';

import { Card, Chip, DataTable, EmptyState, LeadStatusChip, PageHead, Row, type Column } from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import {
  listIcpOptions,
  listIdentityOptions,
  listLeads,
  type LeadListItem,
} from '@/lib/repo/leads';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly business?: string;
  readonly icp?: string;
  readonly identity?: string;
  readonly status?: string;
  readonly source?: string;
  readonly owner?: string;
  readonly q?: string;
  readonly sort?: string;
  readonly page?: string;
  readonly view?: string;
  readonly 'view-saved'?: string;
  readonly 'view-error'?: string;
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
 * U05 — My Leads.
 *
 * Contract: "Only authorized/assigned leads; business/ICP/identity/status/saved-view/
 * sort filters; add lead; Trash."
 *
 * "Only authorized/assigned leads" is **not** implemented here as an owner filter:
 * `public.lead_scope_allows` in the `leads_select` policy already restricts the rows to
 * the viewer's `all` / `assigned` / `own` scope, so adding a `where owner_user_id = …`
 * in application code would be a second, weaker copy of the authorization rule. The
 * screen passes no owner predicate.
 *
 * Filters live in the URL, so a filtered list is shareable, survives a refresh, and is
 * restorable — which is also what a saved view stores.
 */
export default async function MyLeadsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const context = await loadViewerContext();

  if (context.businesses.length === 0) {
    return (
      <>
        <PageHead subtitle="Leads assigned to you, across the businesses you can see.">My Leads</PageHead>
        <Card>
          <EmptyState
            title="No businesses yet"
            body="An administrator has not granted you access to a business yet."
          />
        </Card>
      </>
    );
  }

  const requested = context.businesses.find((business) => business.id === query.business);
  const business = requested ?? context.businesses[0];
  if (business === undefined) {
    return (
      <Card>
        <EmptyState title="No businesses yet" body="Ask an administrator for business access." />
      </Card>
    );
  }

  const page = Math.max(Number(query.page ?? '1') || 1, 1);
  const sort = parseSort(query.sort);

  const filter = {
    businessId: business.id,
    ...(query.icp === undefined || query.icp.length === 0 ? {} : { icpId: query.icp }),
    ...(query.identity === undefined || query.identity.length === 0 ? {} : { identityId: query.identity }),
    ...(query.status === undefined || query.status.length === 0 ? {} : { status: query.status }),
    ...(query.source === undefined || query.source.length === 0 ? {} : { sourceType: query.source }),
    ...(query.q === undefined || query.q.trim().length === 0 ? {} : { search: query.q }),
    sort,
  };

  const [leads, icps, identities] = await Promise.all([
    listLeads(context.viewer.actor, filter, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    listIcpOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
  ]);

  const columns: readonly Column<LeadListItem>[] = [
    {
      key: 'person',
      header: 'Person',
      cell: (lead) => (
        <div className="nx-stack nx-stack--sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`/leads/${lead.id}`}>
            <strong>{lead.personName}</strong>
          </a>
          {lead.jobTitle !== null && <span className="nx-hint">{lead.jobTitle}</span>}
        </div>
      ),
    },
    { key: 'company', header: 'Company', cell: (lead) => lead.companyName ?? <span className="nx-hint">—</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (lead) => (
        <Row wrap>
          <LeadStatusChip state={lead.status} />
          {lead.isDnc && <Chip accent="red">DNC</Chip>}
          {lead.needsProfile && <Chip accent="cyan">needs profile</Chip>}
        </Row>
      ),
    },
    {
      key: 'icp',
      header: 'Primary ICP',
      cell: (lead) => lead.primaryIcpName ?? <span className="nx-hint">—</span>,
    },
    {
      key: 'sender',
      header: 'Sender',
      // spec `identity_model.outreach_identity.rule`: owner and sender are separate.
      cell: (lead) => lead.identityName ?? <span className="nx-hint">not bound</span>,
    },
    {
      key: 'actions',
      header: '',
      cell: (lead) => (
        <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/leads/${lead.id}`}>•••</a>
      ),
    },
  ];

  const totalPages = Math.max(Math.ceil(leads.total / PAGE_SIZE), 1);

  return (
    <>
      <PageHead
        subtitle="Assigned leads only"
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href="/trash">
              Trash
            </a>
            <a className="nx-btn nx-btn--primary" href="/my-lead-sources">+ Lead</a>
          </Row>
        }
      >
        My Leads
      </PageHead>

      <form className="nx-figma-filter-row" action="/my-leads">
        <FigmaSelect label="Business" name="business" value={business.id} options={context.businesses.map((item) => ({ value: item.id, label: item.name.split(' ')[0] ?? item.name }))} />
        <FigmaSelect label="ICP" name="icp" value={query.icp ?? ''} empty="All ICPs" options={icps} />
        <FigmaSelect label="LinkedIn" name="identity" value={query.identity ?? ''} empty="All assigned" options={identities} />
        <FigmaSelect label="Saved view" name="view" value={query.view ?? ''} empty="Assigned" options={[]} />
        <FigmaSelect label="Sort" name="sort" value={sort} options={[
          { value: 'next_action', label: 'Next action' },
          { value: 'recent_activity', label: 'Recent activity' },
          { value: 'name', label: 'Name' },
        ]} />
        <button type="submit" className="nx-visually-hidden">Apply filters</button>
      </form>

      <div className="nx-figma-status-row">
        <Chip>NEW</Chip><Chip accent="amber">FOLLOW-UPS</Chip><Chip accent="green">REPLIED</Chip>
        <Chip accent="cyan">NEEDS PROFILE</Chip><Chip>DORMANT</Chip>
      </div>

      <div className="nx-figma-bulk-row"><button className="nx-btn nx-btn--secondary" type="button">Bulk actions</button><span>□ Select</span></div>

      <Card className="nx-figma-leads-table">
        <DataTable
          columns={columns}
          rows={leads.items.slice(0, 5)}
          rowKey={(lead) => lead.id}
          caption="Leads assigned or visible to you in this business"
          empty={
            <EmptyState
              title="No leads match these filters"
              body="Adjust the filters, or add leads from your Lead Sources."
              action={
                <a className="nx-btn nx-btn--primary" href="/my-lead-sources">
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
              <a className="nx-btn nx-btn--secondary nx-btn--sm" href={pageHref(query, page - 1)}>
                Previous
              </a>
            )}
            {page < totalPages && (
              <a className="nx-btn nx-btn--secondary nx-btn--sm" href={pageHref(query, page + 1)}>
                Next
              </a>
            )}
          </div>
        )}
      </Card>

    </>
  );
}

function FigmaSelect({ label, name, value, options, empty }: { readonly label: string; readonly name: string; readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly empty?: string }): ReactNode {
  return <label className="nx-field"><span className="nx-label">{label}</span><select className="nx-select" name={name} defaultValue={value}>{empty !== undefined && <option value="">{empty}</option>}{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

/**
 * The current query string, so a saved view replays exactly this list.
 *
 * `Object.entries` on a declared search-params interface widens each value to `any`,
 * so every value is narrowed before it reaches `URLSearchParams` — a non-string there
 * would silently become `"[object Object]"` in a stored view.
 */
function buildSearch(query: SearchParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'view' || key === 'view-saved' || key === 'view-error') continue;
    if (typeof value === 'string' && value.length > 0) search.set(key, value);
  }
  return search.toString();
}

function pageHref(query: SearchParams, page: number): string {
  const search = new URLSearchParams(buildSearch(query));
  search.set('page', String(page));
  return `/my-leads?${search.toString()}`;
}
