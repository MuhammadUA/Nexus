'use client';

import type { ReactElement } from 'react';

import { Button, Row } from '@nexus/ui';
import { useRouter } from 'next/navigation';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface LeadFilterValues {
  readonly icp: string;
  readonly identity: string;
  readonly status: string;
  readonly source: string;
  readonly q: string;
  readonly sort: string;
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
];

export const LEAD_SOURCE_OPTIONS: readonly FilterOption[] = [
  { value: 'manual_add', label: 'Manual add' },
  { value: 'file_csv', label: 'File (CSV)' },
  { value: 'file_xlsx', label: 'File (XLSX)' },
  { value: 'paste', label: 'Pasted list' },
  { value: 'google_search', label: 'Google search' },
  { value: 'apollo', label: 'Apollo' },
  { value: 'manual_companion', label: 'Companion import' },
  { value: 'api_ingest', label: 'API ingest' },
];

export const LEAD_SORT_OPTIONS: readonly FilterOption[] = [
  { value: 'recent_activity', label: 'Recent activity' },
  { value: 'next_action', label: 'Next action' },
  { value: 'name', label: 'Name' },
  { value: 'company', label: 'Company' },
  { value: 'created', label: 'Newest' },
];

/**
 * Filter controls for the Leads table.
 *
 * Filters are applied through the URL rather than local state, so a filtered list is
 * shareable, survives a reload, and is restorable — which the Companion's
 * "preserve prior list state" requirement depends on.
 */
export function LeadFilterBar({
  action,
  icps,
  identities,
  owners,
  current,
}: {
  readonly action: string;
  readonly icps: readonly FilterOption[];
  readonly identities: readonly FilterOption[];
  readonly owners: readonly FilterOption[];
  readonly current: LeadFilterValues;
}): ReactElement {
  const router = useRouter();

  return (
    <form
      className="nx-card"
      action={action}
      method="get"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const search = new URLSearchParams();
        for (const [key, value] of data.entries()) {
          if (typeof value === 'string' && value.length > 0) search.set(key, value);
        }
        router.push(`${action}?${search.toString()}`);
      }}
    >
      <div className="nx-card__body">
        <Row wrap>
          <label className="nx-visually-hidden" htmlFor="filter-q">
            Search
          </label>
          <input
            id="filter-q"
            className="nx-input"
            style={{ maxWidth: '260px' }}
            type="search"
            name="q"
            defaultValue={current.q}
            placeholder="Name, company or LinkedIn URL"
          />

          <label className="nx-visually-hidden" htmlFor="filter-icp">
            ICP
          </label>
          <select id="filter-icp" className="nx-select" style={{ maxWidth: '200px' }} name="icp" defaultValue={current.icp}>
            <option value="">All ICPs</option>
            {icps.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="nx-visually-hidden" htmlFor="filter-status">
            Status
          </label>
          <select
            id="filter-status"
            className="nx-select"
            style={{ maxWidth: '180px' }}
            name="status"
            defaultValue={current.status}
          >
            <option value="">All statuses</option>
            {LEAD_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="nx-visually-hidden" htmlFor="filter-identity">
            Sender identity
          </label>
          <select
            id="filter-identity"
            className="nx-select"
            style={{ maxWidth: '180px' }}
            name="identity"
            defaultValue={current.identity}
          >
            <option value="">All senders</option>
            {identities.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="nx-visually-hidden" htmlFor="filter-owner">
            Owner
          </label>
          <select
            id="filter-owner"
            className="nx-select"
            style={{ maxWidth: '180px' }}
            name="owner"
            defaultValue=""
          >
            <option value="">All owners</option>
            {owners.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="nx-visually-hidden" htmlFor="filter-sort">
            Sort
          </label>
          <select id="filter-sort" className="nx-select" style={{ maxWidth: '170px' }} name="sort" defaultValue={current.sort}>
            {LEAD_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <Button type="submit" variant="primary">
            Apply
          </Button>
          <a className="nx-btn nx-btn--ghost" href={action}>
            Reset
          </a>
        </Row>
      </div>
    </form>
  );
}
