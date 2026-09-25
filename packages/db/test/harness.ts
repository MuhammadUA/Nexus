/**
 * Shared test harness.
 *
 * Boots one real PGlite (WASM Postgres) instance per test file, applies the
 * production migration set, seeds the deterministic fixture graph and exposes
 * helpers that emulate a signed-in Supabase actor for exactly one statement
 * batch:
 *
 *   begin;
 *   set local role authenticated;
 *   select set_config('request.jwt.claims', '{"sub":"<uuid>"}', true);
 *   ... assertions ...
 *   rollback;
 *
 * Because `auth.uid()` reads `request.jwt.claims`, the *same* RLS policy SQL is
 * exercised locally and inside a real Supabase project.
 */
import { PGlite } from '@electric-sql/pglite';

import { createDb, type Db, type QueryResult, type Row } from '../src/client';
import { applyMigrations } from '../src/migrate';
import { FIXTURE_IDS, FIXTURE_SQL } from '../seed/fixtures';

export { FIXTURE_IDS };
export type { QueryResult, Row };

/** Postgres error shape as thrown by PGlite. */
export interface SqlError extends Error {
  code?: string;
  detail?: string;
  hint?: string;
  constraint?: string;
}

export interface Harness {
  readonly db: PGlite;
  readonly sql: Db;
  /** Runs `fn` as a signed-in user inside one rolled-back transaction. */
  asUser<T>(userId: string | null, fn: (sql: Db) => Promise<T>): Promise<T>;
  /** Runs `fn` as a scoped service token (no user). */
  asApiClient<T>(clientId: string, fn: (sql: Db) => Promise<T>): Promise<T>;
  /** Runs `fn` as the fixture admin. */
  asAdmin<T>(fn: (sql: Db) => Promise<T>): Promise<T>;
  /** Runs `fn` as the `anon` role with no identity at all. */
  asAnon<T>(fn: (sql: Db) => Promise<T>): Promise<T>;
  /** Runs `fn` as the table owner (RLS bypassed) inside a rolled-back tx. */
  asSuperuser<T>(fn: (sql: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const ROLLBACK = 'rollback';
const BEGIN = 'begin';

/** The `request.jwt.claims` JSON a Supabase session would carry for `userId`. */
function claimsFor(userId: string): string {
  return JSON.stringify({ sub: userId });
}

/** Creates a fresh database with all migrations applied and fixtures seeded. */
export async function createHarness(): Promise<Harness> {
  const db = await PGlite.create();
  const sql = createDb(db);

  await applyMigrations(db);

  // Seeding runs as the table owner with row security off, exactly like a
  // Supabase service-role seed. FORCE RLS still binds the owner, hence the
  // explicit session setting — which must be switched back on afterwards, or
  // Postgres raises "query would be affected by row-level security policy"
  // for every non-exempt role.
  //
  // The seed also impersonates the fixture admin (`session`-scoped, so it
  // survives the seed and is reset explicitly below) so that the rows the audit
  // triggers capture during seeding name a real actor instead of looking like
  // anonymous system writes. Tests assert `audit_events.actor_id`, and a fixture
  // graph that audits itself as "system" would both misrepresent production and
  // make those assertions meaningless.
  await db.exec('set row_security = off');
  await db.exec(`select set_config('request.jwt.claims', ${quote(claimsFor(FIXTURE_IDS.admin))}, false)`);
  await db.exec(FIXTURE_SQL);
  await db.exec(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set row_security = on');

  const asActor = async <T>(
    setup: readonly string[],
    fn: (client: Db) => Promise<T>,
  ): Promise<T> => {
    await db.exec(BEGIN);
    try {
      for (const statement of setup) {
        await db.exec(statement);
      }
      return await fn(sql);
    } finally {
      await db.exec(ROLLBACK);
    }
  };

  const asUser = <T>(userId: string | null, fn: (client: Db) => Promise<T>): Promise<T> => {
    const claims = userId === null ? '{}' : claimsFor(userId);
    return asActor(
      [
        'set local role authenticated',
        `select set_config('request.jwt.claims', ${quote(claims)}, true)`,
      ],
      fn,
    );
  };

  return {
    db,
    sql,
    asUser,
    asAdmin: (fn) => asUser(FIXTURE_IDS.admin, fn),
    asApiClient: (clientId, fn) =>
      asActor(
        [
          'set local role authenticated',
          `select set_config('request.jwt.claims', '{}', true)`,
          `select set_config('nexus.api_client_id', ${quote(clientId)}, true)`,
        ],
        fn,
      ),
    asAnon: (fn) => asActor(['set local role anon'], fn),
    asSuperuser: (fn) => asActor([], fn),
    close: () => db.close(),
  };
}

/** Single-quotes a literal for inline SQL (test-only helper). */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Switches the acting identity inside the *current* transaction.
 *
 * `request.jwt.claims` is a transaction-local setting, so a test that must
 * verify an admin-configured row from a normal user's point of view can do both
 * in one transaction and still roll everything back.
 */
export async function actAs(sql: Db, userId: string | null): Promise<void> {
  const claims = userId === null ? '{}' : claimsFor(userId);
  await sql.exec(`select set_config('request.jwt.claims', ${quote(claims)}, true)`);
}

/** Makes the current transaction act as a scoped service token. */
export async function actAsApiClient(sql: Db, clientId: string): Promise<void> {
  await sql.exec(`select set_config('request.jwt.claims', '{}', true)`);
  await sql.exec(`select set_config('nexus.api_client_id', ${quote(clientId)}, true)`);
}

/**
 * Runs `fn` and returns the raised Postgres error. The test fails when nothing
 * is raised, so "a policy/trigger blocks this" can never pass vacuously.
 */
export async function expectError(fn: () => Promise<unknown>): Promise<SqlError> {
  try {
    await fn();
  } catch (error) {
    const candidate = error as SqlError;
    if (typeof candidate.message !== 'string') {
      throw new Error(`expected a Postgres error, received ${String(error)}`);
    }
    // A closed/broken connection is a harness bug, not the behaviour under test.
    if (candidate.message.includes('Connection terminated') || candidate.message.includes('not valid')) {
      throw candidate;
    }
    return candidate;
  }
  throw new Error('expected the statement to raise, but it succeeded');
}

/** Reads the standard permission/immutability error code, with context on failure. */
export function expectCode(error: SqlError, code: string): void {
  if (error.code !== code) {
    throw new Error(
      `expected SQL error code ${code}, received ${String(error.code)} (${error.message})`,
    );
  }
}

/** Numeric column of a single-row aggregate query. */
export async function countOf(sql: Db, query: string, params: unknown[] = []): Promise<number> {
  const result = await sql.query<{ n: number }>(query, params);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('count query returned no rows');
  }
  return Number(row.n);
}

export type Attempt<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; value?: undefined; error: SqlError };

let savepointCounter = 0;

/**
 * Runs `fn` behind a savepoint so a rejected statement does not poison the
 * surrounding transaction. This is what lets a single transaction assert the
 * allowed *and* the rejected path of the same invariant.
 */
export async function attempt<T>(sql: Db, fn: () => Promise<T>): Promise<Attempt<T>> {
  savepointCounter += 1;
  const name = `sp_${savepointCounter}`;
  await sql.exec(`savepoint ${name}`);
  try {
    const value = await fn();
    await sql.exec(`release savepoint ${name}`);
    return { ok: true, value };
  } catch (error) {
    await sql.exec(`rollback to savepoint ${name}`);
    return { ok: false, error: error as SqlError };
  }
}

/** Convenience wrapper used by tests that must assert a rejection. */
export async function rejected<T>(sql: Db, fn: () => Promise<T>, code?: string): Promise<SqlError> {
  const outcome = await attempt(sql, fn);
  if (outcome.ok) {
    throw new Error('expected the statement to raise, but it succeeded');
  }
  if (code !== undefined) {
    expectCode(outcome.error, code);
  }
  return outcome.error;
}

/** Convenience wrapper used by tests that must assert success. */
export async function accepted<T>(sql: Db, fn: () => Promise<T>): Promise<T> {
  const outcome = await attempt(sql, fn);
  if (!outcome.ok) {
    throw new Error(`expected the statement to succeed, received ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome.value;
}

