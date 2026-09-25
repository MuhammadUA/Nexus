/**
 * Saved list views.
 *
 * spec `companion_extension.list_state_preservation` — the selected business, ICP,
 * assignment filter, page and selected row have to be preservable, and spec
 * `screen_inventory` U05 lists "saved-view" among the My Leads filters.
 *
 * A saved view is a name plus the exact filter/sort payload that produced the list.
 * It is stored per owner in `public.saved_views` (scope `leads`), so RLS — not this
 * module — decides who may read or change one: `saved_views_select` allows the
 * owner and shared rows for businesses the viewer can reach, and insert/update/
 * delete are owner-only.
 */
import 'server-only';

import { withActor, type Actor, type Viewer } from '../actor';
import type { Row } from '../sql';
import { asBoolean, asIso, asString, describeDbError, read } from './common';

/**
 * The write result shape every repository mutation returns.
 *
 * Declared here rather than imported from `leads.ts` so the two remain independent
 * modules with the same contract (the app's actions only ever read `ok`/`id`/`error`).
 */
export interface MutationResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
}

/** The `saved_views.scope` values the spec defines. */
export type SavedViewScope = 'leads' | 'today' | 'companion_leads';

export const LEAD_VIEW_SCOPE: SavedViewScope = 'leads';

/**
 * The filter payload of a saved lead view.
 *
 * Every field is optional and every value is a string, because that is exactly what
 * the URL carries: a saved view is the query string of a working list, and re-applying
 * it must reproduce the same screen. Values are re-validated on the way back in, so a
 * hand-edited row cannot inject a filter the screen does not implement.
 */
export interface LeadViewFilters {
  readonly business?: string;
  readonly icp?: string;
  readonly identity?: string;
  readonly status?: string;
  readonly source?: string;
  readonly owner?: string;
  readonly q?: string;
  readonly sort?: string;
  readonly page?: string;
}

export interface LeadViewSort {
  readonly sort?: string | null;
}

/** The keys a saved view may carry in its sort payload. */
const SORT_KEYS = ['sort'] as const;

export interface SavedView {
  readonly id: string;
  readonly businessId: string;
  readonly ownerUserId: string;
  readonly scope: SavedViewScope;
  readonly name: string;
  readonly filters: LeadViewFilters;
  readonly sort: LeadViewSort;
  readonly isShared: boolean;
  readonly isOwn: boolean;
  readonly createdAt: string | null;
}

const FILTER_KEYS = ['business', 'icp', 'identity', 'status', 'source', 'owner', 'q', 'sort', 'page'] as const;

function asScope(value: unknown): SavedViewScope {
  const candidate = asString(value, 'leads');
  return candidate === 'today' || candidate === 'companion_leads' ? candidate : 'leads';
}

/**
 * Keeps only the keys the lead list understands, and only string values.
 *
 * A jsonb column can hold anything; narrowing here means a corrupted or hand-edited
 * row degrades into "this view has no extra filters" instead of a screen that
 * applies a filter it cannot render.
 */
export function sanitizeLeadFilters(value: unknown): LeadViewFilters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const entry = source[key];
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    // Bounded so a saved view cannot be used to smuggle megabytes into a URL.
    result[key] = trimmed.slice(0, 200);
  }
  return result;
}

function mapSavedView(row: Row, viewerUserId: string | null): SavedView {
  const ownerUserId = asString(row.owner_user_id);
  return {
    id: asString(row.id),
    businessId: asString(row.business_id),
    ownerUserId,
    scope: asScope(row.scope),
    name: asString(row.name),
    filters: sanitizeLeadFilters(row.filters),
    sort: sanitizeLeadFilters(row.sort),
    isShared: asBoolean(row.is_shared),
    isOwn: viewerUserId !== null && ownerUserId === viewerUserId,
    createdAt: asIso(row.created_at),
  };
}

/**
 * Saved views visible to the actor for one business.
 *
 * RLS already returns the owner's own rows plus shared rows in accessible
 * businesses, so no owner predicate is written here.
 */
export async function listSavedViews(
  actor: Actor,
  businessId: string,
  scope: SavedViewScope = LEAD_VIEW_SCOPE,
  viewerUserId: string | null = null,
): Promise<readonly SavedView[]> {
  return read(actor, async (sql) => {
    const result = await sql.query<Row>(
      `select id, business_id, owner_user_id, scope, name, filters, sort, is_shared, created_at
         from public.saved_views
        where business_id = $1 and scope = $2
        order by is_shared desc, lower(name)`,
      [businessId, scope],
    );
    return result.rows.map((row: Row) => mapSavedView(row, viewerUserId));
  });
}

export interface SavedViewInput {
  readonly businessId: string;
  readonly name: string;
  readonly filters: LeadViewFilters;
  readonly sort?: LeadViewSort;
  readonly isShared?: boolean;
  readonly scope?: SavedViewScope;
}

/**
 * Saves (or re-saves) the current list state under a name.
 *
 * `saved_views_owner_name_key` is unique per (owner, business, scope, name), so
 * saving the same name twice updates that view rather than accumulating duplicates —
 * which is what an operator expects from "save this view".
 */
export async function saveView(viewer: Viewer, input: SavedViewInput): Promise<MutationResult> {
  const name = input.name.trim();
  if (name.length === 0) return { ok: false, error: 'Give the view a name.' };
  if (name.length > 120) return { ok: false, error: 'That view name is too long.' };
  if (viewer.userId === null) return { ok: false, error: 'A saved view needs a signed-in user.' };

  const filters = sanitizeLeadFilters(input.filters);
  const sort = sanitizeLeadFilters(input.sort ?? {});

  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query<{ id: string }>(
        `insert into public.saved_views
           (business_id, owner_user_id, scope, name, filters, sort, is_shared)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         on conflict (owner_user_id, business_id, scope, name)
         do update set filters = excluded.filters,
                       sort = excluded.sort,
                       is_shared = excluded.is_shared,
                       updated_at = now()
         returning id`,
        [
          input.businessId,
          viewer.userId,
          input.scope ?? LEAD_VIEW_SCOPE,
          name,
          JSON.stringify(filters),
          JSON.stringify(sort),
          input.isShared === true,
        ],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('The saved view could not be stored.');
      return { ok: true, id };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/** Deletes one of the viewer's own saved views (RLS refuses anyone else's). */
export async function deleteView(viewer: Viewer, viewId: string): Promise<MutationResult> {
  try {
    return await withActor(viewer.actor, async (sql) => {
      const result = await sql.query(
        `delete from public.saved_views where id = $1 and owner_user_id = $2`,
        [viewId, viewer.userId],
      );
      if (result.affectedRows === 0) {
        throw new Error('That saved view is not yours to remove.');
      }
      return { ok: true };
    });
  } catch (error) {
    return { ok: false, error: describeDbError(error) };
  }
}

/**
 * The filter payload of a saved view, as URL search parameters.
 *
 * Iterates the known key list rather than `Object.entries` and narrows each value with
 * a `typeof` guard. A saved view is stored as `jsonb`, so a value could be anything a
 * previous version — or a hand-edited row — wrote there; passing a non-string into
 * `URLSearchParams.set` would silently produce `"[object Object]"` in a filter URL.
 */
export function viewHref(basePath: string, view: SavedView): string {
  const search = new URLSearchParams();

  for (const key of FILTER_KEYS) {
    const value: unknown = (view.filters as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) search.set(key, value);
  }
  for (const key of SORT_KEYS) {
    const value: unknown = (view.sort as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) search.set(key, value);
  }

  search.set('view', view.id);
  const query = search.toString();
  return query.length === 0 ? basePath : `${basePath}?${query}`;
}
