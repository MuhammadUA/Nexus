/**
 * The migration set must be **idempotent**.
 *
 * This is not a stylistic preference: `apps/web` applies the whole migration set on
 * every boot when it runs on the embedded PostgreSQL driver, so a migration that fails
 * on re-application takes the server down on its *second* start — after a first start
 * that looked perfectly healthy.
 *
 * That is exactly how a live bug was found. `0015_local_credentials.sql` seeded a
 * global `platform_settings` row with `on conflict (business_id, key) do nothing`. The
 * composite constraint on that table is `NULLS DISTINCT`, so it can never match a row
 * whose `business_id IS NULL`; the insert proceeded and then collided with the partial
 * index `platform_settings_global_key`. A fresh-database test cannot see this, because
 * the conflict only arises on the *second* run.
 *
 * So this suite applies the set twice to the same database and asserts the second pass
 * is clean, then checks the seeded default did not get duplicated.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from '../src/migrate';

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
}, 240_000);

afterAll(async () => {
  await db.close();
});

describe('the migration set is re-appliable', () => {
  it('applies cleanly the first time', async () => {
    const applied = await applyMigrations(db);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toContain('0015_local_credentials.sql');
  });

  it('applies cleanly a second time against the same database', async () => {
    // The assertion is simply that this resolves. A duplicate-key error here means a
    // `on conflict` clause targets a constraint that cannot match a NULLable column.
    await expect(applyMigrations(db)).resolves.toBeDefined();
  });

  it('a third pass is also clean, so retries are safe', async () => {
    await expect(applyMigrations(db)).resolves.toBeDefined();
  });

  it('did not duplicate the global platform-setting default', async () => {
    const result = await db.query<{ n: number }>(
      `select count(*)::int as n from public.platform_settings
        where business_id is null and key = 'security.local_auth_enabled'`,
    );
    expect(result.rows[0]?.n).toBe(1);
  });

  it('still seeds one row for every global default', async () => {
    // The initial row count from migration 0010 plus the one added by 0015.
    const result = await db.query<{ n: number }>(
      `select count(*)::int as n from public.platform_settings where business_id is null`,
    );
    expect(result.rows[0]?.n).toBe(13);
  });

  it('keeps the schema intact after re-application', async () => {
    const counts = await db.query<{ tables: number; policies: number }>(`
      select
        (select count(*)::int from pg_tables where schemaname = 'public') as tables,
        (select count(*)::int from pg_policies where schemaname = 'public') as policies
    `);
    expect(counts.rows[0]?.tables).toBeGreaterThanOrEqual(63);
    expect(counts.rows[0]?.policies).toBeGreaterThanOrEqual(179);
  });
});
