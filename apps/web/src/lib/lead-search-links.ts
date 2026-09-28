/**
 * Search-link facts and the §30.2 actions that cannot be built from them.
 *
 * Server-safe on purpose: the Lead Detail page calls `missingSearchLinks` while
 * rendering. Exporting it from the client workspace component — where it used to live
 * — made Next.js treat the call as a client reference and answer 500 with
 *
 *   Attempted to call missingSearchLinks() from the server but missingSearchLinks is
 *   on the client
 *
 * `searchLinks()` in `@nexus/core` omits a link it cannot build; the UI still has to
 * *account* for the omission, which is what `missingSearchLinks` returns — each entry
 * naming the fact the operator would need to supply (§30.3.4).
 */
import type { SearchLink } from '@nexus/core';

export interface SearchLinkInputFacts {
  readonly fullName: string | null;
  readonly companyName: string | null;
  readonly location: string | null;
  readonly companyDomain?: string | null;
  readonly linkedinUrl?: string | null;
}

export interface UnavailableSearchLink {
  readonly key: SearchLink['key'];
  readonly label: string;
  /** The fact that is missing, named so the operator knows what to supply. */
  readonly reason: string;
}

export function missingSearchLinks(input: SearchLinkInputFacts): readonly UnavailableSearchLink[] {
  const has = (value: string | null | undefined): boolean =>
    typeof value === 'string' && value.trim().length > 0;
  const missing: UnavailableSearchLink[] = [];

  if (!has(input.fullName) && !has(input.linkedinUrl)) {
    missing.push({
      key: 'find_linkedin',
      label: 'Find LinkedIn profile',
      reason: 'person name is missing',
    });
  }
  if (!has(input.fullName) || (!has(input.companyName) && !has(input.location))) {
    missing.push({
      key: 'search_person',
      label: 'Search this person',
      reason: has(input.fullName) ? 'company or location is missing' : 'person name is missing',
    });
  }
  if (!has(input.companyName) && !has(input.companyDomain)) {
    missing.push({ key: 'search_company', label: 'Search this company', reason: 'company is missing' });
    missing.push({
      key: 'search_signals',
      label: 'Search for buying signals',
      reason: 'company is missing',
    });
  }
  return missing;
}
