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
 * Postgres SQLSTATEs that mean "the code and the schema disagree", as opposed to a
 * business refusal.
 *
 *   42P01 undefined_table      42703 undefined_column
 *   42883 undefined_function   42P08/42P02 parameter errors
 *   42601 syntax_error         42804 datatype_mismatch
 *   3F000 invalid_schema_name  42702 ambiguous_column
 *
 * A 42703 is exactly what production Create User produced: the repository inserted a
 * `created_by` column that `public.users` has never had. The operator saw the generic
 * fallback sentence and the server logged nothing, so the defect was invisible from
 * both sides. These are now logged with full detail and reported to the browser as a
 * plain sentence that leaks no schema shape.
 */
const SCHEMA_MISMATCH_CODES = new Set([
  '42P01',
  '42703',
  '42883',
  '42804',
  '42601',
  '42702',
  '42P08',
  '42P02',
  '3F000',
]);

/**
 * Fields a Postgres error carries that are safe to log.
 *
 * Deliberately a whitelist. A driver error's `message`/`detail` can embed the failing
 * statement and its bound parameter values — and bound values include emails, names,
 * lead text and password hashes. Logging them would trade a silent failure for a data
 * leak in the platform logs. Column, table, constraint, routine and SQLSTATE describe
 * the *shape* of the failure, which is what a developer needs, without any row data.
 */
const LOGGABLE_ERROR_FIELDS = [
  'code',
  'severity',
  'constraint',
  'table',
  'column',
  'schema',
  'routine',
  'position',
] as const;

/**
 * Writes a structured diagnostic for a database failure.
 *
 * `operation` is the repository function's own name, supplied by the caller, so a log
 * line says which piece of code failed rather than only that something did. The
 * `message` is included only for schema-shape errors, where it is generated by the
 * parser ("column u.created_by does not exist") and therefore contains identifiers
 * rather than row data. For every other SQLSTATE the message is withheld.
 */
function logDbFailure(error: object, code: string, operation: string | undefined): void {
  const source = error as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const field of LOGGABLE_ERROR_FIELDS) {
    const value = source[field];
    if (value !== undefined && value !== null && value !== '') safe[field] = value;
  }
  if (operation !== undefined && operation.length > 0) safe.operation = operation;
  if (SCHEMA_MISMATCH_CODES.has(code)) {
    const message = source.message;
    if (typeof message === 'string') safe.message = message.slice(0, 500);
  }
  console.error('[nexus] database error', JSON.stringify(safe));
}

/**
 * Translates a Postgres error into a message safe to show an operator.
 *
 * Raw SQL text must never reach the UI: it leaks schema shape and confuses the person
 * reading it. The `hint` is surfaced because the migrations deliberately use `hint` for
 * operator-facing guidance ("pass exactly: DELETE PERMANENTLY").
 *
 * Every failure is also written to the server log with a safe, structured subset of the
 * error, so a repository/schema mismatch is diagnosable from logs alone while the
 * browser still receives nothing but a sentence. Pass `operation` to name the caller.
 */
export function describeDbError(error: unknown, operation?: string): string {
  if (typeof error !== 'object' || error === null) {
    // Not even an Error object — nothing structured to log.
    console.error('[nexus] database error', JSON.stringify({ operation: operation ?? null, shape: typeof error }));
    return 'The request could not be completed.';
  }
  const candidate = error as { code?: unknown; message?: unknown; hint?: unknown };

  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const hint = typeof candidate.hint === 'string' ? candidate.hint : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';

  logDbFailure(error, code, operation);

  // 42501 = insufficient privilege / RLS, 23001 = the project's invariant code.
  if (code === '42501') return hint.length > 0 ? hint : 'You do not have permission to do that.';
  if (code === '23001') return message.replace(/^.*?:\s*/, '') || 'That change is not allowed.';
  if (code === '23505') return 'That record already exists.';
  if (code === '23514' || code === '22023') return message || 'That value is not allowed.';
  if (code === '23503') return 'A related record is missing.';
  if (code === 'P0002') return 'That record no longer exists.';

  /*
   * A schema mismatch is never the operator's fault and never something they can act on,
   * so it gets a plain sentence naming the next step rather than the raw parser output.
   * The detail is in the server log, keyed by `operation`.
   */
  if (SCHEMA_MISMATCH_CODES.has(code)) {
    return 'The request could not be completed because the system is misconfigured. This has been logged.';
  }

  return hint.length > 0 ? hint : 'The request could not be completed.';
}
