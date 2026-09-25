/**
 * Development / visual-QA seed.
 *
 * **Why this exists.** Every screen in this app branches on data: the business-scoped
 * layout shows "No businesses yet" and the individual screens behind it never render. So
 * a deployment with an empty database cannot be visually reviewed at all — the UI looks
 * like a blank shell regardless of how complete it is. This script puts the database into
 * a state where every visual state a screen can render is reachable.
 *
 * **What it is not.** Not a fixture for tests (those live in `packages/db/seed/fixtures.ts`
 * and are deliberately minimal), and not production behaviour. Names come from
 * `seed_and_demo_policy.allowed_demo_names` / `allowed_demo_companies` and
 * `business_units.examples`, so no invented company appears and nothing here is referenced
 * by application code.
 *
 * It writes through the same tables the application does, including the invariant
 * triggers, so if this script ever produced an invalid state the database would refuse it.
 * That is deliberate: a seed that bypassed the rules would hide exactly the bugs the UI
 * needs to handle.
 *
 * Usage:
 *   node --experimental-strip-types scripts/seed-demo.ts [--reset]
 *
 * `--reset` soft-deletes the demo businesses first so re-running is repeatable.
 */
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '@nexus/db/migrate';

import { OP_IDS, seedOperational } from './seed-demo-operational.ts';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const N = 32_768;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 256 * N * r * 2 });
  return ['scrypt', String(N), String(r), String(p), salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Deterministic ids so a re-run is idempotent and screenshots are comparable. */
const id = (group: string, n: number): string =>
  `${group.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const IDS = {
  manager: id('d0000001', 2),
  osama: id('d0000001', 3),
  bisma: id('d0000001', 4),

  zemnas: id('d0000002', 1),
  lavish: id('d0000002', 2),
  ai: id('d0000002', 3),

  icpMedia: id('d0000003', 1),
  icpAgency: id('d0000003', 2),
  icpExport: id('d0000003', 3),
  icpGcc: id('d0000003', 4),

  seqZemnas: id('d0000004', 1),
  seqVerZemnas: id('d0000004', 2),

  identityOsama: id('d0000005', 1),
  identityBisma: id('d0000005', 2),
  identityJames: id('d0000005', 3),

  taskA1: id('d0000006', 1),
  taskA2: id('d0000006', 2),
  taskOverdue: id('d0000006', 3),
} as const;

/** The spec's permitted demo people and companies. Nothing invented. */
const PEOPLE = [
  'Tom Henry',
  'Sarah Smith',
  'Mia Becker',
  'Jon Davies',
  'Nora Schmidt',
  'Lisa Weber',
] as const;
const COMPANIES = ['Frame House', 'ABC Media', 'Kite Studio', 'Northstar', 'Nova Haus', 'Studio 8'] as const;

const db = await PGlite.create({ dataDir: path.join(process.cwd(), '.data', 'nexus') });
const reset = process.argv.includes('--reset');

/** Wraps a statement so a failure names the step that broke. */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error(`\nFAILED at: ${label}`);
    console.error(error instanceof Error ? error.message : error);
    throw error;
  }
}

try {
  await applyMigrations(db);
  await db.exec('set row_security = off');

  if (reset) {
    // Leaves first, then the root rows. Deleting the businesses alone would fail on the
    // foreign keys from leads, conversations and imports.
    //
    // Two groups of triggers have to be disarmed for the reset window:
    //
    //   * `prevent_hard_delete` (leads, people, companies) turns a DELETE into a soft
    //     delete, which leaves the previous demo rows in place with `deleted_at` set and
    //     would make the next insert collide on `social_profiles_platform_url_key`.
    //   * `trg_audit_events_immutable` refuses any UPDATE or DELETE of `audit_events`, so
    //     the audit rows written by those soft deletes could never be pruned.
    //
    // The per-table audit triggers are disarmed too: deleting a business makes them try to
    // write an `audit_events` row that still points at the business being deleted, which
    // `audit_events_business_id_fkey` then refuses.
    //
    // Message immutability is disarmed as well. A SENT `message_instance` and its versions
    // are append-only by design ("corrections use a new message_events row"), so a previous
    // run's sent messages cannot be removed while those triggers are armed.
    //
    // All of them are re-armed in a `finally`, so a failed reset cannot leave the database
    // with its append-only guarantees switched off.
    const disarmed: { table_name: string; trigger_name: string }[] = [];
    try {
      const found = await db.query<{ table_name: string; trigger_name: string }>(
        `select c.relname as table_name, t.tgname as trigger_name
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_namespace n on n.oid = c.relnamespace
          where not t.tgisinternal
            and n.nspname = 'public'
            and (pg_get_triggerdef(t.oid) like '%prevent_hard_delete%'
                 or pg_get_triggerdef(t.oid) like '%audit_row_change%'
                 or pg_get_triggerdef(t.oid) like '%enforce_message_immutability%'
                 or c.relname = 'audit_events')`,
      );
      for (const trigger of found.rows) {
        await db.exec(`alter table public.${trigger.table_name} disable trigger ${trigger.trigger_name}`);
        disarmed.push(trigger);
      }

      const inDemo = `('${IDS.zemnas}','${IDS.lavish}','${IDS.ai}')`;
      const byBusiness = [
        'contact_suppressions',
        'cooldowns',
        'conversation_outcomes',
        'message_instances',
        'conversations',
        'sequence_enrollments',
        'interactions',
        'tasks',
        'notes',
        'duplicate_candidates',
        'profile_capture_queue',
        'import_batches',
        'signals',
        'source_evidence',
        'lead_assignments',
        'leads',
        'agent_runs',
        'automation_configs',
        'saved_views',
      ];
      // These three have no `business_id`; they hang off a parent row instead.
      await db.exec(
        `delete from public.message_versions where message_instance_id in (select id from public.message_instances where business_id in ${inDemo})`,
      );
      await db.exec(
        `delete from public.import_rows where batch_id in (select id from public.import_batches where business_id in ${inDemo})`,
      );
      await db.exec(
        `delete from public.lead_icp_matches where lead_id in (select id from public.leads where business_id in ${inDemo})`,
      );
      await db.exec(`delete from public.audit_events where business_id in ${inDemo}`);
      for (const table of byBusiness) {
        await db.exec(`delete from public.${table} where business_id in ${inDemo}`);
      }
      await db.exec(`delete from public.people where id::text like 'd0000011%'`);
      await db.exec(`delete from public.companies where id::text like 'd0000010%'`);
      await db.exec(`delete from public.businesses where id in ${inDemo}`);
      await db.exec(`delete from public.audit_events where business_id in ${inDemo}`);
    } finally {
      for (const trigger of disarmed) {
        await db.exec(`alter table public.${trigger.table_name} enable trigger ${trigger.trigger_name}`);
      }
    }
    console.log('reset: removed the previous demo businesses and their operational rows');
  }

  // ------------------------------------------------------------------ users --
  // The admin is resolved by email rather than assumed to have a fixed id: a
  // deployment may already have been bootstrapped through the CLI or the UI, and that
  // row must be reused so the documented password keeps working.
  const admin = await step('admin account', async () => {
    const existing = await db.query<{ id: string }>(
      `select id from public.users where lower(email) = 'admin@nexus.local'`,
    );
    if (existing.rows[0] !== undefined) return existing.rows[0].id;

    const inserted = await db.query<{ id: string }>(
      `insert into public.users (email, full_name, role, status)
       values ('admin@nexus.local', 'Nexus Administrator', 'admin', 'active')
       returning id`,
    );
    const created = inserted.rows[0]?.id;
    if (created === undefined) throw new Error('the admin row was not created');
    return created;
  });
  const adminId = admin;

  await step('admin credential', async () => {
    await db.query(
      `insert into public.user_credentials (user_id, password_hash) values ($1, $2)
       on conflict (user_id) do update set password_hash = excluded.password_hash, failed_attempts = 0, locked_until = null`,
      [adminId, await hashPassword('vXbSm5c4ujtayWGR4ICuXny4')],
    );
  });

  await step('demo users', async () => {
    const demoHash = await hashPassword('demo-password-1234');

    for (const [userId, email, name, role] of [
      [IDS.manager, 'manager@nexus.local', 'Nora Manager', 'manager'],
      [IDS.osama, 'osama@nexus.local', 'Osama Sender', 'user'],
      [IDS.bisma, 'bisma@nexus.local', 'Bisma Sender', 'user'],
    ] as const) {
      await db.query(
        `insert into public.users (id, email, full_name, role, status) values ($1, $2, $3, $4, 'active')
         on conflict (id) do nothing`,
        [userId, email, name, role],
      );
      await db.query(
        `insert into public.user_credentials (user_id, password_hash) values ($1, $2)
         on conflict (user_id) do update set password_hash = excluded.password_hash`,
        [userId, demoHash],
      );
    }
  });

  // ------------------------------------------------------------- businesses --
  await step('businesses', async () => {
    // spec `business_units.examples`, verbatim.
    await db.query(
      `insert into public.businesses (id, key, name, focus, regions, status, created_by) values
         ($1, 'zemnas',        'Zemnas Creative Studio', 'White-label post-production / video editing', array['US','UK','Germany'], 'active', $4),
         ($2, 'lavish-foods',  'Lavish Foods',           'Rice manufacturing / export / distribution',  array['Germany','Europe'], 'active', $4),
         ($3, 'ai-integrations','AI Integrations',       'AI integration services',                     array['GCC'],             'active', $4)
       on conflict (id) do nothing`,
      [IDS.zemnas, IDS.lavish, IDS.ai, adminId],
    );

    await db.query(
      `insert into public.business_domains (business_id, domain, normalized_domain, domain_type, is_default, notes) values
         ($1, 'zemnas.com',        'zemnas.com',        'primary', true,  'Official Zemnas domain'),
         ($1, 'zemnas.studio',     'zemnas.studio',     'alias',   false, 'Secondary brand domain'),
         ($2, 'lavishfoods.de',    'lavishfoods.de',    'primary', true,  'German entity'),
         ($2, 'lavishfoods.com.pk','lavishfoods.com.pk','alias',   false, 'Pakistan entity'),
         ($3, 'axelliant.com',     'axelliant.com',     'primary', true,  'Parent/source domain')
       on conflict do nothing`,
      [IDS.zemnas, IDS.lavish, IDS.ai],
    );
  });

  // ------------------------------------------------------------- access ------
  await step('access grants', async () => {
    // Admin: every business. Manager: Zemnas only. Senders: scoped to their business.
    await db.query(
      `insert into public.user_business_access
         (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads, created_by)
       values
         ($1,$4,'admin',  true,true, true, true, $1),
         ($1,$5,'admin',  true,true, true, true, $1),
         ($1,$6,'admin',  true,true, true, true, $1),
         ($2,$4,'manager',true,true, true, false,$1),
         ($3,$4,'user',   true,true, true, false,$1),
         ($7,$5,'user',   true,true, true, false,$1)
       on conflict (user_id, business_id) do nothing`,
      [adminId, IDS.manager, IDS.osama, IDS.zemnas, IDS.lavish, IDS.ai, IDS.bisma],
    );
  });

  // --------------------------------------------------------------- ICPs ------
  await step('icps', async () => {
    await db.query(
      `insert into public.icps (id, business_id, name, description, criteria, is_default, is_active, created_by) values
         ($1,$5,'Media companies hiring editors','Content and media firms scaling video output',
          '{"company_types":["Media","Post-production","Advertising"],"buyer_titles":["Head of Production","Content Lead"],"markets":["US","UK"],"exclusions":["wedding only"]}'::jsonb, true,  true, $8),
         ($2,$5,'Creative agencies','Agencies needing overflow editing capacity',
          '{"company_types":["Agency"],"buyer_titles":["Creative Director","Producer"]}'::jsonb, false, true, $8),
         ($3,$6,'European food importers','Rice importers and distributors in the EU',
          '{"company_types":["Importer","Distributor"],"geographies":["Germany","Netherlands"]}'::jsonb, true, true, $8),
         ($4,$7,'GCC enterprise IT','Enterprise IT teams adopting AI integration',
          '{"company_types":["Enterprise"],"geographies":["UAE","Saudi Arabia"]}'::jsonb, true, true, $8)`,
      [IDS.icpMedia, IDS.icpAgency, IDS.icpExport, IDS.icpGcc, IDS.zemnas, IDS.lavish, IDS.ai, adminId],
    );

    // Scores are configuration, not constants (spec `signals_and_scoring.rule`).
    // `signal_kind` values come from the `scoring_rules_signal_kind_check` constraint in
    // 0003_business_brain.sql — the spec's example weights, expressed in the vocabulary
    // the schema actually allows.
    await db.query(
      `insert into public.scoring_rules (target_type, target_id, signal_kind, polarity, points, label, is_active) values
         ('icp', $1, 'hiring',                 'positive',  30, 'Actively hiring editor',       true),
         ('icp', $1, 'contractor_need',        'positive',  20, 'Contractor / freelancer need', true),
         ('icp', $1, 'content_output',         'positive',  15, 'Frequent video output',        true),
         ('icp', $1, 'geography_size',         'positive',  10, 'Target geography / size',      true),
         ('icp', $1, 'negative_recruitment',   'negative', -30, 'Recruitment intermediary',     true),
         ('icp', $1, 'negative_wedding_only',  'negative', -30, 'Wedding-only business',        true),
         ('icp', $1, 'negative_stale_vacancy', 'negative', -20, 'Stale vacancy',                true),
         ('icp', $1, 'negative_geography',     'negative', -20, 'Wrong geography',              true)`,
      [IDS.icpMedia],
    );
  });

  // ---------------------------------------------------------- sequences ------
  await step('sequences', async () => {
    // `sequences.current_version_id` -> `sequence_versions.sequence_id` is circular, so
    // the sequence is created with a null pointer, the published version is inserted,
    // and only then is the pointer set. Doing it in one statement violates
    // `sequences_current_version_fk`.
    await db.query(
      `insert into public.sequences (id, business_id, name, description, is_default, status, created_by)
       values ($1,$2,'Zemnas default outreach','Connection then Message 1 and three follow-ups', true, 'active', $3)
       on conflict (id) do nothing`,
      [IDS.seqZemnas, IDS.zemnas, adminId],
    );
    await db.query(
      `insert into public.sequence_versions (id, sequence_id, version, status, published_at, published_by, change_summary)
       values ($1,$2,1,'published', now(), $3, 'Initial published sequence')
       on conflict (id) do nothing`,
      [IDS.seqVerZemnas, IDS.seqZemnas, adminId],
    );
    await db.query(
      `update public.sequences set current_version_id = $2, updated_at = now() where id = $1`,
      [IDS.seqZemnas, IDS.seqVerZemnas],
    );
    // The spec's default cadence: Message 1, FU1 +3d, FU2 +4d, FU3 +7d.
    await db.query(
      `insert into public.sequence_steps
         (sequence_version_id, step_order, kind, name, delay_days, delay_basis, goal, word_max, cta_style,
          prohibited_phrases, tone, generation_mode, allowed_context, proof_policy)
       values
         ($1,1,'message','Message 1',0,'after_previous','Initial outreach',80,'low_pressure',
          array['I hope you''re well','following up','quick question','I came across your profile'],'direct','ai',array['signal'],'approved_only'),
         ($1,2,'followup','Follow-up 1',3,'after_previous','Short relevant follow-up',60,'low_pressure',
          array['following up','quick question'],'direct','ai',array['signal'],'approved_only'),
         ($1,3,'followup','Follow-up 2',4,'after_previous','New angle / proof',60,'low_pressure',
          array['following up'],'direct','ai',array['case_study'],'approved_only'),
         ($1,4,'followup','Follow-up 3',7,'after_previous','Close loop, low pressure',60,'low_pressure',
          array['following up'],'direct','ai',array['case_study'],'approved_only')
       on conflict (sequence_version_id, step_order) do nothing`,
      [IDS.seqVerZemnas],
    );
  });

  // ------------------------------------------------------ sender identities --
  await step('outreach identities', async () => {
    await db.query(
      `insert into public.outreach_identities (id, platform, display_name, profile_url, managed_by_user_id, status, daily_target, created_by) values
         ($1,'linkedin','Osama - Zemnas',   'https://www.linkedin.com/in/osama-zemnas', $4,'active',25,$4),
         ($2,'linkedin','Bisma - Lavish',   'https://www.linkedin.com/in/bisma-lavish', $5,'active',20,$5),
         ($3,'linkedin','James - AI Int.',  'https://www.linkedin.com/in/james-ai',     $6,'paused',15,$6)
       on conflict (id) do nothing`,
      [IDS.identityOsama, IDS.identityBisma, IDS.identityJames, IDS.osama, IDS.bisma, adminId],
    );

    // Each identity carries its own business access (spec invariant 14).
    await db.query(
      `insert into public.outreach_identity_business_access (outreach_identity_id, business_id) values
         ($1,$4), ($1,$5), ($2,$6), ($3,$7)
       on conflict do nothing`,
      [IDS.identityOsama, IDS.identityBisma, IDS.identityJames, IDS.zemnas, IDS.lavish, IDS.ai, IDS.zemnas],
    );

    // A live browser binding, so the Companion's binding screen and the concurrency
    // warning both have something real to show.
    await db.query(
      `insert into public.browser_sessions (user_id, browser_fingerprint_or_install_id, outreach_identity_id, default_business_id, status, last_active_at, user_agent)
       values ($1,'demo-install-osama',$2,$3,'active', now(), 'Mozilla/5.0 (Visual QA seed)')
       on conflict do nothing`,
      [IDS.osama, IDS.identityOsama, IDS.zemnas],
    );
  });

  // ----------------------------------------------------------- knowledge -----
  await step('knowledge assets', async () => {
    // `$1` = Zemnas, `$2` = Lavish Foods, `$3` = author. Every placeholder is
    // referenced, so PostgreSQL can infer each parameter's type.
    await db.query(
      `insert into public.knowledge_assets
         (business_id, type, url, title, description, tags, ai_use_allowed, may_mention_client_name,
          may_mention_numeric_results, approval_state, created_by)
       values
         ($1,'Case Study','https://zemnas.com/work/abc-media','ABC Media delivery capacity',
          'Overflow editing for a media company during a peak release window.',
          array['editing','capacity'], true, true, false, 'approved', $3),
         ($1,'Portfolio','https://zemnas.com/work','Selected work', 'Portfolio of post-production work.',
          array['portfolio'], true, true, false, 'approved', $3),
         ($1,'Service','https://zemnas.com/services','White-label editing',
          'Editing handled in the background under the client brand.', array['service'], true, false, false, 'approved', $3),
         ($1,'Testimonial',null,'Production lead feedback','Client feedback about turnaround.',
          array['proof'], false, false, false, 'needs_review', $3),
         ($1,'Pricing',null,'Rate card','Internal pricing reference.',
          array['pricing'], false, false, false, 'draft', $3),
         ($2,'Case Study','https://lavishfoods.de/export','European distribution',
          'Rice distribution into German retail.', array['export'], true, true, true, 'approved', $3)
       on conflict do nothing`,
      [IDS.zemnas, IDS.lavish, adminId],
    );
  });

  // --------------------------------------------------------- operational -----
  const operational = await step('operational rows', () =>
    seedOperational(db, {
      adminId,
      managerId: IDS.manager,
      osamaId: IDS.osama,
      bismaId: IDS.bisma,
      zemnas: IDS.zemnas,
      lavish: IDS.lavish,
      ai: IDS.ai,
      icpMedia: IDS.icpMedia,
      icpAgency: IDS.icpAgency,
      icpExport: IDS.icpExport,
      icpGcc: IDS.icpGcc,
      seqZemnas: IDS.seqZemnas,
      seqVerZemnas: IDS.seqVerZemnas,
      identityOsama: IDS.identityOsama,
      identityBisma: IDS.identityBisma,
      identityJames: IDS.identityJames,
    }),
  );

  console.log('\ncore configuration seeded');
  console.log('  businesses   3  (zemnas, lavish-foods, ai-integrations)');
  console.log('  users        4  (admin, manager, 2 senders)');
  console.log('  identities   3  (2 active, 1 paused)');
  console.log('  ICPs         4');
  console.log('  sequences    1 published, 4 steps (0 / 3 / 4 / 7 days)');
  console.log('  knowledge    6 assets across approval states');
  console.log('\noperational rows seeded');
  console.log(`  leads        ${String(operational.leads)} (every status in leads_status_check)`);
  console.log('  companies    12');
  console.log('  people       33 (each with a LinkedIn social profile)');
  console.log(`  tasks        ${String(operational.tasks)} (open, overdue and completed)`);
  console.log(`  replies      ${String(operational.replies)} verbatim inbound replies with outcomes`);
  console.log('  imports      5 batches with per-row outcomes');
  console.log('  duplicates   3 open candidates');
  console.log('  queue        3 profile captures (1 in progress)');
  console.log('  automations  3 with agent runs');
  console.log('  saved views  3');
  console.log('\nadmin login: admin@nexus.local / vXbSm5c4ujtayWGR4ICuXny4');
  console.log('demo logins (manager + senders): <name>@nexus.local / demo-password-1234');
} finally {
  await db.exec('set row_security = on');
  await db.close();
}
