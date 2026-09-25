/**
 * `pnpm db:verify` — proves the migration set applies cleanly and reports what it
 * created.
 *
 * This is the check to run before trusting a schema change: it applies every
 * migration from scratch on a real PostgreSQL engine (PGlite), then asserts the
 * table, policy, trigger and function counts the contract promises, plus the
 * invariants that are cheap to verify structurally.
 */
import { PGlite } from '@electric-sql/pglite';

import { applyMigrations, listMigrations } from '../src/migrate.ts';

interface Counts {
  tables: number;
  policies: number;
  triggers: number;
  functions: number;
  indexes: number;
}

async function counts(db: PGlite): Promise<Counts> {
  const result = await db.query<{
    tables: number;
    policies: number;
    triggers: number;
    functions: number;
    indexes: number;
  }>(`
    select
      (select count(*)::int from pg_tables where schemaname = 'public') as tables,
      (select count(*)::int from pg_policies where schemaname = 'public') as policies,
      (select count(*)::int from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal) as triggers,
      (select count(*)::int from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public') as functions,
      (select count(*)::int from pg_indexes where schemaname = 'public') as indexes
  `);
  return (
    result.rows[0] ?? { tables: 0, policies: 0, triggers: 0, functions: 0, indexes: 0 }
  );
}

async function main(): Promise<void> {
  const db = await PGlite.create();

  try {
    const files = await listMigrations();
    console.log(`Applying ${String(files.length)} migrations to a clean database…`);
    const applied = await applyMigrations(db);
    console.log(`  applied: ${applied.join(', ')}`);

    const c = await counts(db);
    console.log('\nSchema objects:');
    console.log(`  tables    ${String(c.tables)}`);
    console.log(`  policies  ${String(c.policies)}`);
    console.log(`  triggers  ${String(c.triggers)}`);
    console.log(`  functions ${String(c.functions)}`);
    console.log(`  indexes   ${String(c.indexes)}`);

    // Structural assertions: fail loudly rather than printing a number nobody reads.
    const problems: string[] = [];

    if (c.policies === 0) problems.push('no RLS policies exist');
    if (c.triggers === 0) problems.push('no triggers exist');
    if (c.tables < 55) problems.push(`expected at least 55 tables, found ${String(c.tables)}`);

    // Every business-scoped table must have RLS enabled AND forced.
    const unforced = await db.query<{ relname: string }>(`
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'business_id' and a.attnum > 0)
         and (not c.relrowsecurity or not c.relforcerowsecurity)
    `);
    for (const row of unforced.rows) {
      problems.push(`table ${row.relname} has business_id but does not FORCE row level security`);
    }

    // The forbidden capability must not exist anywhere in the schema.
    const forbidden = await db.query<{ n: number }>(`
      select count(*)::int as n
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (p.proname ilike '%execute_sql%' or p.proname ilike '%exec_sql%')
    `);
    if ((forbidden.rows[0]?.n ?? 0) > 0) {
      problems.push('a SQL-execution function exists; spec mcp_contract.forbidden_tool forbids it');
    }

    if (problems.length > 0) {
      console.error('\nVerification FAILED:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }

    console.log('\nVerification passed.');
  } finally {
    await db.close();
  }
}

await main();
