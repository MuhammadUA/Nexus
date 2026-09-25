/**
 * Runs the repository SQL the failing screens use, straight against the database.
 *
 * A browser pass tells you a screen failed; it does not tell you which statement. These
 * two reads are the ones that were throwing, so they are exercised here as plain SQL
 * before the screens are re-checked in the browser.
 *
 * Run from `apps/web`.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const seed = JSON.parse(readFileSync('E:/CRM/ui-audit/seed-ids.json', 'utf8'));
const zemnas = seed.businesses.find((b) => b.key === 'zemnas').id;
const lavish = seed.businesses.find((b) => b.key === 'lavish-foods').id;

const db = await PGlite.create({ dataDir: path.join(process.cwd(), '.data', 'nexus') });
await db.exec('set row_security = off');

const probe = async (label, sql, params) => {
  try {
    const result = await db.query(sql, params);
    console.log(`OK   ${label.padEnd(28)} rows=${String(result.rows.length)}`);
    return result.rows;
  } catch (error) {
    console.log(`FAIL ${label.padEnd(28)} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return [];
  }
};

const candidateSelect = `
  select d.id, d.business_id, d.status, d.match_reason, d.confidence, d.resolution,
         d.created_at, d.resolved_at, d.payload, d.incoming_person_id, d.existing_person_id,
         d.existing_lead_id, il.id as incoming_lead_id, ru.full_name as resolved_by_name,
         ip.id as incoming_id, ip.full_name as incoming_full_name,
         ep.id as existing_id, ep.full_name as existing_full_name
    from public.duplicate_candidates d
    left join public.users ru on ru.id = d.resolved_by
    left join public.people ip on ip.id = d.incoming_person_id
    left join public.people ep on ep.id = d.existing_person_id
    left join lateral (
      select l.id
        from public.leads l
       where l.person_id = d.incoming_person_id
         and l.business_id = d.business_id
         and l.deleted_at is null
       order by l.created_at desc
       limit 1
    ) il on true`;

await probe('duplicates candidates', `${candidateSelect} where d.business_id = $1 and d.status = $2`, [zemnas, 'open']);
await probe(
  'duplicates counts',
  `select count(*) filter (where status = 'open')::int as open from public.duplicate_candidates where business_id = $1`,
  [zemnas],
);
await probe(
  'reactivation candidates',
  `select l.id as lead_id, p.full_name as person_name, c.name as company_name,
          e.dormant_at, e.reactivation_due_at, e.current_step_order,
          (select max(mi.sent_at) from public.message_instances mi
            where mi.lead_id = l.id and mi.sent_at is not null) as last_step_sent_at
     from public.leads l
     join public.people p on p.id = l.person_id
     left join public.companies c on c.id = l.company_id
     join public.sequence_enrollments e on e.lead_id = l.id
    where l.business_id = $1 and l.deleted_at is null
      and e.state in ('dormant', 'reactivation_due')
    order by e.reactivation_due_at nulls last, e.dormant_at
    limit $2`,
  [zemnas, 50],
);

const dormant = seed.leads.find((l) => l.status === 'dormant' && l.business_key === 'zemnas');
if (dormant !== undefined) {
  await probe(
    'reactivation dormancy row',
    `select e.lead_id, e.state, e.current_step_order, e.dormant_at, e.reactivation_due_at,
            (select (ps.value #>> '{}')::int from public.platform_settings ps
              where ps.business_id = e.business_id and ps.key = 'sequence.dormancy_days') as dormancy_days,
            (select (ps.value #>> '{}')::int from public.platform_settings ps
              where ps.business_id = e.business_id and ps.key = 'sequence.reactivation_days') as reactivation_days,
            (select max(mi.sent_at) from public.message_instances mi
              where mi.lead_id = e.lead_id and mi.sent_at is not null) as last_step_sent_at
       from public.sequence_enrollments e
      where e.lead_id = $1 limit 1`,
    [dormant.id],
  );
  await probe(
    'reactivation prior messages',
    `select m.id, m.step_order, m.step_kind, m.sent_at, mv.content
       from public.message_instances m
       left join public.message_versions mv on mv.id = m.current_version_id
      where m.lead_id = $1 order by m.step_order`,
    [dormant.id],
  );
  await probe(
    'reactivation fresh signals',
    `select s.id, s.kind, s.polarity, s.strength, s.label, s.detail, s.observed_at
       from public.signals s where s.lead_id = $1 order by s.observed_at desc limit 10`,
    [dormant.id],
  );
}

// Every lead the capture pass is going to open, in the business it is opened under.
for (const [label, businessId, status] of [
  ['lead detail needs_profile', zemnas, 'needs_profile'],
  ['lead detail replied', zemnas, 'replied'],
  ['lead detail dnc', zemnas, 'do_not_contact'],
]) {
  const lead = seed.leads.find((l) => l.status === status && l.business_id === businessId);
  await probe(label, `select l.id, p.full_name from public.leads l join public.people p on p.id = l.person_id where l.id = $1 and l.business_id = $2`, [
    lead?.id ?? '00000000-0000-4000-8000-000000000000',
    businessId,
  ]);
}

await db.close();
