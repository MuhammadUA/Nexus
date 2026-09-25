/**
 * Thin typed query helper over PGlite.
 *
 * The database layer deliberately owns no ORM: every read and write in the
 * tests goes through SQL so that the contract in `docs/DB_CONTRACT.md` — not a
 * TypeScript abstraction — is what is being verified.
 */
import type { PGlite } from '@electric-sql/pglite';

/** Any result row. Callers narrow with a type argument. */
export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row = Row> {
  rows: T[];
  affectedRows: number;
}

export interface Db {
  /** Runs one parameterised statement. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs a (possibly multi-statement) batch of SQL. */
  exec(sql: string): Promise<void>;
  /** Raw PGlite handle, for transactions and session settings. */
  readonly raw: PGlite;
}

export function createDb(db: PGlite): Db {
  return {
    raw: db,
    async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await db.query<T>(sql, params);
      return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    },
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
  };
}

/** Returns the single row of a result, failing loudly otherwise. */
export function one<T extends Row>(rows: T[]): T {
  const first = rows[0];
  if (first === undefined || rows.length !== 1) {
    throw new Error(`expected exactly 1 row, received ${rows.length}`);
  }
  return first;
}

/** Reads a numeric column out of a row without resorting to `any`. */
export function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`column ${column} is not numeric: ${String(value)}`);
}

/** Reads a string column out of a row. */
export function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  throw new Error(`column ${column} is not a string: ${String(value)}`);
}
