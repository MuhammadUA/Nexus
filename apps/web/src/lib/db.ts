/**
 * Server-side database access.
 *
 * Two drivers, one interface:
 *
 *  1. **PostgreSQL/Supabase** when `SUPABASE_DB_URL` or `DATABASE_URL` is set. This
 *     is the production path.
 *  2. **Embedded PostgreSQL (PGlite)** otherwise, persisted under `.data/`, so the
 *     app is runnable and testable without a cloud project.
 *
 * The second driver is a real PostgreSQL engine, not a mock: the same migrations,
 * the same triggers and the same RLS policies run in both. What it is *not* is a
 * multi-process server — PGlite is single-connection WASM, so the embedded path is
 * for local development and single-process use only. Setting `DATABASE_URL` is
 * therefore not optional for a real deployment, and `assertRuntimePosture()`
 * refuses to start a production build on the embedded driver.
 *
 * Everything is `server-only`: this module must never be imported from a client
 * component. No service-role credential is read here, and nothing in this file is
 * reachable from the browser or the extension bundle.
 */
import 'server-only';

import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { createPgDb, type Db, type SqlExecutor } from './sql';

export type { Db, QueryResult, Row, SqlExecutor } from './sql';

export type DriverKind = 'postgres' | 'pglite';

export interface Connection {
  readonly driver: DriverKind;
  readonly sql: Db;
}

/**
 * Cached across hot reloads in development and across route handlers in
 * production. `globalThis` is used because Next.js re-evaluates modules on HMR.
 *
 * `__nexusDb` doubles as an injection point: tests assign a pre-built connection
 * here to run the app's own repositories against an isolated database, rather than
 * mocking this module.
 */
const globalForDb = globalThis as unknown as {
  __nexusDb?: Promise<Connection>;
};

/**
 * Overrides the connection for the lifetime of the process.
 *
 * Only intended for tests that must exercise application code against a specific
 * database. It is not part of the request path and takes no user input.
 */
export function setConnectionForTesting(connection: Connection): void {
  globalForDb.__nexusDb = Promise.resolve(connection);
}

function externalUrl(): string | null {
  const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? '';
  return url.trim().length === 0 ? null : url.trim();
}

export function driverKind(): DriverKind {
  return externalUrl() === null ? 'pglite' : 'postgres';
}

/**
 * Refuses configurations that would silently lose data or bypass the security
 * model. Called from the app's instrumentation hook at boot.
 *
 * `NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1` is an explicit, deliberate override. It
 * exists only so a single-process production-mode smoke test can run against the
 * embedded database; it is never set by a deployment template.
 */
export function assertRuntimePosture(): void {
  if (process.env.NODE_ENV !== 'production') return;

  if (driverKind() === 'pglite' && process.env.NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION !== '1') {
    throw new Error(
      'NEXUS refuses to run a production build on the embedded PGlite driver: it is a ' +
        'single-process WASM database and cannot serve concurrent requests safely. ' +
        'Set DATABASE_URL (or SUPABASE_DB_URL) to your PostgreSQL/Supabase instance, or set ' +
        'NEXUS_ALLOW_EMBEDDED_IN_PRODUCTION=1 for a single-process smoke test.',
    );
  }
  if (sessionSecret() === null) {
    throw new Error(
      'NEXUS_SESSION_SECRET is required in production. Refusing to start with a ' +
        'derived development secret, which would make every session forgeable.',
    );
  }
}

export function sessionSecret(): string | null {
  const secret = process.env.NEXUS_SESSION_SECRET ?? '';
  return secret.trim().length === 0 ? null : secret;
}

/**
 * Resolves the connection. The embedded driver applies the migration set on first
 * use so a fresh checkout is immediately usable.
 */
export function getConnection(): Promise<Connection> {
  globalForDb.__nexusDb ??= connect();
  return globalForDb.__nexusDb;
}

async function connect(): Promise<Connection> {
  const url = externalUrl();

  if (url !== null) {
    const sql = await createPgDb(url);
    return { driver: 'postgres', sql };
  }

  // Everything below touches the filesystem, so it lives in a module that is only
  // loaded on this branch. A static `node:fs` import here would make the bundler
  // try to resolve Node's `node:` scheme, which it cannot do.
  const { prepareEmbeddedDataDir, applyMigrationFiles, embeddedDataDir } = await import('./embedded');

  const dataDir = embeddedDataDir();
  prepareEmbeddedDataDir(dataDir);

  const pglite = await PGlite.create({ dataDir: path.join(dataDir, 'nexus') });
  const sql: SqlExecutor = {
    async query<T>(text: string, params: readonly unknown[] = []) {
      const result = await pglite.query<T>(text, params as unknown[]);
      return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    },
    async exec(text: string) {
      await pglite.exec(text);
    },
  };

  // The same `.sql` files the test harness and `pnpm db:verify` apply, so local
  // development exercises production SQL rather than a parallel schema.
  await applyMigrationFiles(pglite);

  return { driver: 'pglite', sql };
}

export async function getSql(): Promise<Db> {
  const { sql } = await getConnection();
  return sql;
}
