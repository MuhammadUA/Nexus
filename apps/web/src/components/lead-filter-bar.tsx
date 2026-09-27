'use client';

/**
 * Filter controls for the admin Leads table (A03) and My Leads.
 *
 * Rebuilt against the frame's filter row — `ICP · Owner · Sender · Status · Saved view`
 * — while keeping every filter the branch already had. Each control writes its key in the
 * URL and returns to page 1, so the list stays shareable, refresh-survivable and
 * restorable; nothing that shapes the result set is held in component state.
 *
 * The controls navigate on change (`router.push`) instead of waiting for an Apply button,
 * because a labelled select that does nothing until you find a button elsewhere on the
 * screen is a control that misrepresents itself. The `<form method="get">` remains as the
 * no-JavaScript path, with a submit button that `:focus-within` reveals.
 */
import { Button, Field, Select } from '@nexus/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactElement } from 'react';

import { PAGE_SIZE_PARAM, filterHref, type SearchParamRecord } from '@/lib/filter-url';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface LeadFilterValues {
  readonly icp: string;
  readonly owner: string;
  readonly identity: string;
  readonly status: string;
  readonly source: string;
  readonly q: string;
  readonly sort: string;
  readonly view: string;
  /** True when "Owner · Unassigned" is the active owner filter. */
  readonly ownerNone: boolean;
}

export const LEAD_STATUS_OPTIONS: readonly FilterOption[] = [
  { value: 'new', label: 'New' },
  { value: 'needs_profile', label: 'Needs profile' },
  { value: 'ready', label: 'Ready' },
  { value: 'connection_due', label: 'Connection due' },
  { value: 'connection_sent', label: 'Connection sent' },
  { value: 'connection_accepted', label: 'Accepted' },
  { value: 'message_due', label: 'Message 1 due' },
  { value: 'followup_due', label: 'Follow-up due' },
  { value: 'replied', label: 'Replied' },
  { value: 'paused', label: 'Paused' },
  { value: 'cooldown', label: 'Cooldown' },
  { value: 'dormant', label: 'Dormant' },
  { value: 'reactivation_due', label: 'Reactivation due' },
  { value: 'interested', label: 'Interested' },
  { value: 'wrong_person', label: 'Wrong person' },
  { value: 'do_not_contact', label: 'Do not contact' },
  { value: 'archived', label: 'Archived' },
];

export const LEAD_SOURCE_OPTIONS: readonly FilterOption[] = [
  { value: 'manual_add', label: 'Manual add' },
  { value: 'manual_companion', label: 'Companion import' },
  { value: 'file_csv', label: 'File (CSV)' },
  { value: 'file_xlsx', label: 'File (XLSX)' },
  { value: 'paste', label: 'Pasted list' },
  { value: 'google_search', label: 'Google search' },
  { value: 'apollo', label: 'Apollo' },
  { value: 'api_ingest', label: 'API ingest' },
];

export const LEAD_SORT_OPTIONS: readonly FilterOption[] = [
  { value: 'recent_activity', label: 'Recent activity' },
  { value: 'next_action', label: 'Next action' },
  { value: 'name', label: 'Name' },
  { value: 'company', label: 'Company' },
  { value: 'created', label: 'Newest' },
];

/** The quick-filter keys a named view replaces. */
const QUICK_FILTER_KEYS = ['status', 'view', 'needsProfile', 'dnc', 'followups', 'needsAttention'] as const;

/** A saved view, already resolved to the href that reapplies it. */
export interface SavedViewOption {
  readonly value: string;
  readonly label: string;
  readonly href: string;
}

export interface LeadFilterBarProps {
  /** The list route, e.g. `/b/zemnas/leads`. */
  readonly action: string;
  /** Every search param the current screen carries, so links can preserve them. */
  readonly query: SearchParamRecord;
  readonly current: LeadFilterValues;
  readonly icps: readonly FilterOption[];
  readonly owners: readonly FilterOption[];
  readonly identities: readonly FilterOption[];
  /** Saved views for this business; omitted on screens without them. */
  readonly savedViews?: readonly SavedViewOption[];
  /** Label for the status select's empty option. */
  readonly allStatusesLabel?: string;
  /** href of the built-in "Needs attention" view, which is not a stored row. */
  readonly needsAttentionHref: string;
}

export function LeadFilterBar({
  action,
  query,
  current,
  icps,
  owners,
  identities,
  savedViews = [],
  allStatusesLabel = 'All active',
  needsAttentionHref,
}: LeadFilterBarProps): ReactElement {
  const router = useRouter();

  const go = (change: Parameters<typeof filterHref>[2]): void => {
    router.push(filterHref(action, query, change));
  };

  // Controlled locally so a control reflects the operator's choice immediately rather
  // than only after the server round trip. The URL stays the source of truth for the
  // result set; these values are re-seeded from it on every render of the server page.
  const [icp, setIcp] = useState(current.icp);
  const [owner, setOwner] = useState(current.ownerNone ? '__none__' : current.owner);
  const [identity, setIdentity] = useState(current.identity);
  const [status, setStatus] = useState(current.status);
  const [view, setView] = useState(current.view);

  // The page-size override is preserved across filter changes, so an operator who is
  // paging by 5 to inspect a result set is not silently thrown back to 25 rows.
  //
  // Annotated deliberately. Inferred, `pageSize === undefined ? {} : {...}` widens to
  // `{ pageSize?: undefined } | { pageSize: string }`, and a property explicitly typed `undefined`
  // is not assignable to `Record<string, string>` — so every `{ ...sizeChange }` spread into a
  // `FilterChange.set` failed to typecheck. The annotation states the contract once instead of
  // five times at the call sites, and it keeps the "absent key" shape rather than emitting an
  // `undefined`-valued one.
  // Narrowed to a single string first: Next.js passes a repeated key through as `string[]`, and a
  // duplicated page size has no meaning. Anything that is not one non-empty string is treated as
  // absent, so the pager falls back to the default rather than encoding an array into the URL.
  const rawPageSize = query[PAGE_SIZE_PARAM];
  const pageSize =
    typeof rawPageSize === 'string' && rawPageSize.length > 0 ? rawPageSize : undefined;
  const sizeChange: Readonly<Record<string, string>> =
    pageSize === undefined ? {} : { [PAGE_SIZE_PARAM]: pageSize };

  return (
    <form className="nx-card" action={action} method="get">
      <div className="nx-card__body">
        <div className="nx-filter-grid">
          <Field label="ICP" htmlFor="filter-icp">
            <Select
              id="filter-icp"
              name="icp"
              value={icp}
              onChange={(value) => {
                setIcp(value);
                go({ set: { icp: value, ...sizeChange } });
              }}
              options={[
                { value: '', label: 'All ICPs' },
                ...icps.map((option) => ({ value: option.value, label: option.label })),
              ]}
            />
          </Field>

          <Field label="Owner" htmlFor="filter-owner">
            <Select
              id="filter-owner"
              name="owner"
              value={owner}
              onChange={(value) => {
                setOwner(value);
                // "Unassigned" is a second URL key rather than a magic option value,
                // because `owner` holds a user id everywhere else.
                go(
                  value === '__none__'
                    ? { clear: ['owner'], set: { ownerNone: '1', ...sizeChange } }
                    : { clear: ['ownerNone'], set: { owner: value, ...sizeChange } },
                );
              }}
              options={[
                { value: '', label: 'All owners' },
                { value: '__none__', label: 'Unassigned' },
                ...owners.map((option) => ({ value: option.value, label: option.label })),
              ]}
            />
          </Field>

          <Field label="Sender" htmlFor="filter-identity">
            <Select
              id="filter-identity"
              name="identity"
              value={identity}
              onChange={(value) => {
                setIdentity(value);
                go({ set: { identity: value, ...sizeChange } });
              }}
              options={[
                { value: '', label: 'All identities' },
                ...identities.map((option) => ({ value: option.value, label: option.label })),
              ]}
            />
          </Field>

          <Field label="Status" htmlFor="filter-status">
            <Select
              id="filter-status"
              name="status"
              value={status}
              onChange={(value) => {
                setStatus(value);
                // Choosing a lifecycle status replaces the chip view, and vice versa, so
                // the two can never contradict each other in one URL.
                go(
                  value.length === 0
                    ? { set: { status: '', ...sizeChange } }
                    : { clear: ['view', 'needsAttention'], set: { status: value, ...sizeChange } },
                );
              }}
              options={[
                { value: '', label: allStatusesLabel },
                ...LEAD_STATUS_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
              ]}
            />
          </Field>

          <Field
            label="Saved view"
            htmlFor="filter-view"
            hint={
              savedViews.length === 0
                ? 'No named views stored for this business yet.'
                : 'Needs attention is built in; the rest are stored views.'
            }
          >
            <Select
              id="filter-view"
              name="view"
              value={view}
              onChange={(value) => {
                setView(value);
                if (value.length === 0) {
                  // The built-in view: everything that asks for operator attention.
                  go({ clear: [...QUICK_FILTER_KEYS], set: { needsAttention: '1', ...sizeChange } });
                  return;
                }
                // A saved view is a whole filter payload, so it replaces the quick filters
                // rather than being merged with them.
                const chosen = savedViews.find((option) => option.value === value);
                if (chosen !== undefined) window.location.assign(chosen.href);
              }}
              options={[
                { value: '', label: 'Needs attention' },
                ...savedViews.map((option) => ({ value: option.value, label: option.label })),
              ]}
            />
          </Field>
        </div>

        {/* Secondary row: the filters the frame does not label, kept reachable. */}
        <div
          className="nx-filter-grid nx-filter-grid--secondary"
          style={{ marginTop: 'var(--nx-space-md)' }}
        >
          <Field label="Search" htmlFor="filter-q">
            <input
              id="filter-q"
              className="nx-input"
              type="search"
              name="q"
              defaultValue={current.q}
              placeholder="Name, company or LinkedIn URL"
            />
          </Field>

          <Field label="Source" htmlFor="filter-source">
            <select id="filter-source" className="nx-select" name="source" defaultValue={current.source}>
              <option value="">All sources</option>
              {LEAD_SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Sort" htmlFor="filter-sort">
            <select id="filter-sort" className="nx-select" name="sort" defaultValue={current.sort}>
              {LEAD_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="nx-inline-form">
            <div className="nx-noscript-submit">
              <Button type="submit" variant="primary">
                Apply filters
              </Button>
            </div>
            {/*
              Reset clears the filters but not the page size: the two are independent, and
              an operator comparing five-row pages should not lose that choice.
            */}
            <a
              className="nx-btn nx-btn--ghost"
              href={
                pageSize === undefined
                  ? action
                  : `${action}?${PAGE_SIZE_PARAM}=${encodeURIComponent(pageSize)}`
              }
            >
              Reset filters
            </a>
            <a className="nx-btn nx-btn--ghost" href={needsAttentionHref}>
              Needs attention
            </a>
          </div>
        </div>
      </div>
    </form>
  );
}
