/**
 * URL helpers for the Leads filter model.
 *
 * Filters live in the query string, never in component state, so a filtered list stays
 * shareable, survives a reload, and can be restored exactly — which is what the
 * Companion's "preserve prior list state" requirement rests on.
 *
 * These are pure and dependency-free so the server render and the client selects build
 * the identical URL. A client-side navigation that produced a different string from the
 * server-rendered link would make the screen and the address bar disagree.
 */

/** Which page of the list to request. Any other key is copied through unchanged. */
export const PAGE_PARAM = 'page';

/** Optional page-size override, bounded by the page. */
export const PAGE_SIZE_PARAM = 'pageSize';

/** The keys the filter model owns. Everything else in the URL is preserved verbatim. */
export const FILTER_PARAM_KEYS = [
  'icp',
  'owner',
  'ownerNone',
  'identity',
  'status',
  'source',
  'q',
  'sort',
  'view',
  'needsProfile',
  'dnc',
  'followups',
  'needsAttention',
] as const;

export type FilterParamKey = (typeof FILTER_PARAM_KEYS)[number];

/**
 * A query-string bag as the page receives it.
 *
 * Next.js hands a repeated key (`?icp=a&icp=b`) through as `string[]`, so the record must admit
 * arrays or no real `searchParams` object is assignable to it. The helpers below narrow each entry
 * to a single non-empty `string` and skip the rest, which is the correct behaviour for a filter
 * model: a duplicated filter value has no meaning, and inventing one (last-wins, first-wins) would
 * make the URL and the rendered selection disagree.
 */
export type SearchParamRecord = Readonly<Record<string, string | readonly string[] | undefined>>;

/** One filter change: values to set, and keys to remove. */
export interface FilterChange {
  readonly set?: Readonly<Record<string, string>>;
  readonly clear?: readonly string[];
}

/**
 * Applies a filter change to the current query and returns the next href.
 *
 * Changing a filter always returns to page 1: staying on page 4 of a result set that now
 * has two pages is how an operator ends up staring at an empty table with no idea why.
 * `page` is therefore dropped, and only an explicit `pageHref` puts it back.
 *
 * A value of `""` removes its key rather than setting an empty one, so a quick-filter
 * chip can be switched off and the URL stays clean.
 */
export function filterHref(
  basePath: string,
  query: SearchParamRecord,
  change: FilterChange,
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (key === PAGE_PARAM) continue;
    if (typeof value === 'string' && value.length > 0) search.set(key, value);
  }

  for (const key of change.clear ?? []) search.delete(key);

  for (const [key, value] of Object.entries(change.set ?? {})) {
    if (value.length === 0) {
      search.delete(key);
    } else {
      search.set(key, value);
    }
  }

  const suffix = search.toString();
  return suffix.length === 0 ? basePath : `${basePath}?${suffix}`;
}

/**
 * A page link that keeps every current filter.
 *
 * Values are narrowed before reaching `URLSearchParams`: a widened non-string would end
 * up in the URL as `"[object Object]"`. `pageSize` is carried along with `page`, because
 * a pager link that silently reverted to the default page size would not be the page the
 * operator asked for.
 */
export function pageHref(basePath: string, query: SearchParamRecord, page: number): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (key === PAGE_PARAM) continue;
    if (typeof value === 'string' && value.length > 0) search.set(key, value);
  }

  search.set(PAGE_PARAM, String(page));
  return `${basePath}?${search.toString()}`;
}
