/**
 * The narrow SQL interface every repository is written against.
 *
 * Kept separate from `db.ts` so that repository code cannot reach a raw driver
 * handle, cannot open its own connection, and cannot escape the request-scoped
 * transaction that carries the acting identity.
 */
import type { QueryResult, Row } from '@nexus/db';

export type { QueryResult, Row };

export interface SqlExecutor {
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  exec(text: string): Promise<void>;
  /** Return a checked-out production connection to its pool. */
  release?(): void;
}

/** A handle bound to one open transaction and one acting identity. */
export type Db = SqlExecutor;

export function num(row: Row | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

export function str(row: Row | undefined, column: string): string | null {
  const value = row?.[column];
  return typeof value === 'string' ? value : null;
}

export function bool(row: Row | undefined, column: string): boolean {
  return row?.[column] === true;
}

/**
 * PostgreSQL driver for the production path.
 *
 * `pg` is loaded lazily and by name so the embedded/local path never pulls it in,
 * and so a checkout without `pg` installed can still run locally. The pool is
 * module-scoped: `Pool` is already safe to share across requests.
 *
 * One client is checked out per `Db` handle and never returned: `withActor` wraps
 * every handle in a transaction that sets the acting identity, and those settings
 * are transaction-local, so handing the client back to the pool mid-transaction
 * would leak another request's identity onto it.
 */
let poolPromise: Promise<PgPool> | null = null;

interface PgPool {
  connect(): Promise<PgClient>;
}

interface PgClient {
  query<T extends Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

export async function createPgDb(connectionString: string): Promise<Db> {
  poolPromise ??= (async (): Promise<PgPool> => {
    const moduleName = 'pg';
    const pg = (await import(/* webpackIgnore: true */ moduleName)) as {
      Pool: new (config: { connectionString: string; max: number }) => PgPool;
    };
    const configuredMax = Number.parseInt(process.env.NEXUS_DB_POOL_MAX ?? '', 10);
    const max = Number.isFinite(configuredMax) && configuredMax >= 1 && configuredMax <= 10
      ? configuredMax
      : 10;
    return new pg.Pool({ connectionString, max });
  })();

  const pool = await poolPromise;
  const client = await pool.connect();

  return {
    async query<T extends Row>(text: string, params: readonly unknown[] = []) {
      const result = await client.query<T>(text, params);
      return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    },
    async exec(text: string) {
      await client.query(text);
    },
    release() {
      client.release();
    },
  };
}
