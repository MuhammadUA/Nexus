/**
 * Dumps the ids the browser capture pass needs.
 *
 * Screenshots have to be taken on real rows — a lead detail page at a made-up id would
 * render the not-found branch and be recorded as a passing screen. Run from `apps/web`.
 */
import { PGlite } from '@electric-sql/pglite';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const db = await PGlite.create({ dataDir: path.join(process.cwd(), '.data', 'nexus') });
await db.exec('set row_security = off');

const one = async (sql) => (await db.query(sql)).rows[0] ?? null;

const target = {
  businesses: (await db.query(`select key, name from public.businesses where deleted_at is null order by key`)).rows,
  zemnas: await one(`select id, key from public.businesses where key = 'zemnas'`),
  lavish: await one(`select id, key from public.businesses where key = 'lavish-foods'`),
  ai: await one(`select id, key from public.businesses where key = 'ai-integrations'`),
  leads: (
    await db.query(
      `select l.id, l.status, l.business_id, b.key as business_key, p.full_name
         from public.leads l
         join public.businesses b on b.id = l.business_id
         join public.people p on p.id = l.person_id
        where l.deleted_at is null
        order by l.status, p.full_name`,
    )
  ).rows,
  icps: (await db.query(`select id, name, business_id from public.icps where deleted_at is null order by name`)).rows,
  identities: (await db.query(`select id, display_name, status from public.outreach_identities order by display_name`)).rows,
  users: (await db.query(`select id, email, role from public.users order by role, email`)).rows,
  counts: {},
};

for (const table of [
  'leads',
  'tasks',
  'notes',
  'interactions',
  'conversations',
  'conversation_outcomes',
  'sequence_enrollments',
  'message_instances',
  'import_batches',
  'import_rows',
  'duplicate_candidates',
  'profile_capture_queue',
  'automation_configs',
  'agent_runs',
  'signals',
  'source_evidence',
  'saved_views',
  'companies',
  'people',
]) {
  const row = await one(`select count(*)::int as n from public.${table}`);
  target.counts[table] = row?.n ?? 0;
}

writeFileSync('E:/CRM/ui-audit/seed-ids.json', JSON.stringify(target, null, 2), 'utf8');
console.log('businesses', target.businesses.map((b) => b.key).join(', '));
console.log('leads', target.leads.length);
console.log('counts', JSON.stringify(target.counts));
await db.close();
