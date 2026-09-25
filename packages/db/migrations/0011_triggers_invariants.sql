-- ============================================================================
-- NEXUS DB · 0011 — triggers and enforced invariants
--
-- Implements DB_CONTRACT.md §2 invariants 7, 8, 9, 11, 14, 15, 20 and §0
--            (timestamps), plus the normalization needed by invariants 3, 4, 13.
-- Spec
--   sequence_engine.message_states / publish_behavior (SENT is immutable)
--   sequence_engine.do_not_contact                     (global person+channel DNC)
--   sequence_engine.ordinary_not_interested            (business cooldown only)
--   lead_lifecycle.reply                               (pause/cancel pending steps)
--   security_and_reliability.rules                     (soft delete by default,
--                                                       append-only audit history)
--   identity_model.browser_session                     (binding rules)
--
-- All triggers are dropped-and-recreated so the file is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Normalization (invariants 3, 4, 13) — the DB, not the caller, owns the key
-- ---------------------------------------------------------------------------
create or replace function public.normalize_person_row()
  returns trigger
  language plpgsql
as $$
begin
  new.full_name := public.normalize_text(new.full_name);
  new.normalized_name := public.normalize_name(new.full_name);
  new.linkedin_url := nullif(btrim(coalesce(new.linkedin_url, '')), '');
  new.normalized_linkedin_url :=
    coalesce(
      public.normalize_linkedin_url(new.linkedin_url),
      public.normalize_linkedin_url(new.normalized_linkedin_url)
    );
  new.primary_email := nullif(lower(btrim(coalesce(new.primary_email, ''))), '');
  if new.first_name is null and new.full_name is not null then
    new.first_name := split_part(new.full_name, ' ', 1);
  end if;
  if new.last_name is null and new.full_name is not null and position(' ' in new.full_name) > 0 then
    new.last_name := btrim(substr(new.full_name, position(' ' in new.full_name)));
  end if;
  return new;
end
$$;

drop trigger if exists trg_people_normalize on public.people;
create trigger trg_people_normalize
  before insert or update on public.people
  for each row execute function public.normalize_person_row();

create or replace function public.normalize_company_row()
  returns trigger
  language plpgsql
as $$
begin
  new.name := public.normalize_text(new.name);
  new.normalized_name := public.normalize_name(new.name);
  -- primary_domain wins: normalized_domain always follows the registered domain.
  new.primary_domain := public.normalize_domain(coalesce(new.primary_domain, new.normalized_domain));
  new.normalized_domain := public.normalize_domain(
    coalesce(new.primary_domain, new.normalized_domain, new.linkedin_url)
  );
  new.linkedin_url := nullif(btrim(coalesce(new.linkedin_url, '')), '');
  new.normalized_linkedin_url := public.normalize_linkedin_url(new.linkedin_url);
  return new;
end
$$;

drop trigger if exists trg_companies_normalize on public.companies;
create trigger trg_companies_normalize
  before insert or update on public.companies
  for each row execute function public.normalize_company_row();

create or replace function public.normalize_business_domain_row()
  returns trigger
  language plpgsql
as $$
begin
  new.domain := lower(btrim(coalesce(new.domain, '')));
  new.normalized_domain :=
    public.normalize_domain(coalesce(new.normalized_domain, new.domain));
  if new.normalized_domain is null then
    raise exception 'business_domains.domain must not be blank'
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists trg_business_domains_normalize on public.business_domains;
create trigger trg_business_domains_normalize
  before insert or update on public.business_domains
  for each row execute function public.normalize_business_domain_row();

create or replace function public.normalize_social_profile_row()
  returns trigger
  language plpgsql
as $$
begin
  new.normalized_url :=
    public.normalize_url(coalesce(new.normalized_url, new.profile_url));
  if new.normalized_url is null then
    raise exception 'social_profiles.profile_url must not be blank'
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists trg_social_profiles_normalize on public.social_profiles;
create trigger trg_social_profiles_normalize
  before insert or update on public.social_profiles
  for each row execute function public.normalize_social_profile_row();

create or replace function public.normalize_outreach_identity_row()
  returns trigger
  language plpgsql
as $$
begin
  new.profile_url := nullif(btrim(coalesce(new.profile_url, '')), '');
  new.normalized_profile_url := public.normalize_linkedin_url(new.profile_url);
  return new;
end
$$;

drop trigger if exists trg_outreach_identities_normalize on public.outreach_identities;
create trigger trg_outreach_identities_normalize
  before insert or update on public.outreach_identities
  for each row execute function public.normalize_outreach_identity_row();

-- ---------------------------------------------------------------------------
-- updated_at (DB_CONTRACT.md §0)
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_tables text[] := array[
    'users', 'businesses', 'business_domains', 'user_business_access', 'user_lead_scope',
    'teams', 'personas', 'offers', 'services', 'value_propositions', 'knowledge_assets',
    'scoring_rules', 'companies', 'people', 'social_profiles', 'icps', 'leads', 'notes',
    'tasks', 'opportunities', 'rfps', 'outreach_identities', 'sequences',
    'sequence_steps', 'sequence_enrollments', 'conversations', 'message_instances',
    'automation_configs', 'saved_views', 'platform_settings', 'profile_capture_queue'
  ];
begin
  foreach v_table in array v_tables loop
    execute format('drop trigger if exists trg_%s_touch on public.%I', v_table, v_table);
    execute format(
      'create trigger trg_%s_touch before update on public.%I for each row execute function public.touch_updated_at()',
      v_table, v_table
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Invariant 7 — SENT messages are immutable
-- ---------------------------------------------------------------------------
create or replace function public.enforce_message_immutability()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_state text;
begin
  if tg_table_name = 'message_versions' then
    select mi.state into v_state
      from public.message_instances mi
     where mi.id = old.message_instance_id;

    -- The audited admin hard-delete flow is the only escape hatch; everything
    -- else is append-only.
    if v_state = 'SENT' and not public.allowed_hard_delete() then
      raise exception 'message_versions rows of a SENT message are immutable (% rejected)', tg_op
        using errcode = '23001',
              hint = 'corrections use a new message_events row, never an overwrite';
    end if;

    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- message_instances
  if tg_op = 'DELETE' then
    if old.state = 'SENT' and not public.allowed_hard_delete() then
      raise exception 'a SENT message_instance cannot be deleted'
        using errcode = '23001';
    end if;
    return old;
  end if;

  if old.state = 'SENT' then
    if new.state is distinct from 'SENT' then
      raise exception 'message_instances.state cannot move away from SENT (% -> %)', old.state, new.state
        using errcode = '23001';
    end if;
    if new.current_version_id is distinct from old.current_version_id then
      raise exception 'the frozen current_version_id of a SENT message cannot change'
        using errcode = '23001';
    end if;
    if new.sent_at is distinct from old.sent_at then
      raise exception 'the sent_at of a SENT message cannot change'
        using errcode = '23001';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists trg_message_versions_immutable on public.message_versions;
create trigger trg_message_versions_immutable
  before update or delete on public.message_versions
  for each row execute function public.enforce_message_immutability();

drop trigger if exists trg_message_instances_immutable on public.message_instances;
create trigger trg_message_instances_immutable
  before update or delete on public.message_instances
  for each row execute function public.enforce_message_immutability();

-- message_versions.version_no is assigned by the database
create or replace function public.assign_message_version_no()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if new.version_no is null then
    select coalesce(max(v.version_no), 0) + 1 into new.version_no
      from public.message_versions v
     where v.message_instance_id = new.message_instance_id;
  end if;
  return new;
end
$$;

drop trigger if exists trg_message_versions_version_no on public.message_versions;
create trigger trg_message_versions_version_no
  before insert on public.message_versions
  for each row execute function public.assign_message_version_no();

-- ---------------------------------------------------------------------------
-- Invariant 8 — DNC blocks future sends across every identity
-- ---------------------------------------------------------------------------
create or replace function public.block_dnc_message()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_person uuid;
  v_channel text;
begin
  if new.state <> 'SENT' then
    return new;
  end if;

  select l.person_id, coalesce(c.channel, 'linkedin')
    into v_person, v_channel
    from public.leads l
    left join public.conversations c on c.id = new.conversation_id
   where l.id = new.lead_id;

  if public.is_dnc_blocked(v_person, v_channel) then
    raise exception 'outreach blocked: person % has an active Do Not Contact suppression on channel %', v_person, v_channel
      using errcode = '23514',
            hint = 'explicit DNC cannot be bypassed by switching outreach identity';
  end if;

  -- The lead itself may also carry the DNC flag.
  if exists (
    select 1 from public.leads l
     where l.id = new.lead_id and (l.is_dnc or l.status = 'do_not_contact')
  ) then
    raise exception 'outreach blocked: lead % is marked do-not-contact', new.lead_id
      using errcode = '23514';
  end if;

  return new;
end
$$;

drop trigger if exists trg_message_instances_dnc on public.message_instances;
create trigger trg_message_instances_dnc
  before insert or update of state on public.message_instances
  for each row execute function public.block_dnc_message();

-- ---------------------------------------------------------------------------
-- Invariant 8 (creation side) — an explicit DNC outcome suppresses the
-- person+channel globally, and flags every lead for that person.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_dnc_suppression()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_person uuid;
  v_channel text;
  v_suppression uuid;
  v_business uuid;
begin
  if new.outcome <> 'Do not contact' then
    return new;
  end if;

  select l.person_id, coalesce(c.channel, 'linkedin'), l.business_id
    into v_person, v_channel, v_business
    from public.leads l
    left join public.conversations c on c.id = new.conversation_id
   where l.id = new.lead_id;

  if v_person is null then
    raise exception 'cannot apply a Do Not Contact outcome to lead % (no person)', new.lead_id
      using errcode = '23514';
  end if;

  -- business_id IS NULL => global across ALL outreach identities
  if not exists (
    select 1 from public.contact_suppressions cs
     where cs.person_id = v_person
       and cs.channel = v_channel
       and cs.business_id is null
       and cs.active
  ) then
    insert into public.contact_suppressions (
      person_id, channel, reason, source_reply_id, active, business_id, created_by, evidence
    )
    values (
      v_person, v_channel, 'explicit_dnc', new.source_reply_id, true, null,
      new.actor_user_id, new.reason
    )
    returning id into v_suppression;
  end if;

  -- Every business lead for that person is now do-not-contact.
  update public.leads l
     set is_dnc = true,
         status = 'do_not_contact',
         next_action_type = 'none',
         next_action_at = null,
         last_activity_at = now()
   where l.person_id = v_person
     and l.deleted_at is null;

  update public.sequence_enrollments e
     set state = 'cancelled',
         completed_at = now(),
         pause_reason = 'do_not_contact'
   where e.lead_id = new.lead_id
     and e.state in ('active', 'paused', 'reactivation_due');

  update public.message_instances mi
     set invalidated_at = now(),
         regeneration_reason = 'do_not_contact'
   where mi.lead_id = new.lead_id
     and mi.sent_at is null;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Invariant 9 — a captured reply pauses the sequence and cancels pending steps
-- ---------------------------------------------------------------------------
create or replace function public.pause_sequence_on_reply()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_pause boolean;
  v_cancel boolean;
begin
  v_pause := public.setting_bool('reply.pause_sequence', true, new.business_id);
  v_cancel := public.setting_bool('reply.cancel_pending_steps', true, new.business_id);

  if v_pause then
    update public.sequence_enrollments e
       set state = 'paused',
           paused_at = now(),
           pause_reason = new.outcome
     where e.lead_id = new.lead_id
       and e.state = 'active';
  end if;

  if v_cancel then
    update public.message_instances mi
       set invalidated_at = now(),
           regeneration_reason = 'reply_received'
     where mi.lead_id = new.lead_id
       and mi.sent_at is null;
  end if;

  update public.conversations c
     set last_inbound_at = greatest(coalesce(c.last_inbound_at, now()), new.created_at)
   where c.id = new.conversation_id;

  if new.outcome <> 'Do not contact' then
    update public.leads l
       set status = case
                      when new.outcome in ('Interested', 'Positive / needs info') then 'interested'
                      when new.outcome = 'Wrong person' then 'wrong_person'
                      else 'replied'
                    end,
           next_action_type = 'review',
           next_action_at = now(),
           last_activity_at = now()
     where l.id = new.lead_id;
  end if;

  return new;
end
$$;

-- Trigger names are ordered so the DNC trigger (20) runs last and its
-- do_not_contact status wins over the generic 'replied' status.
drop trigger if exists trg_conversation_outcomes_10_pause on public.conversation_outcomes;
create trigger trg_conversation_outcomes_10_pause
  after insert on public.conversation_outcomes
  for each row execute function public.pause_sequence_on_reply();

drop trigger if exists trg_conversation_outcomes_20_dnc on public.conversation_outcomes;
create trigger trg_conversation_outcomes_20_dnc
  after insert on public.conversation_outcomes
  for each row execute function public.enforce_dnc_suppression();

-- ---------------------------------------------------------------------------
-- Invariant 11 — nothing is hard-deleted outside the audited admin flow
-- ---------------------------------------------------------------------------
create or replace function public.prevent_hard_delete()
  returns trigger
  language plpgsql
as $$
begin
  if public.allowed_hard_delete() then
    return old;
  end if;

  raise exception 'hard delete of %.% is forbidden; use the audited admin flow (soft delete by default)', tg_table_schema, tg_table_name
    using errcode = '23001',
          hint = 'spec security_and_reliability.rules: soft delete by default';
end
$$;

drop trigger if exists trg_leads_prevent_hard_delete on public.leads;
create trigger trg_leads_prevent_hard_delete
  before delete on public.leads
  for each row execute function public.prevent_hard_delete();

drop trigger if exists trg_people_prevent_hard_delete on public.people;
create trigger trg_people_prevent_hard_delete
  before delete on public.people
  for each row execute function public.prevent_hard_delete();

drop trigger if exists trg_companies_prevent_hard_delete on public.companies;
create trigger trg_companies_prevent_hard_delete
  before delete on public.companies
  for each row execute function public.prevent_hard_delete();

-- ---------------------------------------------------------------------------
-- Invariant 15 — a browser session may only bind an identity the user may use
-- ---------------------------------------------------------------------------
create or replace function public.validate_browser_session_identity()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_identity public.outreach_identities%rowtype;
begin
  if new.outreach_identity_id is null then
    return new;
  end if;

  select * into v_identity
    from public.outreach_identities i
   where i.id = new.outreach_identity_id;

  if not found then
    raise exception 'browser session references unknown outreach identity %', new.outreach_identity_id
      using errcode = '23503';
  end if;

  if v_identity.deleted_at is not null or v_identity.status <> 'active' then
    raise exception 'outreach identity % is not active', new.outreach_identity_id
      using errcode = '23514';
  end if;

  if not (public.is_admin() or v_identity.managed_by_user_id = new.user_id) then
    raise exception 'user % may not bind outreach identity %', new.user_id, new.outreach_identity_id
      using errcode = '42501',
            hint = 'an identity owned by another user requires an explicit audited transfer';
  end if;

  if new.default_business_id is not null
     and not public.has_identity_business_access(new.outreach_identity_id, new.default_business_id) then
    raise exception 'outreach identity % has no access to business %', new.outreach_identity_id, new.default_business_id
      using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists trg_browser_sessions_validate on public.browser_sessions;
create trigger trg_browser_sessions_validate
  before insert or update on public.browser_sessions
  for each row execute function public.validate_browser_session_identity();

-- Ownership of an outreach identity is admin-controlled; an owner may only
-- maintain the presentation fields.
create or replace function public.restrict_identity_self_update()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if public.is_admin() or public.current_user_id() is null then
    return new;
  end if;

  if old.managed_by_user_id is distinct from public.current_user_id() then
    raise exception 'only the identity owner or an admin may update outreach identity %', old.id
      using errcode = '42501';
  end if;

  if new.platform is distinct from old.platform
     or new.managed_by_user_id is distinct from old.managed_by_user_id
     or new.status is distinct from old.status
     or new.profile_url is distinct from old.profile_url
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'an identity owner may only change display_name, daily_target or notes on outreach identity %', old.id
      using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists trg_outreach_identities_self_update on public.outreach_identities;
create trigger trg_outreach_identities_self_update
  before update on public.outreach_identities
  for each row execute function public.restrict_identity_self_update();

-- ---------------------------------------------------------------------------
-- Invariant 20 — every audited mutation appends an audit_events row
-- ---------------------------------------------------------------------------
create or replace function public.audit_row_change()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_actor_type text;
  v_actor_id uuid;
  v_business_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_entity_id uuid;
begin
  v_actor_type := case
                    when public.acting_api_client_id() is not null then 'api_client'
                    when public.current_user_id() is not null then 'user'
                    else 'system'
                  end;
  v_actor_id := coalesce(public.acting_api_client_id(), public.current_user_id());

  if tg_op = 'INSERT' then
    v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
  else
    v_before := to_jsonb(old);
  end if;

  v_row := coalesce(v_after, v_before);
  v_entity_id := nullif(
    coalesce(v_row ->> 'id', v_row ->> 'lead_id', v_row ->> 'person_id', ''),
    ''
  )::uuid;
  v_business_id := nullif(v_row ->> 'business_id', '')::uuid;

  insert into public.audit_events (
    actor_type, actor_id, business_id, entity_type, entity_id, action,
    before_json, after_json, source_client, api_client_id
  )
  values (
    v_actor_type, v_actor_id, v_business_id, tg_table_name, v_entity_id, lower(tg_op),
    v_before, v_after,
    current_setting('nexus.source_client', true),
    public.acting_api_client_id()
  );

  return null;
end
$$;

do $$
declare
  v_table text;
  v_tables text[] := array[
    'leads', 'people', 'companies', 'contact_suppressions', 'cooldowns',
    'sequence_enrollments', 'message_instances', 'message_events',
    'conversation_outcomes', 'conversations', 'user_business_access',
    'user_lead_scope', 'outreach_identities', 'outreach_identity_business_access',
    'browser_sessions', 'identity_transfers', 'api_clients', 'knowledge_assets',
    'knowledge_asset_versions', 'asset_extractions', 'icps', 'sequences',
    'sequence_versions', 'sequence_steps', 'business_domains', 'businesses',
    'tasks', 'notes', 'opportunities', 'rfps', 'interactions', 'import_batches',
    'import_rows', 'duplicate_candidates', 'automation_configs', 'agent_runs',
    'webhook_endpoints', 'webhook_deliveries', 'saved_views', 'platform_settings',
    'profile_capture_queue', 'lead_assignments', 'users', 'teams',
    'prompt_versions', 'signals', 'source_evidence', 'research_snapshots',
    'ingest_requests'
  ];
begin
  foreach v_table in array v_tables loop
    execute format('drop trigger if exists trg_%s_audit on public.%I', v_table, v_table);
    execute format(
      'create trigger trg_%s_audit after insert or update or delete on public.%I for each row execute function public.audit_row_change()',
      v_table, v_table
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- audit_events is append-only
-- ---------------------------------------------------------------------------
create or replace function public.prevent_audit_mutation()
  returns trigger
  language plpgsql
as $$
begin
  raise exception 'audit_events is append-only (% rejected)', tg_op
    using errcode = '23001';
end
$$;

drop trigger if exists trg_audit_events_immutable on public.audit_events;
create trigger trg_audit_events_immutable
  before update or delete on public.audit_events
  for each row execute function public.prevent_audit_mutation();
