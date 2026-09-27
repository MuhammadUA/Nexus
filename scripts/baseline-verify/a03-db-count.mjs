/**
 * A03 scratch probe — counts the real seeded leads for one business.
 *
 *   node scripts/baseline-verify/a03-db-count.mjs [businessKey]
 *
 * Read-only. Opens the embedded PGlite data dir the app uses. PGlite is
 * single-process: run this only while no server holds the same data dir.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', '..', 'apps', 'web');
const appRequire = createRequire(path.join(appDir, 'package.json'));
const { PGlite } = await import(pathToFileURL(appRequire.resolve('@electric-sql/pglite')).href);

const key = process.argv[2] ?? 'zemnas';
const db = await PGlite.create({ dataDir: path.join(appDir, '.data', 'nexus') });
await db.exec('set row_security = off');

const business = (await db.query(`select id, key, name from public.businesses where key = $1`, [key])).rows[0];
if (business === undefined) {
  console.log(JSON.stringify({ error: `no business with key ${key}` }));
} else {
  const totals = (
    await db.query(
      `select count(*)::int as total,
              count(*) filter (where deleted_at is null)::int as active,
              count(*) filter (where deleted_at is not null)::int as deleted,
              count(*) filter (where deleted_at is null and needs_profile)::int as needs_profile,
              count(*) filter (where deleted_at is null and status = 'replied')::int as replied,
              count(*) filter (where deleted_at is null and status = 'dormant')::int as dormant,
              count(*) filter (where deleted_at is null and is_dnc)::int as dnc,
              count(*) filter (where deleted_at is null
                                 and (status in ('followup_due','connection_due','message_due','cooldown','reactivation_due')
                                      or next_action_at is not null))::int as followups
         from public.leads where business_id = $1`,
      [business.id],
    )
  ).rows[0];
  const byStatus = (
    await db.query(
      `select status, count(*)::int as n from public.leads
        where business_id = $1 and deleted_at is null group by status order by status`,
      [business.id],
    )
  ).rows;
  const savedViews = (
    await db.query(`select name, scope, is_shared from public.saved_views where business_id = $1 order by name`, [
      business.id,
    ])
  ).rows;
  console.log(JSON.stringify({ business, totals, byStatus, savedViews }, null, 2));
}

await db.close();
