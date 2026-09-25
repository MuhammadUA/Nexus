/**
 * Seed / demo fixtures.
 *
 * These are TEST AND DEMO FIXTURES ONLY. Names are restricted to
 * `seed_and_demo_policy.allowed_demo_names` / `allowed_demo_companies` and the
 * businesses to `business_units.examples`. Nothing here is product behaviour and
 * nothing here is referenced by the migrations.
 *
 * The file exports fixed UUIDs so every test can address a record without
 * guessing, plus the SQL that creates the fixture graph.
 */

export const FIXTURE_IDS = {
  businessA: 'a0000000-0000-4000-8000-000000000001',
  businessB: 'a0000000-0000-4000-8000-000000000002',
  businessC: 'a0000000-0000-4000-8000-000000000003',

  admin: 'b0000000-0000-4000-8000-000000000001',
  manager: 'b0000000-0000-4000-8000-000000000002',
  user1: 'b0000000-0000-4000-8000-000000000003',
  user2: 'b0000000-0000-4000-8000-000000000004',
  userNoData: 'b0000000-0000-4000-8000-000000000005',

  icpA: 'c0000000-0000-4000-8000-000000000001',
  icpA2: 'c0000000-0000-4000-8000-000000000002',
  icpB: 'c0000000-0000-4000-8000-000000000003',

  sequenceA: 'd0000000-0000-4000-8000-000000000001',
  sequenceVersionA1: 'd0000000-0000-4000-8000-000000000002',
  stepMessage1: 'd0000000-0000-4000-8000-000000000011',
  stepFollowup1: 'd0000000-0000-4000-8000-000000000012',
  stepFollowup2: 'd0000000-0000-4000-8000-000000000013',
  stepFollowup3: 'd0000000-0000-4000-8000-000000000014',

  enrollmentLeadA2: 'e0000000-0000-4000-8000-000000000001',
  enrollmentLeadA3: 'e0000000-0000-4000-8000-000000000002',
  enrollmentLeadB1: 'e0000000-0000-4000-8000-000000000003',

  identityA1: 'f0000000-0000-4000-8000-000000000001',
  identityA2: 'f0000000-0000-4000-8000-000000000002',
  identityB1: 'f0000000-0000-4000-8000-000000000003',
  identityUnassigned: 'f0000000-0000-4000-8000-000000000004',

  companyFrameHouse: '11000000-0000-4000-8000-000000000001',
  companyAbcMedia: '11000000-0000-4000-8000-000000000002',
  companyKiteStudio: '11000000-0000-4000-8000-000000000003',
  companyNorthstar: '11000000-0000-4000-8000-000000000004',

  personTomHenry: '12000000-0000-4000-8000-000000000001',
  personSarahSmith: '12000000-0000-4000-8000-000000000002',
  personMiaBecker: '12000000-0000-4000-8000-000000000003',
  personJonDavies: '12000000-0000-4000-8000-000000000004',
  personNoraSchmidt: '12000000-0000-4000-8000-000000000005',
  personLisaWeber: '12000000-0000-4000-8000-000000000006',

  leadA1: '13000000-0000-4000-8000-000000000001',
  leadB1: '13000000-0000-4000-8000-000000000002',
  leadA2: '13000000-0000-4000-8000-000000000003',
  leadB2: '13000000-0000-4000-8000-000000000004',
  leadA3: '13000000-0000-4000-8000-000000000005',
  leadA4: '13000000-0000-4000-8000-000000000006',
  leadA5: '13000000-0000-4000-8000-000000000007',

  conversationLeadA2: '14000000-0000-4000-8000-000000000001',
  conversationLeadA3: '14000000-0000-4000-8000-000000000002',

  messageInstanceA2M1: '15000000-0000-4000-8000-000000000001',
  messageVersionA2M1: '15000000-0000-4000-8000-000000000002',

  taskLeadA1: '16000000-0000-4000-8000-000000000001',
  noteLeadA1: '16000000-0000-4000-8000-000000000002',

  apiClientLimited: '18000000-0000-4000-8000-000000000001',
  apiClientIngest: '18000000-0000-4000-8000-000000000002',

  importBatchA: '19000000-0000-4000-8000-000000000001',
  importRowA1: '19000000-0000-4000-8000-000000000002',
  evidenceA1: '1a000000-0000-4000-8000-000000000001',
  signalA1: '1a000000-0000-4000-8000-000000000002',
} as const;

/** demo businesses — spec business_units.examples, verbatim. */
export const DEMO_BUSINESSES = [
  { id: FIXTURE_IDS.businessA, key: 'zemnas', name: 'Zemnas Creative Studio' },
  { id: FIXTURE_IDS.businessB, key: 'lavish-foods', name: 'Lavish Foods' },
  { id: FIXTURE_IDS.businessC, key: 'ai-integrations', name: 'AI Integrations' },
] as const;

/**
 * The fixture graph. Executed once, as the table owner, with row security
 * bypassed — exactly like a Supabase service-role seed.
 */
export const FIXTURE_SQL = `
-- users ---------------------------------------------------------------------
insert into public.users (id, email, full_name, role) values
  ('${FIXTURE_IDS.admin}',   'admin@nexus.test',   'Nexus Admin',   'admin'),
  ('${FIXTURE_IDS.manager}', 'manager@nexus.test', 'Nexus Manager', 'manager'),
  ('${FIXTURE_IDS.user1}',   'user1@nexus.test',   'Nexus User One', 'user'),
  ('${FIXTURE_IDS.user2}',   'user2@nexus.test',   'Nexus User Two', 'user'),
  ('${FIXTURE_IDS.userNoData}', 'user3@nexus.test', 'Nexus User Three', 'user');

-- businesses ----------------------------------------------------------------
insert into public.businesses (id, key, name, focus, regions) values
  ('${FIXTURE_IDS.businessA}', 'zemnas',         'Zemnas Creative Studio', 'white-label post-production/video editing', '{US,UK,Germany}'),
  ('${FIXTURE_IDS.businessB}', 'lavish-foods',   'Lavish Foods',           'rice manufacturing/export/distribution',    '{Germany,Europe}'),
  ('${FIXTURE_IDS.businessC}', 'ai-integrations','AI Integrations',        'AI integration/services',                   '{GCC}');

insert into public.business_domains (business_id, domain, domain_type, is_default) values
  ('${FIXTURE_IDS.businessA}', 'zemnas.example',       'primary', true),
  ('${FIXTURE_IDS.businessB}', 'lavishfoods.example',  'primary', true),
  ('${FIXTURE_IDS.businessC}', 'aiintegrations.example','primary', true);

-- access --------------------------------------------------------------------
insert into public.user_business_access
  (user_id, business_id, access_level, can_manage_leads, can_use_lead_sources, can_use_profile_queue, can_delete_leads) values
  ('${FIXTURE_IDS.admin}',   '${FIXTURE_IDS.businessA}', 'admin',   true, true,  true,  true),
  ('${FIXTURE_IDS.admin}',   '${FIXTURE_IDS.businessB}', 'admin',   true, true,  true,  true),
  ('${FIXTURE_IDS.admin}',   '${FIXTURE_IDS.businessC}', 'admin',   true, true,  true,  true),
  ('${FIXTURE_IDS.manager}', '${FIXTURE_IDS.businessA}', 'manager', true, true,  true,  true),
  ('${FIXTURE_IDS.user1}',   '${FIXTURE_IDS.businessA}', 'user',    true, true,  true,  true),
  ('${FIXTURE_IDS.user2}',   '${FIXTURE_IDS.businessB}', 'user',    true, false, false, false);

-- outreach identities -------------------------------------------------------
insert into public.outreach_identities
  (id, platform, display_name, profile_url, managed_by_user_id, status, daily_target) values
  ('${FIXTURE_IDS.identityA1}', 'linkedin', 'Sender A1', 'https://www.linkedin.com/in/sender-a1', '${FIXTURE_IDS.user1}',   'active', 20),
  ('${FIXTURE_IDS.identityA2}', 'linkedin', 'Sender A2', 'https://www.linkedin.com/in/sender-a2', '${FIXTURE_IDS.manager}', 'active', 20),
  ('${FIXTURE_IDS.identityB1}', 'linkedin', 'Sender B1', 'https://www.linkedin.com/in/sender-b1', '${FIXTURE_IDS.user2}',   'active', 20),
  ('${FIXTURE_IDS.identityUnassigned}', 'linkedin', 'Sender Unassigned', 'https://www.linkedin.com/in/sender-unassigned', null, 'active', 20);

insert into public.outreach_identity_business_access (outreach_identity_id, business_id) values
  ('${FIXTURE_IDS.identityA1}', '${FIXTURE_IDS.businessA}'),
  ('${FIXTURE_IDS.identityA2}', '${FIXTURE_IDS.businessA}'),
  ('${FIXTURE_IDS.identityB1}', '${FIXTURE_IDS.businessB}'),
  ('${FIXTURE_IDS.identityUnassigned}', '${FIXTURE_IDS.businessA}');

-- companies -----------------------------------------------------------------
insert into public.companies (id, name, primary_domain, industry) values
  ('${FIXTURE_IDS.companyFrameHouse}', 'Frame House', 'framehouse.example',  'media'),
  ('${FIXTURE_IDS.companyAbcMedia}',   'ABC Media',   'abcmedia.example',    'media'),
  ('${FIXTURE_IDS.companyKiteStudio}', 'Kite Studio', 'kitestudio.example',  'creative'),
  ('${FIXTURE_IDS.companyNorthstar}',  'Northstar',   'northstar.example',   'technology');

-- people --------------------------------------------------------------------
insert into public.people (id, full_name, job_title, primary_email, linkedin_url, company_id) values
  ('${FIXTURE_IDS.personTomHenry}',   'Tom Henry',   'Head of Production', 'tom.henry@framehouse.example',  'https://www.linkedin.com/in/tom-henry',   '${FIXTURE_IDS.companyFrameHouse}'),
  ('${FIXTURE_IDS.personSarahSmith}', 'Sarah Smith', 'Marketing Director', 'sarah.smith@abcmedia.example',  'https://www.linkedin.com/in/sarah-smith', '${FIXTURE_IDS.companyAbcMedia}'),
  ('${FIXTURE_IDS.personMiaBecker}',  'Mia Becker',  'Founder',            'mia.becker@kitestudio.example', 'https://www.linkedin.com/in/mia-becker',  '${FIXTURE_IDS.companyKiteStudio}'),
  ('${FIXTURE_IDS.personJonDavies}',  'Jon Davies',  'Operations Lead',    'jon.davies@northstar.example',  'https://www.linkedin.com/in/jon-davies',  '${FIXTURE_IDS.companyNorthstar}'),
  ('${FIXTURE_IDS.personNoraSchmidt}','Nora Schmidt','Producer',           'nora.schmidt@abcmedia.example', 'https://www.linkedin.com/in/nora-schmidt','${FIXTURE_IDS.companyAbcMedia}'),
  ('${FIXTURE_IDS.personLisaWeber}',  'Lisa Weber',  'Content Lead',       'lisa.weber@framehouse.example', 'https://www.linkedin.com/in/lisa-weber',  '${FIXTURE_IDS.companyFrameHouse}');

-- icps ----------------------------------------------------------------------
insert into public.icps (id, business_id, name, description, is_default) values
  ('${FIXTURE_IDS.icpA}',  '${FIXTURE_IDS.businessA}', 'Media companies hiring editors', 'Recurring video output', true),
  ('${FIXTURE_IDS.icpA2}', '${FIXTURE_IDS.businessA}', 'Agencies with contractor need',  'Needs overflow capacity', false),
  ('${FIXTURE_IDS.icpB}',  '${FIXTURE_IDS.businessB}', 'Food distributors',              'Buys rice in bulk', false);

-- sequences -----------------------------------------------------------------
insert into public.sequences (id, business_id, name, description, is_default, status) values
  ('${FIXTURE_IDS.sequenceA}', '${FIXTURE_IDS.businessA}', 'Default outreach', 'Message 1 + FU1 + FU2 + FU3', true, 'active');

insert into public.sequence_versions (id, sequence_id, version, status, published_at) values
  ('${FIXTURE_IDS.sequenceVersionA1}', '${FIXTURE_IDS.sequenceA}', 1, 'published', now());

update public.sequences
   set current_version_id = '${FIXTURE_IDS.sequenceVersionA1}'
 where id = '${FIXTURE_IDS.sequenceA}';

insert into public.sequence_steps
  (id, sequence_version_id, step_order, kind, name, delay_days, delay_basis, goal, word_max, cta_style, generation_mode) values
  ('${FIXTURE_IDS.stepMessage1}',  '${FIXTURE_IDS.sequenceVersionA1}', 1, 'message',  'Message 1',    0, 'after_previous', 'initial outreach',            80, 'low_pressure', 'ai'),
  ('${FIXTURE_IDS.stepFollowup1}', '${FIXTURE_IDS.sequenceVersionA1}', 2, 'followup', 'Follow-up 1',  3, 'after_previous', 'short relevant follow-up',    60, 'low_pressure', 'ai'),
  ('${FIXTURE_IDS.stepFollowup2}', '${FIXTURE_IDS.sequenceVersionA1}', 3, 'followup', 'Follow-up 2',  4, 'after_previous', 'new angle/proof',             60, 'low_pressure', 'ai'),
  ('${FIXTURE_IDS.stepFollowup3}', '${FIXTURE_IDS.sequenceVersionA1}', 4, 'followup', 'Follow-up 3',  7, 'after_previous', 'close loop',                  60, 'low_pressure', 'ai');

-- leads ---------------------------------------------------------------------
insert into public.leads
  (id, business_id, person_id, company_id, primary_icp_id, owner_user_id, status, source_type, source_url, needs_profile, created_by)
values
  ('${FIXTURE_IDS.leadA1}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.personTomHenry}',   '${FIXTURE_IDS.companyFrameHouse}', '${FIXTURE_IDS.icpA}',  '${FIXTURE_IDS.user1}', 'ready',         'manual_add',       'https://www.linkedin.com/in/tom-henry',   false, '${FIXTURE_IDS.user1}'),
  ('${FIXTURE_IDS.leadB1}', '${FIXTURE_IDS.businessB}', '${FIXTURE_IDS.personTomHenry}',   '${FIXTURE_IDS.companyFrameHouse}', '${FIXTURE_IDS.icpB}',  '${FIXTURE_IDS.user2}', 'ready',         'manual_add',       'https://www.linkedin.com/in/tom-henry',   false, '${FIXTURE_IDS.user2}'),
  ('${FIXTURE_IDS.leadA2}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.personSarahSmith}', '${FIXTURE_IDS.companyAbcMedia}',   '${FIXTURE_IDS.icpA}',  '${FIXTURE_IDS.user1}', 'ready',         'manual_add',       'https://www.linkedin.com/in/sarah-smith', false, '${FIXTURE_IDS.user1}'),
  ('${FIXTURE_IDS.leadB2}', '${FIXTURE_IDS.businessB}', '${FIXTURE_IDS.personMiaBecker}',  '${FIXTURE_IDS.companyKiteStudio}', '${FIXTURE_IDS.icpB}',  '${FIXTURE_IDS.user2}', 'ready',         'manual_add',       'https://www.linkedin.com/in/mia-becker',  false, '${FIXTURE_IDS.user2}'),
  ('${FIXTURE_IDS.leadA3}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.personJonDavies}',  '${FIXTURE_IDS.companyNorthstar}',  '${FIXTURE_IDS.icpA}',  '${FIXTURE_IDS.user1}', 'ready',         'manual_companion', 'https://www.linkedin.com/in/jon-davies',  false, '${FIXTURE_IDS.user1}'),
  ('${FIXTURE_IDS.leadA4}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.personNoraSchmidt}', '${FIXTURE_IDS.companyAbcMedia}',  '${FIXTURE_IDS.icpA}',  '${FIXTURE_IDS.user1}', 'ready',         'manual_add',       'https://www.linkedin.com/in/nora-schmidt',false, '${FIXTURE_IDS.user1}'),
  ('${FIXTURE_IDS.leadA5}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.personLisaWeber}',  '${FIXTURE_IDS.companyFrameHouse}', '${FIXTURE_IDS.icpA}',  '${FIXTURE_IDS.user1}', 'needs_profile', 'google_search',    null,                                      true,  '${FIXTURE_IDS.user1}');

insert into public.lead_icp_matches (lead_id, icp_id, is_primary, match_score, reason) values
  ('${FIXTURE_IDS.leadA1}', '${FIXTURE_IDS.icpA}',  true,  90, 'default icp'),
  ('${FIXTURE_IDS.leadA1}', '${FIXTURE_IDS.icpA2}', false, 55, 'secondary match'),
  ('${FIXTURE_IDS.leadB1}', '${FIXTURE_IDS.icpB}',  true,  70, 'default icp'),
  ('${FIXTURE_IDS.leadA2}', '${FIXTURE_IDS.icpA}',  true,  80, 'default icp'),
  ('${FIXTURE_IDS.leadB2}', '${FIXTURE_IDS.icpB}',  true,  75, 'default icp'),
  ('${FIXTURE_IDS.leadA3}', '${FIXTURE_IDS.icpA}',  true,  65, 'default icp'),
  ('${FIXTURE_IDS.leadA4}', '${FIXTURE_IDS.icpA}',  true,  60, 'default icp'),
  ('${FIXTURE_IDS.leadA5}', '${FIXTURE_IDS.icpA}',  true,  40, 'auto match');

-- enrollments ---------------------------------------------------------------
insert into public.sequence_enrollments
  (id, business_id, lead_id, sequence_id, sequence_version_id, state, current_step_order, started_at)
values
  ('${FIXTURE_IDS.enrollmentLeadA2}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.leadA2}', '${FIXTURE_IDS.sequenceA}', '${FIXTURE_IDS.sequenceVersionA1}', 'active', 1, now()),
  ('${FIXTURE_IDS.enrollmentLeadA3}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.leadA3}', '${FIXTURE_IDS.sequenceA}', '${FIXTURE_IDS.sequenceVersionA1}', 'active', 1, now()),
  ('${FIXTURE_IDS.enrollmentLeadB1}', '${FIXTURE_IDS.businessB}', '${FIXTURE_IDS.leadB1}', '${FIXTURE_IDS.sequenceA}', '${FIXTURE_IDS.sequenceVersionA1}', 'active', 1, now());

-- conversations + one pending message instance ------------------------------
insert into public.conversations (id, business_id, lead_id, channel, sender_identity_id, default_owner_user_id) values
  ('${FIXTURE_IDS.conversationLeadA2}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.leadA2}', 'linkedin', '${FIXTURE_IDS.identityA1}', '${FIXTURE_IDS.user1}'),
  ('${FIXTURE_IDS.conversationLeadA3}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.leadA3}', 'linkedin', '${FIXTURE_IDS.identityA1}', '${FIXTURE_IDS.user1}');

insert into public.message_instances
  (id, conversation_id, sequence_step_id, state, due_at, business_id, lead_id, step_order, step_kind)
values
  ('${FIXTURE_IDS.messageInstanceA2M1}', '${FIXTURE_IDS.conversationLeadA2}', '${FIXTURE_IDS.stepMessage1}', 'DYNAMIC', now(), '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.leadA2}', 1, 'message');

insert into public.message_versions
  (id, message_instance_id, content, generated_by_model, sequence_version_id, created_by, is_manual_edit)
values
  ('${FIXTURE_IDS.messageVersionA2M1}', '${FIXTURE_IDS.messageInstanceA2M1}', 'Fixture Message 1 body for Sarah Smith.', 'fixture-model', '${FIXTURE_IDS.sequenceVersionA1}', '${FIXTURE_IDS.user1}', false);

update public.message_instances
   set current_version_id = '${FIXTURE_IDS.messageVersionA2M1}'
 where id = '${FIXTURE_IDS.messageInstanceA2M1}';

-- notes / tasks / evidence / signals ---------------------------------------
insert into public.notes (id, business_id, lead_id, person_id, author_user_id, body, is_internal) values
  ('${FIXTURE_IDS.noteLeadA1}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.leadA1}', '${FIXTURE_IDS.personTomHenry}', '${FIXTURE_IDS.user1}', 'Fixture internal note', true);

insert into public.tasks (id, lead_id, business_id, owner_user_id, type, title, due_at, priority, status, source, created_by) values
  ('${FIXTURE_IDS.taskLeadA1}', '${FIXTURE_IDS.leadA1}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.user1}', 'follow_up', 'Fixture follow-up task', now() - interval '1 hour', 'normal', 'open', 'user', '${FIXTURE_IDS.user1}');

insert into public.source_evidence
  (id, business_id, person_id, company_id, lead_id, source, source_url, raw_text_or_json, content_hash, observed_at, confidence, created_by) values
  ('${FIXTURE_IDS.evidenceA1}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.personTomHenry}', '${FIXTURE_IDS.companyFrameHouse}', '${FIXTURE_IDS.leadA1}', 'LinkedIn manual import', 'https://www.linkedin.com/in/tom-henry', '{"headline":"Head of Production"}', 'fixture-evidence-hash-1', now(), 0.9, '${FIXTURE_IDS.user1}');

insert into public.signals (id, business_id, company_id, person_id, lead_id, kind, polarity, strength, label, observed_at, created_by) values
  ('${FIXTURE_IDS.signalA1}', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.companyFrameHouse}', '${FIXTURE_IDS.personTomHenry}', '${FIXTURE_IDS.leadA1}', 'hiring', 'positive', 30, 'Hiring editor', now(), '${FIXTURE_IDS.user1}');

-- profile queue -------------------------------------------------------------
insert into public.profile_capture_queue (business_id, lead_id, person_id, state, reason) values
  ('${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.leadA5}', '${FIXTURE_IDS.personLisaWeber}', 'pending', 'google_search partial record');

-- imports -------------------------------------------------------------------
insert into public.import_batches
  (id, source, business, requested_primary_icp, business_id, requested_icp_id, row_count, status, created_by, idempotency_key) values
  ('${FIXTURE_IDS.importBatchA}', 'file_csv', 'Zemnas Creative Studio', 'Media companies hiring editors', '${FIXTURE_IDS.businessA}', '${FIXTURE_IDS.icpA}', 1, 'completed', '${FIXTURE_IDS.user1}', 'fixture-batch-1');

insert into public.import_rows (id, batch_id, row_number, raw, normalized, result, lead_id, person_id, company_id) values
  ('${FIXTURE_IDS.importRowA1}', '${FIXTURE_IDS.importBatchA}', 1, '{"name":"Nora Schmidt"}', '{"name":"Nora Schmidt"}', 'created', '${FIXTURE_IDS.leadA4}', '${FIXTURE_IDS.personNoraSchmidt}', '${FIXTURE_IDS.companyAbcMedia}');

-- api clients (hashes only, never plaintext tokens) -------------------------
insert into public.api_clients (id, name, kind, token_hash, token_prefix, scopes, business_ids, is_active) values
  ('${FIXTURE_IDS.apiClientLimited}', 'Limited leads reader', 'mcp',         'fixture-hash-limited-0001', 'nx_ltd', array['leads:read'],                      array['${FIXTURE_IDS.businessA}']::uuid[], true),
  ('${FIXTURE_IDS.apiClientIngest}',  'Ingest writer',        'rest_ingest', 'fixture-hash-ingest-0002',  'nx_ing', array['ingest:write','lead_sources:write'], array['${FIXTURE_IDS.businessA}']::uuid[], true);
`;
