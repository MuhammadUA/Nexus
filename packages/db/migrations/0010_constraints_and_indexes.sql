-- ============================================================================
-- NEXUS DB · 0010 — constraints, cross-table FKs, partial uniques, indexes
--
-- Implements DB_CONTRACT.md §2 (enforced invariants 1-6, 10, 12, 13) and
--            DB_CONTRACT.md §1 forward references
-- Spec
--   data_model.indexes_and_uniqueness
--   api_contract.external_ingest.required_envelope (idempotency)
--   lead_invariants.*
--   business_units.clone_behavior (defaults are configuration, seeded here)
--
-- Every index/constraint in this file is created with IF NOT EXISTS or a
-- guarded DO block so the whole migration set is safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Forward-reference foreign keys (tables created in later/earlier files)
-- ---------------------------------------------------------------------------
do $$
declare
  v_spec record;
begin
  for v_spec in
    select * from (values
      ('value_propositions', 'value_propositions_icp_fk', 'icp_id', 'icps (id)', 'set null'),
      ('knowledge_assets', 'knowledge_assets_current_version_fk', 'current_version_id', 'knowledge_asset_versions (id)', 'set null'),
      ('icps', 'icps_default_sequence_fk', 'default_sequence_id', 'sequences (id)', 'set null'),
      ('sequences', 'sequences_current_version_fk', 'current_version_id', 'sequence_versions (id)', 'set null'),
      ('leads', 'leads_outreach_identity_fk', 'outreach_identity_id', 'outreach_identities (id)', 'set null'),
      ('leads', 'leads_sequence_enrollment_fk', 'sequence_enrollment_id', 'sequence_enrollments (id)', 'set null'),
      ('leads', 'leads_import_batch_fk', 'import_batch_id', 'import_batches (id)', 'set null'),
      ('signals', 'signals_lead_fk', 'lead_id', 'leads (id)', 'cascade'),
      ('source_evidence', 'source_evidence_lead_fk', 'lead_id', 'leads (id)', 'set null'),
      ('research_snapshots', 'research_snapshots_lead_fk', 'lead_id', 'leads (id)', 'cascade'),
      ('interactions', 'interactions_conversation_fk', 'conversation_id', 'conversations (id)', 'set null'),
      ('interactions', 'interactions_outreach_identity_fk', 'outreach_identity_id', 'outreach_identities (id)', 'set null'),
      ('conversation_outcomes', 'conversation_outcomes_source_reply_fk', 'source_reply_id', 'interactions (id)', 'set null'),
      ('contact_suppressions', 'contact_suppressions_source_reply_fk', 'source_reply_id', 'interactions (id)', 'set null'),
      ('message_instances', 'message_instances_current_version_fk', 'current_version_id', 'message_versions (id)', 'set null')
    ) as t (table_name, constraint_name, column_name, ref, on_delete)
  loop
    if not exists (
      select 1 from pg_constraint c
       where c.conname = v_spec.constraint_name
         and c.conrelid = format('public.%I', v_spec.table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.%s on delete %s',
        v_spec.table_name, v_spec.constraint_name, v_spec.column_name,
        v_spec.ref, v_spec.on_delete
      );
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Partial unique indexes — the enforced invariants
-- ---------------------------------------------------------------------------

-- invariant 1: one active lead per (business, person)
create unique index if not exists leads_business_person_active_key
  on public.leads (business_id, person_id)
  where deleted_at is null;

-- invariant 2: one primary ICP match per lead
create unique index if not exists lead_icp_matches_primary_key
  on public.lead_icp_matches (lead_id)
  where is_primary;

-- invariant 3: normalized LinkedIn URL is the strongest person dedupe key
create unique index if not exists people_normalized_linkedin_key
  on public.people (normalized_linkedin_url)
  where normalized_linkedin_url is not null;

-- invariant 4: normalized company domain is the strongest company dedupe key
create unique index if not exists companies_normalized_domain_key
  on public.companies (normalized_domain)
  where normalized_domain is not null;

-- invariant 12: exactly one default primary domain per business
create unique index if not exists business_domains_default_primary_key
  on public.business_domains (business_id)
  where is_default and domain_type = 'primary';

-- one default ICP per business
create unique index if not exists icps_default_business_key
  on public.icps (business_id)
  where is_default and deleted_at is null;

-- one default sequence per business
create unique index if not exists sequences_default_business_key
  on public.sequences (business_id)
  where is_default and deleted_at is null;

-- invariant 10: only one live enrollment per lead
create unique index if not exists sequence_enrollments_live_lead_key
  on public.sequence_enrollments (lead_id)
  where state in ('active', 'paused', 'reactivation_due');

-- one open profile-capture item per lead
create unique index if not exists profile_capture_queue_open_lead_key
  on public.profile_capture_queue (lead_id)
  where state in ('pending', 'in_progress');

-- invariant 15: one active browser session per outreach identity
create unique index if not exists browser_sessions_active_identity_key
  on public.browser_sessions (outreach_identity_id)
  where status = 'active' and outreach_identity_id is not null;

-- import idempotency
create unique index if not exists import_batches_idempotency_key
  on public.import_batches (idempotency_key)
  where idempotency_key is not null;

-- DNC suppression: at most one active global row and one active row per business
create unique index if not exists contact_suppressions_global_active_key
  on public.contact_suppressions (person_id, channel)
  where active and business_id is null;

create unique index if not exists contact_suppressions_business_active_key
  on public.contact_suppressions (person_id, channel, business_id)
  where active and business_id is not null;

-- global platform settings are unique by key even though business_id is NULL
create unique index if not exists platform_settings_global_key
  on public.platform_settings (key)
  where business_id is null;

-- ---------------------------------------------------------------------------
-- Performance indexes required by data_model.indexes_and_uniqueness + RLS paths
-- ---------------------------------------------------------------------------
create index if not exists leads_deleted_idx on public.leads (business_id, deleted_at);
create index if not exists leads_identity_idx on public.leads (outreach_identity_id);
create index if not exists leads_icp_idx on public.leads (primary_icp_id);
create index if not exists leads_import_batch_idx on public.leads (import_batch_id);
create index if not exists people_linkedin_idx on public.people (linkedin_url);
create index if not exists companies_domain_idx on public.companies (primary_domain);
create index if not exists source_evidence_company_idx on public.source_evidence (company_id);
create index if not exists message_versions_sequence_version_idx
  on public.message_versions (sequence_version_id);
create index if not exists sequence_steps_version_idx
  on public.sequence_steps (sequence_version_id, step_order);
create index if not exists sequence_versions_sequence_idx
  on public.sequence_versions (sequence_id, version desc);
create index if not exists outreach_identity_access_business_idx
  on public.outreach_identity_business_access (business_id);
create index if not exists user_lead_scope_user_idx on public.user_lead_scope (user_id);
create index if not exists teams_business_idx on public.teams (business_id);
create index if not exists saved_views_owner_idx on public.saved_views (owner_user_id, business_id);

-- ---------------------------------------------------------------------------
-- Global platform-setting defaults (spec screen_inventory A22).
-- These are configuration defaults, not product demo content.
-- ---------------------------------------------------------------------------
insert into public.platform_settings (business_id, key, value)
values
  (null, 'security.hard_delete_requires_confirmation', 'true'::jsonb),
  (null, 'security.soft_delete_default', 'true'::jsonb),
  (null, 'retention.trash_days', '90'::jsonb),
  (null, 'dnc.suppress_person_across_identities', 'true'::jsonb),
  (null, 'uniqueness.normalized_linkedin_url', 'true'::jsonb),
  (null, 'uniqueness.normalized_company_domain', 'true'::jsonb),
  (null, 'reply.pause_sequence', 'true'::jsonb),
  (null, 'reply.cancel_pending_steps', 'true'::jsonb),
  (null, 'dormant.reactivation_days', '60'::jsonb),
  (null, 'cooldown.ordinary_not_interested_days', '90'::jsonb),
  (null, 'browser.allow_concurrent_identity_sessions', 'false'::jsonb),
  (null, 'sequence.default_followup_delays_days', '[3, 4, 7]'::jsonb)
on conflict (key) where business_id is null do nothing;
