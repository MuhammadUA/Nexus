/**
 * Repository conventions.
 *
 * Every repository function takes the acting identity first and runs inside
 * `withActor`, so no query can escape the request's tenant scope. The helpers here
 * exist so that mapping `snake_case` columns onto typed domain objects is uniform
 * rather than re-derived per query.
 */
import 'server-only';

import { withActor, type Actor } from '../actor';
import type { Db, Row } from '../sql';

export interface ListParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

/**
 * The result of a mutation, in the shape every server action reports to the UI.
 *
 * `error` is always a message safe to show an operator — never raw SQL. Callers
 * should return this directly rather than throwing, so a refused write becomes a
 * visible reason instead of a blank screen.
 */
export interface MutationResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
  readonly message?: string;
}

/** Clamps caller-supplied paging into a sane window. */
export function normalizePaging(params: ListParams = {}): { limit: number; offset: number } {
  const rawLimit = params.limit ?? DEFAULT_PAGE_SIZE;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const rawOffset = params.offset ?? 0;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
  return { limit, offset };
}

/* ------------------------------------------------------------- coercion -- */

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

export function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = asNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function asIso(value: unknown): string | null {
  return asDate(value)?.toISOString() ?? null;
}

export function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Total count from a `count(*) over ()` companion column, or the row count. */
export function totalFrom(rows: readonly Row[], explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const first = rows[0];
  return first === undefined ? 0 : asNumber(first.total_count, rows.length);
}

/* --------------------------------------------------------------- queries -- */

/** Runs a read as `actor`. Repository reads never bypass `withActor`. */
export async function read<T>(actor: Actor, fn: (sql: Db) => Promise<T>): Promise<T> {
  return withActor(actor, fn);
}

/**
 * Runs a write as `actor` and returns the affected row count.
 *
 * Writes that the database refuses (RLS, a CHECK, an invariant trigger) surface as
 * thrown errors rather than silent no-ops, which is what lets a screen report the
 * real reason instead of rendering an unchanged list.
 */
export async function write(
  actor: Actor,
  fn: (sql: Db) => Promise<number>,
): Promise<number> {
  return withActor(actor, fn);
}

/** Reads a single row, or null. */
export async function readOne<T>(
  actor: Actor,
  fn: (sql: Db) => Promise<T | null>,
): Promise<T | null> {
  return withActor(actor, fn);
}

/**
 * Translates a Postgres error into a message safe to show an operator.
 *
 * Raw SQL text must never reach the UI: it leaks schema shape and confuses the
 * person reading it. The `hint` is surfaced because the migrations deliberately use
 * `hint` for operator-facing guidance ("pass exactly: DELETE PERMANENTLY").
 */
export function describeDbError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'The request could not be completed.';
  const candidate = error as { code?: unknown; message?: unknown; hint?: unknown };

  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const hint = typeof candidate.hint === 'string' ? candidate.hint : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  // 42501 = insufficient privilege / RLS, 23001 = the project's invariant code.
  if (code === '42501') return hint.length > 0 ? hint : 'You do not have permission to do that.';
  if (code === '23001') return message.replace(/^.*?:\s*/, '') || 'That change is not allowed.';
  if (code === '23505') return 'That record already exists.';
  if (code === '23514' || code === '22023') return message || 'That value is not allowed.';
  if (code === '23503') return 'A related record is missing.';
  if (code === 'P0002') return 'That record no longer exists.';

  return hint.length > 0 ? hint : 'The request could not be completed.';
}
