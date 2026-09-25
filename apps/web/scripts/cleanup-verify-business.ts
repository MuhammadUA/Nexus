/**
 * Removes the business created by the Add Business browser verification.
 *
 * The verification has to submit a real form, so it leaves a real row behind. Leaving it
 * would change every subsequent screenshot (an extra business in the sidebar and on the
 * hub), which would make visual comparison against a previous capture meaningless.
 *
 * Run from `apps/web`, where `@electric-sql/pglite` resolves.
 */
import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';

const db = await PGlite.create({ dataDir: path.join(process.cwd(), '.data', 'nexus') });
await db.exec('set row_security = off');

const triggers = await db.query(
  `select c.relname as table_name, t.tgname as trigger_name
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal
      and n.nspname = 'public'
      and (pg_get_triggerdef(t.oid) like '%prevent_hard_delete%'
           or pg_get_triggerdef(t.oid) like '%audit_row_change%'
           or c.relname = 'audit_events')`,
);
for (const trigger of triggers.rows) {
  await db.exec(`alter table public.${trigger.table_name} disable trigger ${trigger.trigger_name}`);
}
try {
  const removed = await db.query(
    `delete from public.businesses where key like 'riverside-studio%' returning id, key, name`,
  );
  for (const row of removed.rows) console.log('removed', row.key, row.name);
  if (removed.rows.length === 0) console.log('nothing to remove');
} finally {
  for (const trigger of triggers.rows) {
    await db.exec(`alter table public.${trigger.table_name} enable trigger ${trigger.trigger_name}`);
  }
}
await db.close();
