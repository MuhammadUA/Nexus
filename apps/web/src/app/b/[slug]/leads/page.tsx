import { cloneElement, createElement, isValidElement, type ReactNode } from 'react';

import {
  Card,
  Chip,
  DataTable,
  EmptyState,
  Field,
  LeadStatusChip,
  PageHead,
  Row,
  VisuallyHidden,
  type Column,
} from '@nexus/ui';
import { notFound, redirect } from 'next/navigation';

import { LeadBulkBar } from '@/components/lead-bulk-actions';
import { LeadFilterBar } from '@/components/lead-filter-bar';
import { LeadRowMenu } from '@/components/lead-row-menu';
import { PAGE_SIZE_PARAM, filterHref, pageHref } from '@/lib/filter-url';
import { listSavedViews, viewHref } from '@/lib/repo/saved-views';
import {
  NEEDS_ATTENTION_STATUSES,
  getLeadCounts,
  listIcpOptions,
  listIdentityOptions,
  listLeads,
  listOwnerOptions,
  type LeadCounts,
  type LeadFilter,
  type LeadListItem,
} from '@/lib/repo/leads';
import { loadViewerContext, resolveBusiness } from '@/lib/viewer-context';

import './leads.css';

export const dynamic = 'force-dynamic';

/**
 * The query string this screen reads.
 *
 * Carries an index signature as well as the named keys: every filter belongs in the URL,
 * and both the pager and the filter controls rebuild a link from whatever is in it, so
 * the page has to be able to read a key it did not enumerate.
 */
export type LeadsSearchParams = {
  readonly [key: string]: string | undefined;
  readonly icp?: string;
  readonly identity?: string;
  readonly status?: string;
  readonly source?: string;
  readonly owner?: string;
  readonly ownerNone?: string;
  readonly q?: string;
  readonly sort?: string;
  readonly view?: string;
  readonly needsProfile?: string;
  readonly dnc?: string;
  readonly followups?: string;
  readonly needsAttention?: string;
  readonly page?: string;
  readonly pageSize?: string;
};

/** Rows per page unless the URL asks otherwise. */
const DEFAULT_PAGE_SIZE = 25;

/**
 * Bounds on the `pageSize` override.
 *
 * The upper bound is a load guard rather than a product rule: 100 rows still render
 * quickly, and anything larger is a hand-edited URL rather than a screen anyone asked for.
 */
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;

/** The id shared by the bulk form and the row checkboxes that submit into it. */
const BULK_FORM_ID = 'leads-bulk-form';

/** The quick-filter keys a chip replaces, so two chips cannot both read as "on". */
const CHIP_KEYS = ['status', 'needsProfile', 'dnc', 'followups', 'needsAttention', 'view'] as const;

function parseSort(
  value: string | undefined,
): 'recent_activity' | 'name' | 'company' | 'next_action' | 'created' {
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

/**
 * The page size the URL asks for, clamped.
 *
 * This exists so the pager can be exercised and verified at a size smaller than the
 * seeded result set. With 25 rows per page a business of a couple of dozen leads has
 * exactly one page, and a one-page pager proves nothing about whether the records beyond
 * the first page are reachable; `pageSize=5` makes a gap or a duplicate visible.
 */
function parsePageSize(value: string | undefined): number {
  const parsed = Number(value ?? String(DEFAULT_PAGE_SIZE));
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(parsed), MIN_PAGE_SIZE), MAX_PAGE_SIZE);
}

/** True when a boolean-ish flag param is present and not explicitly switched off. */
function flagged(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/** Human label for a stored `source_type`, e.g. `google_search` -> `Google Search`. */
function humaniseSource(sourceType: string | null): string {
  if (sourceType === null || sourceType.trim().length === 0) return '—';
  return sourceType
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * A03 — Leads.
 *
 * Contract: "Admin lead table with filters, bulk actions, owner/sender/ICP/source/
 * status, add lead, lead sources, Trash."
 *
 * Composition follows the live Figma frame (node 3:121): page head, action buttons, five
 * filter selects, a status-chip quick-filter row with real counts, the eight-column table
 * and the bulk-actions bar. Every value on the screen comes from the database; there is
 * no sample text in this file.
 *
 * Filters live in the URL, so a filtered view is shareable, survives a refresh and is
 * restorable — which is also what lets the Companion restore an exact list state.
 */
export default async function LeadsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<LeadsSearchParams>;
}): Promise<ReactNode> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const context = await loadViewerContext();
  const business = resolveBusiness(context, slug);
  if (business === null) notFound();

  const page = Math.max(Number(query.page ?? '1') || 1, 1);
  const pageSize = parsePageSize(query.pageSize);
  const sort = parseSort(query.sort);
  const needsAttention = flagged(query.needsAttention);

  const filter: LeadFilter = {
    businessId: business.id,
    ...(query.icp === undefined || query.icp.length === 0 ? {} : { icpId: query.icp }),
    ...(query.identity === undefined || query.identity.length === 0
      ? {}
      : { identityId: query.identity }),
    ...(query.status === undefined || query.status.length === 0 ? {} : { status: query.status }),
    ...(query.source === undefined || query.source.length === 0 ? {} : { sourceType: query.source }),
    // An explicit owner id wins; "unassigned" is `null`, which is a filter of its own
    // rather than the absence of one.
    ...(query.owner !== undefined && query.owner.length > 0
      ? { ownerUserId: query.owner }
      : flagged(query.ownerNone)
        ? { ownerUserId: null }
        : {}),
    ...(query.q === undefined || query.q.trim().length === 0 ? {} : { search: query.q }),
    ...(flagged(query.needsProfile) ? { needsProfileOnly: true } : {}),
    ...(flagged(query.dnc) ? { dncOnly: true } : {}),
    ...(flagged(query.followups) ? { followupsOnly: true } : {}),
    ...(needsAttention ? { statusesIn: NEEDS_ATTENTION_STATUSES } : {}),
    sort,
  };

  const [leads, counts, icps, identities, owners, savedViews] = await Promise.all([
    listLeads(context.viewer.actor, filter, { limit: pageSize, offset: (page - 1) * pageSize }),
    getLeadCounts(context.viewer.actor, business.id),
    listIcpOptions(context.viewer.actor, business.id),
    listIdentityOptions(context.viewer.actor, business.id),
    listOwnerOptions(context.viewer.actor, business.id),
    listSavedViews(context.viewer.actor, business.id, 'leads', context.viewer.userId),
  ]);

  const basePath = `/b/${business.key}/leads`;
  const totalPages = Math.max(Math.ceil(leads.total / pageSize), 1);

  /**
   * A page past the end is corrected rather than rendered empty.
   *
   * Rendering the empty state for `page=6` of a five-page result is indistinguishable
   * from a filter that matches nothing, so the operator cannot tell "you overshot" from
   * "there is nothing here" — and an unreachable-tail defect would present as an ordinary
   * empty result set.
   */
  if (page > totalPages) redirect(pageHref(basePath, query, totalPages));

  /**
   * Whether the viewer may write leads in *this* business.
   *
   * The row menu uses it to decide between offering Archive/Move to Trash and not
   * rendering them. The server action re-checks the fine-grained permission per
   * operation, so this only controls what is offered, never what is allowed.
   */
  const canWriteLeads = context.permissions.has('lead.update');

  /**
   * The row selection control.
   *
   * The checkbox has to submit into the bulk form, which is a different `<form>` element
   * (a form cannot nest inside another). Cloning the input with a `form` attribute is
   * what lets the row control and the bulk buttons agree on what is selected without a
   * client-side copy of the list.
   */
  function selectionCell(lead: LeadListItem): ReactNode {
    const input = createElement('input', {
      type: 'checkbox',
      name: 'leadIds',
      value: lead.id,
      'aria-label': `Select ${lead.personName}`,
    });

    const withForm = isValidElement<{ form?: string }>(input)
      ? cloneElement(input, { form: BULK_FORM_ID })
      : input;

    return <div className="nx-stack nx-stack--sm">{withForm}</div>;
  }

  const columns: readonly Column<LeadListItem>[] = [
    {
      key: 'select',
      header: <VisuallyHidden>Select</VisuallyHidden>,
      width: '34px',
      cell: (lead) => selectionCell(lead),
    },
    {
      key: 'person',
      header: 'Person',
      cell: (lead) => (
        <div className="nx-stack nx-stack--sm">
          <a className="nx-nav__item" style={{ padding: 0 }} href={`${basePath}/${lead.id}`}>
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
      cell: (lead) => (
        <span title={lead.sourceUrl ?? lead.sourceType ?? undefined}>
          {humaniseSource(lead.sourceType)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <VisuallyHidden>Actions</VisuallyHidden>,
      width: '48px',
      cell: (lead) => (
        <LeadRowMenu
          businessSlug={business.key}
          leadId={lead.id}
          personName={lead.personName}
          canArchive={canWriteLeads}
          canDelete={canWriteLeads}
        />
      ),
    },
  ];

  return (
    <>
      <PageHead
        subtitle={`One active lead per person · ${business.name}`}
        actions={
          <Row wrap>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/trash`}>
              Trash
            </a>
            <a className="nx-btn nx-btn--secondary" href={`/b/${business.key}/lead-sources`}>
              Lead Sources
            </a>
            <a className="nx-btn nx-btn--primary" href={`/b/${business.key}/lead-sources`}>
              + Lead
            </a>
          </Row>
        }
      >
        Leads
      </PageHead>

      {/* The frame puts the search field in the head, beside the title block. */}
      <form
        className="nx-inline-form"
        action={basePath}
        method="get"
        style={{ marginBottom: 'var(--nx-space-lg)' }}
      >
        {query.pageSize === undefined ? null : (
          <input type="hidden" name={PAGE_SIZE_PARAM} value={String(pageSize)} />
        )}
        <Field label="Search" htmlFor="leads-search">
          <input
            id="leads-search"
            className="nx-input"
            type="search"
            name="q"
            defaultValue={query.q ?? ''}
            placeholder="Search leads…"
            style={{ maxWidth: '320px' }}
          />
        </Field>
        <button className="nx-btn nx-btn--secondary" type="submit">
          Search
        </button>
        <span className="nx-hint">
          {String(leads.total)} matching lead{leads.total === 1 ? '' : 's'}
        </span>
      </form>

      <StatusChips counts={counts} basePath={basePath} query={query} />

      <div style={{ height: 'var(--nx-space-md)' }} />

      <LeadFilterBar
        action={basePath}
        query={query}
        current={{
          icp: query.icp ?? '',
          owner: query.owner ?? '',
          identity: query.identity ?? '',
          status: query.status ?? '',
          source: query.source ?? '',
          q: query.q ?? '',
          sort,
          view: query.view ?? '',
          ownerNone: flagged(query.ownerNone),
        }}
        icps={icps}
        owners={owners}
        identities={identities}
        savedViews={savedViews.map((view) => ({
          value: view.id,
          label: view.name,
          href: viewHref(basePath, view),
        }))}
        needsAttentionHref={filterHref(basePath, query, {
          clear: ['status', 'view', 'needsProfile', 'dnc', 'followups'],
          set: { needsAttention: '1' },
        })}
      />

      <div style={{ height: 'var(--nx-space-md)' }} />

      {/*
        The bulk form element belongs to the bar under the table; the table's checkboxes
        submit into it through their `form` attribute, so the two are one control group
        without a nested `<form>`.
      */}
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

        <div className="nx-card__footer">
          <span className="nx-hint">
            {leads.total === 0
              ? 'No matching leads'
              : `Showing ${String(leads.offset + 1)}–${String(
                  leads.offset + leads.items.length,
                )} of ${String(leads.total)} · page ${String(page)} of ${String(totalPages)} · ${String(
                  pageSize,
                )} per page`}
          </span>
          {page > 1 && (
            <a
              className="nx-btn nx-btn--secondary nx-btn--sm"
              href={pageHref(basePath, query, page - 1)}
            >
              Previous
            </a>
          )}
          {page < totalPages && (
            <a
              className="nx-btn nx-btn--secondary nx-btn--sm"
              href={pageHref(basePath, query, page + 1)}
            >
              Next
            </a>
          )}
        </div>
      </Card>

      <div style={{ height: 'var(--nx-space-md)' }} />

      <LeadBulkBar
        businessSlug={business.key}
        formId={BULK_FORM_ID}
        owners={owners}
        icps={icps}
        identities={identities}
        canAssignOwner={context.permissions.has('lead.assign_owner')}
        canChangeIcp={context.permissions.has('lead.change_primary_icp')}
        canChangeSender={context.permissions.has('lead.change_sender_identity')}
        canArchive={context.permissions.has('lead.archive')}
        canDelete={context.permissions.has('lead.soft_delete')}
      />
    </>
  );
}

/**
 * The quick-filter chip row.
 *
 * Each chip is a real link that sets exactly one filter key, so the count a chip shows
 * and the list it opens come from the same predicate in the repository. Every count is a
 * `getLeadCounts` aggregate over the database — never a literal.
 */
function StatusChips({
  counts,
  basePath,
  query,
}: {
  readonly counts: LeadCounts;
  readonly basePath: string;
  readonly query: LeadsSearchParams;
}): ReactNode {
  function chip(
    key: string,
    label: string,
    count: number,
    accent: string,
    active: boolean,
  ): ReactNode {
    return (
      <a
        key={`${key}-${label}`}
        className={`nx-chip-link${accent.length === 0 ? '' : ` nx-chip-link--${accent}`}`}
        href={filterHref(basePath, query, { clear: CHIP_KEYS, set: { [key]: '1' } })}
        aria-current={active ? 'true' : undefined}
        title={`${label}: ${String(count)} lead${count === 1 ? '' : 's'}`}
      >
        {label}
        <span className="nx-chip-link__count">{count}</span>
      </a>
    );
  }

  return (
    <div className="nx-chip-strip" role="group" aria-label="Quick filters">
      {chip('followups', 'Follow-ups', counts.followups, 'amber', flagged(query.followups))}
      {chip('status', 'Replied', counts.replied, 'green', query.status === 'replied')}
      {chip(
        'needsProfile',
        'Needs profile',
        counts.needsProfile,
        'cyan',
        flagged(query.needsProfile),
      )}
      {chip('status', 'Dormant', counts.dormant, '', query.status === 'dormant')}
      {chip('dnc', 'DNC', counts.dnc, 'red', flagged(query.dnc))}
    </div>
  );
}
