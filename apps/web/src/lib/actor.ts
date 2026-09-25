/**
 * Request-scoped actor context.
 *
 * This is where tenant isolation actually happens. Rather than passing a
 * `business_id` filter around and hoping every query remembers it, every read and
 * write runs inside a transaction whose acting identity is set as PostgreSQL
 * session state:
 *
 *   begin;
 *   set local role authenticated;                       -- drops owner privileges
 *   select set_config('request.jwt.claims', ..., true);  -- auth.uid()
 *   ...repository SQL, filtered by RLS policies...
 *   rollback;                                            -- or commit
 *
 * Consequence: a repository cannot accidentally read another business's rows,
 * because the database — not the query author — decides visibility.
 *
 * Two modes:
 *
 *   - `withActor`      sets a signed-in user or a scoped service token. This is
 *                      what every application read/write uses.
 *   - `withServiceRole` bypasses RLS by switching to the table owner. This exists
 *                      ONLY for bootstrap (first admin, first business) and for
 *                      the seed path, and is audit-logged by its callers. It is
 *                      never reachable from a normal request handler.
 */
import 'server-only';

import { getSql, type Db } from './db';
import type { SqlExecutor } from './sql';

export interface UserActor {
  readonly kind: 'user';
  readonly userId: string;
}

export interface ApiClientActor {
  readonly kind: 'api_client';
  readonly apiClientId: string;
}

export interface ServiceActor {
  readonly kind: 'service';
}

export type Actor = UserActor | ApiClientActor | ServiceActor;

/** Everything a screen needs to know about who is looking at it. */
export interface Viewer {
  readonly actor: Actor;
  readonly userId: string | null;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly role: 'admin' | 'manager' | 'user' | null;
  /** True when the actor bypasses RLS (bootstrap/seed only). */
  readonly isService: boolean;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Runs `fn` inside one transaction that carries `actor`'s identity.
 *
 * The transaction is rolled back when `fn` throws and committed otherwise, so a
 * multi-statement write is atomic without every caller remembering to open one.
 */
export async function withActor<T>(actor: Actor, fn: (sql: Db) => Promise<T>): Promise<T> {
  const sql = await getSql();
  return transaction(sql, actor, fn);
}

async function transaction<T>(
  sql: SqlExecutor,
  actor: Actor,
  fn: (sql: Db) => Promise<T>,
): Promise<T> {
  await sql.exec('begin');
  let committed = false;
  try {
    await sql.exec('set local role authenticated');

    if (actor.kind === 'user') {
      await sql.exec(
        `select set_config('request.jwt.claims', ${quoteLiteral(JSON.stringify({ sub: actor.userId, role: 'authenticated' }))}, true)`,
      );
      await sql.exec(`select set_config('nexus.api_client_id', '', true)`);
    } else if (actor.kind === 'api_client') {
      await sql.exec(`select set_config('request.jwt.claims', '{}', true)`);
      await sql.exec(
        `select set_config('nexus.api_client_id', ${quoteLiteral(actor.apiClientId)}, true)`,
      );
    } else {
      await sql.exec(`select set_config('request.jwt.claims', '{}', true)`);
      await sql.exec(`select set_config('nexus.api_client_id', '', true)`);
    }

    const result = await fn(sql);
    await sql.exec('commit');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      // A failed statement poisons the transaction; rolling back is what keeps
      // the shared connection usable for the next request.
      try {
        await sql.exec('rollback');
      } catch {
        // The connection is already unusable; the next query will surface it.
      }
    }
  }
}

/**
 * RLS-bypassing transaction for bootstrap and seeding.
 *
 * `row_security = off` is what allows the table owner to write the first admin
 * row before any policy can match. Callers MUST be explicit about why; nothing in
 * a normal request path may call this.
 *
 * The claims are set to an administrator because a `security definer` trigger can still read
 * them, and several do: `validate_browser_session_identity` asks whether the actor may manage the
 * identity. Leaving `request.jwt.claims` empty made those triggers evaluate as an anonymous
 * caller, so a trusted seed or bootstrap write was refused by a rule that the transaction is, by
 * definition, exempt from. Setting them states what this transaction is — a trusted writer acting
 * with administrator authority — rather than pretending there is no actor at all.
 */
export async function withServiceRole<T>(reason: string, fn: (sql: Db) => Promise<T>): Promise<T> {
  if (reason.trim().length === 0) {
    throw new Error('withServiceRole requires a stated reason; it bypasses RLS');
  }
  const sql = await getSql();
  await sql.exec('begin');
  await sql.exec('set local row_security = off');
  await sql.exec(
    `select set_config('request.jwt.claims', ${quoteLiteral(JSON.stringify({ role: 'service_role' }))}, true)`,
  );
  await sql.exec(`select set_config('nexus.api_client_id', '', true)`);
  try {
    const result = await fn(sql);
    await sql.exec('commit');
    return result;
  } catch (error) {
    try {
      await sql.exec('rollback');
    } catch {
      /* see above */
    }
    throw error;
  }
}

/** Reads the viewer's own profile row (RLS permits self-read). */
export async function loadViewer(actor: Actor): Promise<Viewer> {
  if (actor.kind === 'service') {
    return { actor, userId: null, email: null, fullName: null, role: null, isService: true };
  }

  return withActor(actor, async (sql) => {
    if (actor.kind === 'api_client') {
      const client = await sql.query<{ name: string }>(
        `select name from public.api_clients where id = $1`,
        [actor.apiClientId],
      );
      return {
        actor,
        userId: null,
        email: null,
        fullName: client.rows[0]?.name ?? null,
        role: null,
        isService: false,
      };
    }

    const result = await sql.query<{
      id: string;
      email: string;
      full_name: string | null;
      role: 'admin' | 'manager' | 'user';
    }>(`select id, email, full_name, role from public.users where id = $1`, [actor.userId]);

    const row = result.rows[0];
    return {
      actor,
      userId: actor.userId,
      email: row?.email ?? null,
      fullName: row?.full_name ?? null,
      role: row?.role ?? null,
      isService: false,
    };
  });
}
