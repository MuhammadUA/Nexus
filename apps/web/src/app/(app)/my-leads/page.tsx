import type { ReactNode } from 'react';

import {
  Alert,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Grid,
  LeadStatusChip,
  PageHead,
  Row,
  Stack,
  Stat,
  type Column,
} from '@nexus/ui';

import { loadViewerContext } from '@/lib/viewer-context';
import {
  getLeadCounts,
  listIcpOptions,
  listIdentityOptions,
  listLeads,
  listOwnerOptions,
  type LeadListItem,
} from '@/lib/repo/leads';
import { listSavedViews, viewHref } from '@/lib/repo/saved-views';
import { LeadFilterBar } from '@/components/lead-filter-bar';
import { deleteLeadViewAction, saveLeadViewAction } from './actions';

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
      return 'recent_activity';
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
  const canFilterOwner = context.permissions.has('lead.assign_owner');

  const filter = {
    businessId: business.id,
    ...(query.icp === undefined || query.icp.length === 0 ? {} : { icpId: query.icp }),
    ...(query.identity === undefined || query.identity.length === 0 ? {} : { identityId: query.identity }),
    ...(query.status === undefined || query.status.length === 0 ? {} : { status: query.status }),
    ...(query.source === undefined || query.source.length === 0 ? {} : { sourceType: query.source }),
    ...(!canFilterOwner || query.owner === undefined || query.owner.length === 0
      ? {}
      : { ownerUserId: query.owner }),
    ...(query.q === undefined || query.q.trim().length === 0 ? {} : { search: query.q }),
    sort,
  };

  const [leads, counts, icps, identities, owners, savedViews] = await Promise.all([
    listLeads(context.viewer.actor, filter, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    getLeadCounts(context.viewer.actor, business.id),
    listIcpOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
    canFilterOwner
      ? listOwnerOptions(context.viewer.actor, business.id)
      : Promise.resolve([] as readonly { readonly value: string; readonly label: string }[]),
    listSavedViews(context.viewer.actor, business.id, 'leads', context.viewer.userId),
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
        <Row wrap>
          <LeadStatusChip state={lead.status} />
          {lead.isDnc && <Chip accent="red">DNC</Chip>}
          {lead.needsProfile && <Chip accent="cyan">needs profile</Chip>}
        </Row>
      ),
    },
    {
      key: 'sender',
      header: 'Sender identity',
      // spec `identity_model.outreach_identity.rule`: owner and sender are separate.
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
    {
      key: 'actions',
      header: '',
      cell: (lead) => (
        <Row wrap>
          <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/leads/${lead.id}/edit`}>
            Edit
          </a>
          <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/tasks/new?lead=${lead.id}`}>
            Task
          </a>
          <a className="nx-btn nx-btn--ghost nx-btn--sm" href={`/snooze?lead=${lead.id}`}>
            Snooze
          </a>
        </Row>
      ),
    },
  ];

  const totalPages = Math.max(Math.ceil(leads.total / PAGE_SIZE), 1);
  const currentSearch = buildSearch(query);

  return (
    <>
      <PageHead
        subtitle={`${String(leads.total)} lead${leads.total === 1 ? '' : 's'} you can work in ${business.name}.`}
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--primary" href="/my-lead-sources">
              Add lead
            </a>
            <a className="nx-btn nx-btn--secondary" href="/trash">
              Trash
            </a>
          </Row>
        }
      >
        My Leads
      </PageHead>

      {query['view-error'] !== undefined && (
        <Alert accent="red" role="alert" title="Saved view">
          {query['view-error']}
        </Alert>
      )}
      {query['view-saved'] !== undefined && (
        <Alert accent="green" role="status" title="Saved view">
          Saved &ldquo;{query['view-saved']}&rdquo;. It is available from the chips below.
        </Alert>
      )}

      <Grid cols={4}>
        <Stat value={counts.total} label="Leads in scope" meta="RLS-limited to your access" />
        <Stat value={counts.needsProfile} label="Needs profile" meta="work these in the Profile Queue" />
        <Stat value={counts.replied} label="Replied" />
        <Stat value={counts.deleted} label="In Trash" meta="restorable, never deleted by you" />
      </Grid>

      <div style={{ height: 'var(--nx-space-lg)' }} />

      {context.businesses.length > 1 && (
        <>
          <Card title="Business">
            <Row wrap>
              {context.businesses.map((option) => (
                <a
                  key={option.id}
                  className={
                    option.id === business.id ? 'nx-chip nx-chip--indigo' : 'nx-chip'
                  }
                  href={`/my-leads?business=${option.id}`}
                >
                  {option.name}
                </a>
              ))}
            </Row>
          </Card>
          <div style={{ height: 'var(--nx-space-md)' }} />
        </>
      )}

      <LeadFilterBar
        action="/my-leads"
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

      <Card
        title="Saved views"
        actions={
          <Row wrap>
            <Chip accent="indigo">per operator</Chip>
            {savedViews.length > 0 && <Chip>{savedViews.length} saved</Chip>}
          </Row>
        }
      >
        <Stack>
          {savedViews.length === 0 ? (
            <span className="nx-hint">
              No saved views yet. Apply filters above, then save the current list state under a name.
            </span>
          ) : (
            <Row wrap>
              {savedViews.map((view) => (
                <span key={view.id} className="nx-row">
                  <a
                    className={
                      query.view === view.id ? 'nx-chip nx-chip--cyan' : 'nx-chip'
                    }
                    href={viewHref('/my-leads', view)}
                  >
                    {view.name}
                    {view.isShared ? ' · shared' : ''}
                  </a>
                  {view.isOwn && (
                    <form action={deleteLeadViewAction}>
                      <input type="hidden" name="viewId" value={view.id} />
                      <input type="hidden" name="search" value={currentSearch} />
                      <button type="submit" className="nx-btn nx-btn--ghost nx-btn--sm">
                        Remove
                      </button>
                    </form>
                  )}
                </span>
              ))}
            </Row>
          )}

          <form action={saveLeadViewAction}>
            <input type="hidden" name="businessId" value={business.id} />
            <input type="hidden" name="search" value={currentSearch} />
            <input type="hidden" name="sort" value={sort} />
            <Row wrap>
              <label className="nx-visually-hidden" htmlFor="saved-view-name">
                Saved view name
              </label>
              <input
                id="saved-view-name"
                className="nx-input"
                style={{ maxWidth: '260px' }}
                name="name"
                placeholder="Name this view"
                maxLength={120}
                required
              />
              <label className="nx-row" style={{ gap: 'var(--nx-space-xs)' }}>
                <input type="checkbox" name="isShared" value="true" />
                <span className="nx-hint">Share with the team</span>
              </label>
              <button type="submit" className="nx-btn nx-btn--secondary">
                Save current view
              </button>
            </Row>
          </form>
          <span className="nx-hint">
            A saved view stores the exact filters and sort of this list. Saving the same name again updates it.
          </span>
        </Stack>
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />

      <Card>
        <DataTable
          columns={columns}
          rows={leads.items}
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

      {!canFilterOwner && (
        <p className="nx-hint" style={{ marginTop: 'var(--nx-space-md)' }}>
          <Chip accent="cyan">note</Chip> The owner filter appears only for operators who may assign leads; your list
          is always limited to the leads your access covers.
        </p>
      )}
    </>
  );
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
