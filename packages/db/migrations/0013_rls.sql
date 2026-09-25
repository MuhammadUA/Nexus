-- ============================================================================
-- NEXUS DB · 0013 — Row Level Security
--
-- Implements the complete DB_CONTRACT.md §3 policy matrix, including the
-- API-client path (scope + business_ids) and
-- public.companion_visible_business_ids().
--
-- Spec
--   security_and_reliability.rules      ("RLS enforces team/business/user visibility")
--   roles_and_permissions.*             (admin / manager / user boundaries)
--   extension_visibility_rule           (Companion = user access INTERSECT identity access)
--   integrations.chatgpt.do_not         (no service-role credentials for agents)
--   mcp_contract.write_requirements     (business scope, actor/client identity)
--
-- Every table is ENABLE + FORCE row level security, so the table owner is bound
-- by the policies too: there is no "owner bypass" correctness path. The only
-- principals that bypass are superusers / BYPASSRLS roles, which is why the
-- authorization helpers in 0001 are SECURITY DEFINER.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extra visibility helpers used only by policies
-- ---------------------------------------------------------------------------

-- lead_icp_matches has no business_id of its own (DB_CONTRACT.md §1.4).
create or replace function public.lead_business_visible(p_lead_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.leads l
     where l.id = p_lead_id
       and public.has_business_access(l.business_id)
       and (
         public.is_admin()
         or public.acting_api_client_id() is not null
         or public.lead_scope_allows(l.id, l.business_id, l.owner_user_id)
       )
  );
$$;

create or replace function public.lead_business_writable(p_lead_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.leads l
     where l.id = p_lead_id
       and public.has_business_access(l.business_id)
       and (
         public.is_admin()
         or public.can_manage_leads(l.business_id)
         or public.is_api_client_allowed(l.business_id, 'leads:write')
       )
  );
$$;

create or replace function public.import_batch_writable(p_batch_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.import_batches b
     where b.id = p_batch_id
       and public.has_business_access(b.business_id)
       and (
         public.is_admin()
         or public.can_use_lead_sources(b.business_id)
         or public.is_api_client_allowed(b.business_id, 'lead_sources:write')
       )
  );
$$;

-- scoring_rules carries target_type/target_id instead of a business_id
-- (DB_CONTRACT.md §1.2), so visibility resolves through the target.
create or replace function public.scoring_rule_visible(p_rule_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.scoring_rules r
     where r.id = p_rule_id
       and (
         public.is_admin()
         or r.target_type = 'global'
         or (r.target_type = 'business' and public.has_business_access(r.target_id))
         or (
           r.target_type = 'icp'
           and exists (
             select 1 from public.icps i
              where i.id = r.target_id
                and public.has_business_access(i.business_id)
           )
         )
       )
  );
$$;

create or replace function public.scoring_rule_writable(p_rule_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select public.is_admin() or public.scoring_rule_visible(p_rule_id);
$$;

-- message_versions carries no business_id (§1.6): resolve through the instance.
create or replace function public.message_instance_visible(p_instance_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.message_instances mi
     where mi.id = p_instance_id
       and (
         public.has_business_access(mi.business_id)
         or public.is_api_client_allowed(mi.business_id, 'messages:read')
       )
  );
$$;

create or replace function public.message_instance_writable(p_instance_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.message_instances mi
     where mi.id = p_instance_id
       and public.has_business_access(mi.business_id)
       and (
         public.is_admin()
         or public.can_manage_leads(mi.business_id)
         or public.is_api_client_allowed(mi.business_id, 'messages:write')
       )
  );
$$;

-- Sender-identity visibility. Defined as a SECURITY DEFINER helper so that the
-- outreach_identities policy and the outreach_identity_business_access policy can
-- never recurse into each other.
create or replace function public.identity_visible(p_identity_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p_identity_id is not null
     and (
       public.is_admin()
       or exists (
         select 1
           from public.outreach_identities i
          where i.id = p_identity_id
            and i.managed_by_user_id = public.current_user_id()
       )
       or (
         public.acting_api_client_id() is not null
         and 'identities:read' = any (public.api_client_scopes())
         and exists (
           select 1
             from public.outreach_identity_business_access x
            where x.outreach_identity_id = p_identity_id
              and x.business_id = any (public.api_client_business_ids())
         )
       )
     );
$$;

-- ---------------------------------------------------------------------------
-- Enable + FORCE RLS on every table in the public schema
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  for v_table in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- users — own row, admin all; role changes are admin-only
-- ---------------------------------------------------------------------------
drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated
  using (id = public.current_user_id() or public.is_admin());

drop policy if exists users_insert on public.users;
create policy users_insert on public.users
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists users_update on public.users;
create policy users_update on public.users
  for update to authenticated
  using (id = public.current_user_id() or public.is_admin())
  with check (
    public.is_admin()
    or (id = public.current_user_id() and role = public.current_user_role())
  );

drop policy if exists users_delete on public.users;
create policy users_delete on public.users
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- teams / team_members (business_id NULL = cross-business team)
-- ---------------------------------------------------------------------------
drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams
  for select to authenticated
  using (
    public.is_admin()
    or business_id is null
    or public.has_business_access(business_id)
  );

drop policy if exists teams_write on public.teams;
create policy teams_write on public.teams
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists team_members_select on public.team_members;
create policy team_members_select on public.team_members
  for select to authenticated
  using (
    public.is_admin()
    or user_id = public.current_user_id()
    or exists (
      select 1 from public.teams t
       where t.id = team_id
         and (t.business_id is null or public.has_business_access(t.business_id))
    )
  );

drop policy if exists team_members_write on public.team_members;
create policy team_members_write on public.team_members
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- businesses / business_domains / user_business_access / user_lead_scope
-- ---------------------------------------------------------------------------
drop policy if exists businesses_select on public.businesses;
create policy businesses_select on public.businesses
  for select to authenticated
  using (
    public.has_business_access(id)
    or public.is_api_client_allowed(id, 'businesses:read')
  );

drop policy if exists businesses_insert on public.businesses;
create policy businesses_insert on public.businesses
  for insert to authenticated with check (public.is_admin());

drop policy if exists businesses_update on public.businesses;
create policy businesses_update on public.businesses
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists businesses_delete on public.businesses;
create policy businesses_delete on public.businesses
  for delete to authenticated using (public.is_admin());

drop policy if exists business_domains_select on public.business_domains;
create policy business_domains_select on public.business_domains
  for select to authenticated
  using (public.has_business_access(business_id));

drop policy if exists business_domains_write on public.business_domains;
create policy business_domains_write on public.business_domains
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists user_business_access_select on public.user_business_access;
create policy user_business_access_select on public.user_business_access
  for select to authenticated
  using (user_id = public.current_user_id() or public.is_admin());

drop policy if exists user_business_access_write on public.user_business_access;
create policy user_business_access_write on public.user_business_access
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists user_lead_scope_select on public.user_lead_scope;
create policy user_lead_scope_select on public.user_lead_scope
  for select to authenticated
  using (user_id = public.current_user_id() or public.is_admin());

drop policy if exists user_lead_scope_write on public.user_lead_scope;
create policy user_lead_scope_write on public.user_lead_scope
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Business Brain: read with business access, configure as admin
-- (§3 row: icps, sequences, knowledge_assets, offers, services, personas,
--  value_propositions, scoring_rules)
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_tables text[] := array[
    'personas', 'offers', 'services', 'value_propositions', 'knowledge_assets',
    'icps', 'sequences'
  ];
begin
  foreach v_table in array v_tables loop
    execute format('drop policy if exists %I on public.%I', v_table || '_select', v_table);
    execute format(
      $fmt$create policy %I on public.%I for select to authenticated
             using (public.has_business_access(business_id)
                    or public.is_api_client_allowed(business_id, 'brain:read'))$fmt$,
      v_table || '_select', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_write', v_table);
    execute format(
      $fmt$create policy %I on public.%I for all to authenticated
             using (public.is_admin() or public.is_api_client_allowed(business_id, 'brain:write'))
             with check (public.is_admin() or public.is_api_client_allowed(business_id, 'brain:write'))$fmt$,
      v_table || '_write', v_table
    );
  end loop;
end
$$;

-- scoring_rules resolves visibility through its target (§1.2 has no business_id)
drop policy if exists scoring_rules_select on public.scoring_rules;
create policy scoring_rules_select on public.scoring_rules
  for select to authenticated
  using (public.scoring_rule_visible(id));

drop policy if exists scoring_rules_write on public.scoring_rules;
create policy scoring_rules_write on public.scoring_rules
  for all to authenticated
  using (public.scoring_rule_writable(id))
  with check (public.is_admin());

-- knowledge asset children (no business_id of their own)
drop policy if exists knowledge_asset_versions_select on public.knowledge_asset_versions;
create policy knowledge_asset_versions_select on public.knowledge_asset_versions
  for select to authenticated
  using (public.knowledge_asset_visible(asset_id));

drop policy if exists knowledge_asset_versions_write on public.knowledge_asset_versions;
create policy knowledge_asset_versions_write on public.knowledge_asset_versions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists asset_extractions_select on public.asset_extractions;
create policy asset_extractions_select on public.asset_extractions
  for select to authenticated
  using (
    exists (
      select 1 from public.knowledge_asset_versions v
       where v.id = asset_version_id
         and public.knowledge_asset_visible(v.asset_id)
    )
  );

drop policy if exists asset_extractions_write on public.asset_extractions;
create policy asset_extractions_write on public.asset_extractions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists asset_tags_select on public.asset_tags;
create policy asset_tags_select on public.asset_tags
  for select to authenticated
  using (public.knowledge_asset_visible(asset_id));

drop policy if exists asset_tags_write on public.asset_tags;
create policy asset_tags_write on public.asset_tags
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- prompt_versions is global reference data
drop policy if exists prompt_versions_select on public.prompt_versions;
create policy prompt_versions_select on public.prompt_versions
  for select to authenticated
  using (public.current_user_id() is not null or public.acting_api_client_id() is not null);

drop policy if exists prompt_versions_write on public.prompt_versions;
create policy prompt_versions_write on public.prompt_versions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- sequences: steps have no business_id -> resolved through the version
-- ---------------------------------------------------------------------------
drop policy if exists sequence_versions_select on public.sequence_versions;
create policy sequence_versions_select on public.sequence_versions
  for select to authenticated
  using (public.sequence_version_visible(id));

drop policy if exists sequence_versions_write on public.sequence_versions;
create policy sequence_versions_write on public.sequence_versions
  for all to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.sequences s
       where s.id = sequence_id
         and public.is_api_client_allowed(s.business_id, 'brain:write')
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.sequences s
       where s.id = sequence_id
         and public.is_api_client_allowed(s.business_id, 'brain:write')
    )
  );

drop policy if exists sequence_steps_select on public.sequence_steps;
create policy sequence_steps_select on public.sequence_steps
  for select to authenticated
  using (public.sequence_version_visible(sequence_version_id));

drop policy if exists sequence_steps_write on public.sequence_steps;
create policy sequence_steps_write on public.sequence_steps
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- canonical identities (companies / people / social_profiles)
-- §3: visible when a lead in an accessible business references them
-- ---------------------------------------------------------------------------
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated
  using (public.company_visible(id));

drop policy if exists companies_insert on public.companies;
create policy companies_insert on public.companies
  for insert to authenticated
  with check (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  );

drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies
  for update to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  );

drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies
  for delete to authenticated using (public.is_admin());

drop policy if exists people_select on public.people;
create policy people_select on public.people
  for select to authenticated
  using (public.person_visible(id));

drop policy if exists people_insert on public.people;
create policy people_insert on public.people
  for insert to authenticated
  with check (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  );

drop policy if exists people_update on public.people;
create policy people_update on public.people
  for update to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  );

drop policy if exists people_delete on public.people;
create policy people_delete on public.people
  for delete to authenticated using (public.is_admin());

drop policy if exists social_profiles_select on public.social_profiles;
create policy social_profiles_select on public.social_profiles
  for select to authenticated
  using (
    public.is_admin()
    or (person_id is not null and public.person_visible(person_id))
    or (company_id is not null and public.company_visible(company_id))
  );

drop policy if exists social_profiles_insert on public.social_profiles;
create policy social_profiles_insert on public.social_profiles
  for insert to authenticated
  with check (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  );

drop policy if exists social_profiles_update on public.social_profiles;
create policy social_profiles_update on public.social_profiles
  for update to authenticated
  using (public.is_admin() or public.acting_api_client_id() is not null)
  with check (public.is_admin() or public.acting_api_client_id() is not null);

drop policy if exists social_profiles_delete on public.social_profiles;
create policy social_profiles_delete on public.social_profiles
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- leads — business access AND lead scope; delete needs can_delete_leads
-- ---------------------------------------------------------------------------
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated
  using (
    public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.is_api_client_allowed(business_id, 'leads:read')
      or public.lead_scope_allows(id, business_id, owner_user_id)
    )
  );

drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert to authenticated
  with check (
    public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.can_manage_leads(business_id)
      or public.is_api_client_allowed(business_id, 'leads:write')
    )
  );

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update to authenticated
  using (
    public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.can_manage_leads(business_id)
      or public.is_api_client_allowed(business_id, 'leads:write')
    )
  )
  with check (
    public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.can_manage_leads(business_id)
      or public.is_api_client_allowed(business_id, 'leads:write')
    )
  );

-- hard delete is admin-only; the RPC path is the audited one
drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- lead children: lead_icp_matches / lead_assignments / notes / tasks /
-- interactions / cooldowns / opportunities / rfps
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_tables text[] := array[
    'lead_assignments', 'notes', 'tasks', 'interactions', 'cooldowns',
    'opportunities', 'rfps'
  ];
begin
  foreach v_table in array v_tables loop
    execute format('drop policy if exists %I on public.%I', v_table || '_select', v_table);
    execute format(
      $fmt$create policy %I on public.%I for select to authenticated
             using (public.has_business_access(business_id)
                    or public.is_api_client_allowed(business_id, 'leads:read'))$fmt$,
      v_table || '_select', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_insert', v_table);
    execute format(
      $fmt$create policy %I on public.%I for insert to authenticated
             with check (public.has_business_access(business_id)
                         and (public.is_admin()
                              or public.can_manage_leads(business_id)
                              or public.is_api_client_allowed(business_id, 'leads:write')))$fmt$,
      v_table || '_insert', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_update', v_table);
    execute format(
      $fmt$create policy %I on public.%I for update to authenticated
             using (public.has_business_access(business_id)
                    and (public.is_admin()
                         or public.can_manage_leads(business_id)
                         or public.is_api_client_allowed(business_id, 'leads:write')))
             with check (public.has_business_access(business_id)
                         and (public.is_admin()
                              or public.can_manage_leads(business_id)
                              or public.is_api_client_allowed(business_id, 'leads:write')))$fmt$,
      v_table || '_update', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_delete', v_table);
    execute format(
      $fmt$create policy %I on public.%I for delete to authenticated
             using (public.is_admin())$fmt$,
      v_table || '_delete', v_table
    );
  end loop;
end
$$;

drop policy if exists lead_icp_matches_select on public.lead_icp_matches;
create policy lead_icp_matches_select on public.lead_icp_matches
  for select to authenticated
  using (public.lead_business_visible(lead_id));

drop policy if exists lead_icp_matches_insert on public.lead_icp_matches;
create policy lead_icp_matches_insert on public.lead_icp_matches
  for insert to authenticated
  with check (public.lead_business_writable(lead_id));

drop policy if exists lead_icp_matches_update on public.lead_icp_matches;
create policy lead_icp_matches_update on public.lead_icp_matches
  for update to authenticated
  using (public.lead_business_writable(lead_id))
  with check (public.lead_business_writable(lead_id));

drop policy if exists lead_icp_matches_delete on public.lead_icp_matches;
create policy lead_icp_matches_delete on public.lead_icp_matches
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- contact_suppressions — global rows are admin-only, business rows admin/manager
-- ---------------------------------------------------------------------------
drop policy if exists contact_suppressions_select on public.contact_suppressions;
create policy contact_suppressions_select on public.contact_suppressions
  for select to authenticated
  using (business_id is null or public.has_business_access(business_id));

drop policy if exists contact_suppressions_insert on public.contact_suppressions;
create policy contact_suppressions_insert on public.contact_suppressions
  for insert to authenticated
  with check (
    case when business_id is null
         then public.is_admin()
         else public.is_admin() or public.is_business_manager(business_id)
    end
  );

drop policy if exists contact_suppressions_update on public.contact_suppressions;
create policy contact_suppressions_update on public.contact_suppressions
  for update to authenticated
  using (
    case when business_id is null
         then public.is_admin()
         else public.is_admin() or public.is_business_manager(business_id)
    end
  )
  with check (
    case when business_id is null
         then public.is_admin()
         else public.is_admin() or public.is_business_manager(business_id)
    end
  );

drop policy if exists contact_suppressions_delete on public.contact_suppressions;
create policy contact_suppressions_delete on public.contact_suppressions
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- signals / source_evidence / research_snapshots — lead-source permissions
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_tables text[] := array['source_evidence', 'research_snapshots'];
begin
  foreach v_table in array v_tables loop
    execute format('drop policy if exists %I on public.%I', v_table || '_select', v_table);
    execute format(
      $fmt$create policy %I on public.%I for select to authenticated
             using (public.has_business_access(business_id)
                    or public.is_api_client_allowed(business_id, 'lead_sources:read'))$fmt$,
      v_table || '_select', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_insert', v_table);
    execute format(
      $fmt$create policy %I on public.%I for insert to authenticated
             with check (public.has_business_access(business_id)
                         and (public.is_admin()
                              or public.can_use_lead_sources(business_id)
                              or public.is_api_client_allowed(business_id, 'lead_sources:write')))$fmt$,
      v_table || '_insert', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_update', v_table);
    execute format(
      $fmt$create policy %I on public.%I for update to authenticated
             using (public.has_business_access(business_id)
                    and (public.is_admin()
                         or public.can_use_lead_sources(business_id)
                         or public.is_api_client_allowed(business_id, 'lead_sources:write')))$fmt$,
      v_table || '_update', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_delete', v_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_admin())',
      v_table || '_delete', v_table
    );
  end loop;
end
$$;

drop policy if exists signals_select on public.signals;
create policy signals_select on public.signals
  for select to authenticated
  using (
    business_id is null and public.current_user_id() is not null
    or public.has_business_access(business_id)
  );

drop policy if exists signals_insert on public.signals;
create policy signals_insert on public.signals
  for insert to authenticated
  with check (
    business_id is not null
    and public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.can_use_lead_sources(business_id)
      or public.is_api_client_allowed(business_id, 'lead_sources:write')
    )
  );

drop policy if exists signals_update on public.signals;
create policy signals_update on public.signals
  for update to authenticated
  using (
    public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.can_use_lead_sources(business_id)
      or public.is_api_client_allowed(business_id, 'lead_sources:write')
    )
  )
  with check (public.has_business_access(business_id));

drop policy if exists signals_delete on public.signals;
create policy signals_delete on public.signals
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- outreach identities — admin all, owner only their own; never anyone else's
-- ---------------------------------------------------------------------------
drop policy if exists outreach_identities_select on public.outreach_identities;
create policy outreach_identities_select on public.outreach_identities
  for select to authenticated
  using (public.identity_visible(id));

drop policy if exists outreach_identities_insert on public.outreach_identities;
create policy outreach_identities_insert on public.outreach_identities
  for insert to authenticated with check (public.is_admin());

drop policy if exists outreach_identities_update on public.outreach_identities;
create policy outreach_identities_update on public.outreach_identities
  for update to authenticated
  using (public.is_admin() or managed_by_user_id = public.current_user_id())
  with check (public.is_admin() or managed_by_user_id = public.current_user_id());

drop policy if exists outreach_identities_delete on public.outreach_identities;
create policy outreach_identities_delete on public.outreach_identities
  for delete to authenticated using (public.is_admin());

drop policy if exists outreach_identity_business_access_select on public.outreach_identity_business_access;
create policy outreach_identity_business_access_select on public.outreach_identity_business_access
  for select to authenticated
  using (public.identity_visible(outreach_identity_id));

drop policy if exists outreach_identity_business_access_write on public.outreach_identity_business_access;
create policy outreach_identity_business_access_write on public.outreach_identity_business_access
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- browser sessions — own rows only
-- ---------------------------------------------------------------------------
drop policy if exists browser_sessions_select on public.browser_sessions;
create policy browser_sessions_select on public.browser_sessions
  for select to authenticated
  using (user_id = public.current_user_id() or public.is_admin());

drop policy if exists browser_sessions_insert on public.browser_sessions;
create policy browser_sessions_insert on public.browser_sessions
  for insert to authenticated
  with check (
    user_id = public.current_user_id()
    and (
      outreach_identity_id is null
      or exists (
        select 1 from public.outreach_identities i
         where i.id = outreach_identity_id
           and (public.is_admin() or i.managed_by_user_id = public.current_user_id())
      )
    )
  );

drop policy if exists browser_sessions_update on public.browser_sessions;
create policy browser_sessions_update on public.browser_sessions
  for update to authenticated
  using (user_id = public.current_user_id() or public.is_admin())
  with check (user_id = public.current_user_id() or public.is_admin());

drop policy if exists browser_sessions_delete on public.browser_sessions;
create policy browser_sessions_delete on public.browser_sessions
  for delete to authenticated
  using (user_id = public.current_user_id() or public.is_admin());

drop policy if exists identity_transfers_select on public.identity_transfers;
create policy identity_transfers_select on public.identity_transfers
  for select to authenticated
  using (
    public.is_admin()
    or from_user_id = public.current_user_id()
    or to_user_id = public.current_user_id()
  );

drop policy if exists identity_transfers_insert on public.identity_transfers;
create policy identity_transfers_insert on public.identity_transfers
  for insert to authenticated with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- sequence runtime: conversations, outcomes, instances, versions, events,
-- enrollments — readable with business access, append-only from the client
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_tables text[] := array[
    'sequence_enrollments', 'conversations', 'conversation_outcomes',
    'message_instances', 'message_events', 'business_context_versions'
  ];
begin
  foreach v_table in array v_tables loop
    execute format('drop policy if exists %I on public.%I', v_table || '_select', v_table);
    execute format(
      $fmt$create policy %I on public.%I for select to authenticated
             using (public.has_business_access(business_id)
                    or public.is_api_client_allowed(business_id, 'messages:read'))$fmt$,
      v_table || '_select', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_insert', v_table);
    execute format(
      $fmt$create policy %I on public.%I for insert to authenticated
             with check (public.has_business_access(business_id)
                         and (public.is_admin()
                              or public.can_manage_leads(business_id)
                              or public.is_api_client_allowed(business_id, 'messages:write')))$fmt$,
      v_table || '_insert', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_update', v_table);
    execute format(
      $fmt$create policy %I on public.%I for update to authenticated
             using (public.has_business_access(business_id)
                    and (public.is_admin()
                         or public.can_manage_leads(business_id)
                         or public.is_api_client_allowed(business_id, 'messages:write')))
             with check (public.has_business_access(business_id)
                         and (public.is_admin()
                              or public.can_manage_leads(business_id)
                              or public.is_api_client_allowed(business_id, 'messages:write')))$fmt$,
      v_table || '_update', v_table
    );

    -- append-only: no DELETE policy exists, so DELETE is denied for everyone
    execute format('drop policy if exists %I on public.%I', v_table || '_delete', v_table);
  end loop;
end
$$;

-- message_versions: visible/writable through the owning instance
drop policy if exists message_versions_select on public.message_versions;
create policy message_versions_select on public.message_versions
  for select to authenticated
  using (public.message_instance_visible(message_instance_id));

drop policy if exists message_versions_insert on public.message_versions;
create policy message_versions_insert on public.message_versions
  for insert to authenticated
  with check (public.message_instance_writable(message_instance_id));

drop policy if exists message_versions_update on public.message_versions;
create policy message_versions_update on public.message_versions
  for update to authenticated
  using (public.message_instance_writable(message_instance_id))
  with check (public.message_instance_writable(message_instance_id));

-- no DELETE policy: message history is append-only

-- ---------------------------------------------------------------------------
-- ingestion: import batches/rows, profile queue, duplicate review
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_tables text[] := array['import_batches', 'profile_capture_queue', 'duplicate_candidates'];
begin
  foreach v_table in array v_tables loop
    execute format('drop policy if exists %I on public.%I', v_table || '_select', v_table);
    execute format(
      $fmt$create policy %I on public.%I for select to authenticated
             using (public.has_business_access(business_id)
                    or public.is_api_client_allowed(business_id, 'lead_sources:read'))$fmt$,
      v_table || '_select', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_insert', v_table);
    execute format(
      $fmt$create policy %I on public.%I for insert to authenticated
             with check (public.has_business_access(business_id)
                         and (public.is_admin()
                              or public.can_use_lead_sources(business_id)
                              or public.is_api_client_allowed(business_id, 'lead_sources:write')))$fmt$,
      v_table || '_insert', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_update', v_table);
    execute format(
      $fmt$create policy %I on public.%I for update to authenticated
             using (public.has_business_access(business_id)
                    and (public.is_admin()
                         or public.can_use_lead_sources(business_id)
                         or public.is_api_client_allowed(business_id, 'lead_sources:write')))$fmt$,
      v_table || '_update', v_table
    );

    execute format('drop policy if exists %I on public.%I', v_table || '_delete', v_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_admin())',
      v_table || '_delete', v_table
    );
  end loop;
end
$$;

drop policy if exists import_rows_select on public.import_rows;
create policy import_rows_select on public.import_rows
  for select to authenticated
  using (public.import_batch_visible(batch_id));

drop policy if exists import_rows_insert on public.import_rows;
create policy import_rows_insert on public.import_rows
  for insert to authenticated
  with check (public.import_batch_writable(batch_id));

drop policy if exists import_rows_update on public.import_rows;
create policy import_rows_update on public.import_rows
  for update to authenticated
  using (public.import_batch_writable(batch_id))
  with check (public.import_batch_writable(batch_id));

drop policy if exists import_rows_delete on public.import_rows;
create policy import_rows_delete on public.import_rows
  for delete to authenticated using (public.is_admin());

-- ingest_requests — the external ingest idempotency ledger
drop policy if exists ingest_requests_select on public.ingest_requests;
create policy ingest_requests_select on public.ingest_requests
  for select to authenticated
  using (
    business_id is not null
    and (public.has_business_access(business_id)
         or public.is_api_client_allowed(business_id, 'ingest:read'))
  );

drop policy if exists ingest_requests_insert on public.ingest_requests;
create policy ingest_requests_insert on public.ingest_requests
  for insert to authenticated
  with check (
    business_id is not null
    and public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.can_use_lead_sources(business_id)
      or public.is_api_client_allowed(business_id, 'ingest:write')
    )
  );

drop policy if exists ingest_requests_update on public.ingest_requests;
create policy ingest_requests_update on public.ingest_requests
  for update to authenticated
  using (
    business_id is not null
    and public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.can_use_lead_sources(business_id)
      or public.is_api_client_allowed(business_id, 'ingest:write')
    )
  )
  with check (business_id is not null and public.has_business_access(business_id));

drop policy if exists ingest_requests_delete on public.ingest_requests;
create policy ingest_requests_delete on public.ingest_requests
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- integrations: api_clients / webhooks / automation — admin only (§3)
-- ---------------------------------------------------------------------------
do $$
declare
  v_table text;
  v_tables text[] := array['api_clients', 'webhook_endpoints', 'automation_configs'];
begin
  foreach v_table in array v_tables loop
    execute format('drop policy if exists %I on public.%I', v_table || '_admin', v_table);
    execute format(
      $fmt$create policy %I on public.%I for all to authenticated
             using (public.is_admin()) with check (public.is_admin())$fmt$,
      v_table || '_admin', v_table
    );
  end loop;
end
$$;

drop policy if exists webhook_deliveries_admin on public.webhook_deliveries;
create policy webhook_deliveries_admin on public.webhook_deliveries
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists agent_runs_select on public.agent_runs;
create policy agent_runs_select on public.agent_runs
  for select to authenticated
  using (public.has_business_access(business_id));

drop policy if exists agent_runs_insert on public.agent_runs;
create policy agent_runs_insert on public.agent_runs
  for insert to authenticated
  with check (
    public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.is_api_client_allowed(business_id, 'agent_runs:write')
    )
  );

drop policy if exists agent_runs_update on public.agent_runs;
create policy agent_runs_update on public.agent_runs
  for update to authenticated
  using (
    public.has_business_access(business_id)
    and (
      public.is_admin()
      or public.is_api_client_allowed(business_id, 'agent_runs:write')
    )
  )
  with check (public.has_business_access(business_id));

drop policy if exists agent_runs_delete on public.agent_runs;
create policy agent_runs_delete on public.agent_runs
  for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- audit_events — admin, or a user reading their own actor rows; insert-only
-- ---------------------------------------------------------------------------
drop policy if exists audit_events_select on public.audit_events;
create policy audit_events_select on public.audit_events
  for select to authenticated
  using (public.is_admin() or actor_id = public.current_user_id());

drop policy if exists audit_events_insert on public.audit_events;
create policy audit_events_insert on public.audit_events
  for insert to authenticated
  with check (public.current_user_id() is not null or public.acting_api_client_id() is not null);

-- no UPDATE / DELETE policy: audit history is append-only for every principal

-- ---------------------------------------------------------------------------
-- saved_views / platform_settings
-- ---------------------------------------------------------------------------
drop policy if exists saved_views_select on public.saved_views;
create policy saved_views_select on public.saved_views
  for select to authenticated
  using (
    owner_user_id = public.current_user_id()
    or (is_shared and public.has_business_access(business_id))
  );

drop policy if exists saved_views_insert on public.saved_views;
create policy saved_views_insert on public.saved_views
  for insert to authenticated
  with check (owner_user_id = public.current_user_id() and public.has_business_access(business_id));

drop policy if exists saved_views_update on public.saved_views;
create policy saved_views_update on public.saved_views
  for update to authenticated
  using (owner_user_id = public.current_user_id())
  with check (owner_user_id = public.current_user_id());

drop policy if exists saved_views_delete on public.saved_views;
create policy saved_views_delete on public.saved_views
  for delete to authenticated
  using (owner_user_id = public.current_user_id());

drop policy if exists platform_settings_select on public.platform_settings;
create policy platform_settings_select on public.platform_settings
  for select to authenticated
  using (
    business_id is null
    or public.has_business_access(business_id)
  );

drop policy if exists platform_settings_write on public.platform_settings;
create policy platform_settings_write on public.platform_settings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
