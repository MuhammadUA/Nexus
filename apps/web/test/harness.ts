/**
 * Shared harness for web-app tests.
 *
 * Boots a real PostgreSQL engine (PGlite), applies the production migration set
 * with the same runner the app uses, and injects the resulting connection into the
 * app's database module. Tests therefore drive the *application's own* code
 * (auth, actor context, repositories) against production SQL, triggers and RLS —
 * nothing is mocked except the `server-only` marker.
 */
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nexus/db/migrate';

import { setConnectionForTesting, type Connection } from '@/lib/db';

export interface AppHarness {
  readonly db: PGlite;
  readonly connection: Connection;
  close(): Promise<void>;
}

/**
 * Must run before any module that reads the environment (the session secret is
 * resolved lazily, so setting it here is sufficient).
 */
export function configureTestEnvironment(): void {
  process.env.NEXUS_LOCAL_AUTH = '1';
  process.env.NEXUS_SESSION_SECRET = 'web-test-session-secret-000000000000000000';
  // The embedded driver is expected in tests; make that explicit so a developer's
  // ambient DATABASE_URL cannot redirect the suite at a real database.
  delete process.env.DATABASE_URL;
  delete process.env.SUPABASE_DB_URL;
}

export async function createAppHarness(): Promise<AppHarness> {
  configureTestEnvironment();

  const db = await PGlite.create();
  await applyMigrations(db);

  const connection: Connection = {
    driver: 'pglite',
    sql: {
      async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
        const result = await db.query<T>(text, params as unknown[]);
        return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
      },
      async exec(text: string) {
        await db.exec(text);
      },
    },
  };

  setConnectionForTesting(connection);

  return { db, connection, close: () => db.close() };
}

/** Reads one scalar as a number, failing loudly when the query returns nothing. */
export async function scalar(db: PGlite, text: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number }>(text, params);
  const value = result.rows[0]?.n;
  if (value === undefined) throw new Error(`scalar query returned no rows: ${text}`);
  return Number(value);
}
