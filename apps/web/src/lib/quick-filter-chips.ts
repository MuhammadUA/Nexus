/**
 * The Leads quick-filter chip row, as data.
 *
 * **Why this is its own module.** The row was previously built inline, and every chip sent its key
 * with the value `'1'`. That is right for the boolean filters — `followups=1`, `needsProfile=1`,
 * `dnc=1` — and wrong for the two chips that select a *lifecycle status*: "Replied" generated
 * `?status=1`, which matches no lead, while the chip rendered a real count and its own active-state
 * check looked for `status === 'replied'`. The chip therefore advertised leads it could not open,
 * and could never highlight itself.
 *
 * Extracting the mapping makes each chip's filter value a single, assertable fact rather than a
 * literal buried in JSX, so the count a chip shows and the query it opens cannot drift apart again.
 * The rendering code consumes this list; it does not re-declare it.
 */
import type { FilterParamKey } from './filter-url';

/** A lifecycle status a chip may filter on, as stored by `leads_status_check`. */
export type ChipStatusValue = 'replied' | 'dormant';

export interface QuickFilterChip {
  /** Stable React key. Distinct per chip, even where two chips share a filter key. */
  readonly key: string;
  readonly label: string;
  /** Which `LeadCounts` field supplies the count this chip advertises. */
  readonly countKey: 'followups' | 'replied' | 'needsProfile' | 'dormant' | 'dnc';
  /** Empty string means "no accent"; the row styles the chip by name. */
  readonly accent: '' | 'amber' | 'green' | 'cyan' | 'red';
  /** The exact query change this chip applies, clearing the other chips first. */
  readonly set: Readonly<Partial<Record<FilterParamKey, string>>>;
}

/**
 * A boolean filter is expressed as the flag `1`; a status filter carries the status itself.
 *
 * `status` is the only key whose value is not a flag, which is exactly the distinction that was
 * lost. Keeping both shapes visible here is what stops the next chip from repeating the mistake.
 */
export const QUICK_FILTER_CHIPS: readonly QuickFilterChip[] = [
  { key: 'followups', label: 'Follow-ups', countKey: 'followups', accent: 'amber', set: { followups: '1' } },
  { key: 'status-replied', label: 'Replied', countKey: 'replied', accent: 'green', set: { status: 'replied' } },
  { key: 'needsProfile', label: 'Needs profile', countKey: 'needsProfile', accent: 'cyan', set: { needsProfile: '1' } },
  { key: 'status-dormant', label: 'Dormant', countKey: 'dormant', accent: '', set: { status: 'dormant' } },
  { key: 'dnc', label: 'DNC', countKey: 'dnc', accent: 'red', set: { dnc: '1' } },
] as const;

/**
 * Every filter key the chip row may set or clear, so activating one chip clears the rest and the
 * two chip views cannot both read as "on".
 *
 * `view` is included because a saved view and a chip are mutually exclusive selectors of the same
 * list; leaving `view` set would let the URL claim a saved view while the chip's own filter also
 * applied.
 */
export const QUICK_FILTER_KEYS: readonly FilterParamKey[] = [
  'status',
  'needsProfile',
  'dnc',
  'followups',
  'needsAttention',
  'view',
];

/**
 * Whether a chip is the active one for the current query.
 *
 * Derived from the chip's own `set` payload rather than hand-written per chip, so a chip cannot be
 * highlighted by a rule that disagrees with the link it points at.
 */
export function chipIsActive(
  chip: QuickFilterChip,
  query: Readonly<Record<string, string | readonly string[] | undefined>>,
): boolean {
  return Object.entries(chip.set).every(([key, value]) => {
    const current = query[key];
    return typeof current === 'string' && current === value;
  });
}
