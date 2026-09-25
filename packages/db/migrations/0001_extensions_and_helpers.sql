-- ============================================================================
-- NEXUS DB · 0001 — extensions, roles, authorization helpers
--
-- Implements
--   DB_CONTRACT.md §0  conventions + tenant predicate helpers
--   DB_CONTRACT.md §4  assert_business_scope / assert_identity_usable /
--                      enqueue_audit
-- Spec
--   security_and_reliability.stack          (Supabase Auth + Supabase RLS)
--   roles_and_permissions.*                 (admin / manager / user)
--   extension_visibility_rule               (user access INTERSECT identity access)
--   mcp_contract.write_requirements         (business scope + actor identity)
--
-- The body of this file exists so that the *same* SQL runs locally (PGlite)
-- and in production (Supabase Postgres). `auth.uid()` is shimmed with
-- IF NOT EXISTS semantics so a real Supabase project keeps its own function.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pgcrypto;
  exception when others then
    -- Supabase ships pgcrypto; PGlite has gen_random_uuid() in core.
    raise notice 'pgcrypto unavailable (%): relying on core gen_random_uuid()', sqlerrm;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- Roles. Supabase owns `authenticated` / `anon`; create them when absent so
-- the identical migration set also runs on a bare Postgres/PGlite instance.
-- ---------------------------------------------------------------------------
do $$
declare
  v_role text;
begin
  foreach v_role in array array['authenticated', 'anon'] loop
    if not exists (select 1 from pg_roles r where r.rolname = v_role) then
      execute format('create role %I nologin', v_role);
    end if;
  end loop;
end
$$;

grant usage on schema public to authenticated, anon;

-- ---------------------------------------------------------------------------
-- auth.uid() shim (DB_CONTRACT.md §0).
--
-- Created only when absent: a real Supabase project already owns this function.
-- The body is nonetheless re-asserted on every migration run (see below), so a
-- database migrated by an earlier revision converges on the same semantics.
--
-- Why the blank guard matters: `current_setting(name, true)` returns SQL NULL
-- only when the setting has *never* been set in the session. Once a
-- transaction-local `request.jwt.claims` is rolled back, Postgres leaves the
-- setting present but EMPTY, so the value is `''` and `''::jsonb` raises 22P02
-- ("The input string ended unexpectedly"). That surfaced as a spurious failure on
-- the *next* transaction of the same session — e.g. `audit_row_change()` calling
-- `current_user_id()` — and would equally affect a pooled PostgREST connection.
-- Blank is therefore treated exactly like absent.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create or replace function auth.uid()
  returns uuid
  language sql
  stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

comment on function auth.uid() is
  'DB_CONTRACT.md §0 — the signed-in user id from request.jwt.claims, or NULL. Blank-safe: a rolled-back LOCAL setting yields '''', not NULL.';

grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;

-- The helper bodies below reference tables created by later migrations, so
-- body validation is deferred for this file only.
set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Actor resolution
-- ---------------------------------------------------------------------------

-- The signed-in user id, or NULL when a scoped service token is acting.
create or replace function public.current_user_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select auth.uid();
$$;

comment on function public.current_user_id() is
  'DB_CONTRACT.md §0 — wraps auth.uid(); NULL for anonymous or API-client callers.';

-- The scoped service token acting in this statement, or NULL.
create or replace function public.acting_api_client_id()
  returns uuid
  language sql
  stable
as $$
  select nullif(current_setting('nexus.api_client_id', true), '')::uuid;
$$;

comment on function public.acting_api_client_id() is
  'DB_CONTRACT.md §0 — set by the authenticated gateway via set_config().';

-- The caller's platform role, read without recursing into the users RLS policy.
create or replace function public.current_user_role()
  returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select u.role
    from public.users u
   where u.id = public.current_user_id()
     and u.deleted_at is null;
$$;

create or replace function public.is_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.users u
     where u.id = public.current_user_id()
       and u.role = 'admin'
       and u.deleted_at is null
  );
$$;

comment on function public.is_admin() is
  'DB_CONTRACT.md §0/§3 — true only for an undeleted public.users row with role = admin.';

-- ---------------------------------------------------------------------------
-- API-client capability helpers (DB_CONTRACT.md §3 "API-client path")
-- ---------------------------------------------------------------------------

create or replace function public.api_client_scopes()
  returns text[]
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select ac.scopes
        from public.api_clients ac
       where ac.id = public.acting_api_client_id()
         and ac.is_active
         and ac.revoked_at is null
         and (ac.expires_at is null or ac.expires_at > now())
    ),
    array[]::text[]
  );
$$;

create or replace function public.api_client_business_ids()
  returns uuid[]
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select ac.business_ids
        from public.api_clients ac
       where ac.id = public.acting_api_client_id()
         and ac.is_active
         and ac.revoked_at is null
         and (ac.expires_at is null or ac.expires_at > now())
    ),
    array[]::uuid[]
  );
$$;

-- True when the acting service token may touch `p_business_id` AND holds
-- `p_scope`. A token can never exceed its scopes: the scope test is mandatory.
create or replace function public.is_api_client_allowed(p_business_id uuid, p_scope text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select public.acting_api_client_id() is not null
     and p_business_id is not null
     and p_scope is not null
     and p_scope = any (public.api_client_scopes())
     and p_business_id = any (public.api_client_business_ids());
$$;

comment on function public.is_api_client_allowed(uuid, text) is
  'DB_CONTRACT.md §3 — business_ids membership AND required scope, both mandatory.';

-- ---------------------------------------------------------------------------
-- Tenant predicates (DB_CONTRACT.md §0)
-- ---------------------------------------------------------------------------

create or replace function public.has_business_access(p_business_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p_business_id is not null
     and (
       public.is_admin()
       or (
         public.current_user_id() is not null
         and exists (
           select 1
             from public.user_business_access a
            where a.user_id = public.current_user_id()
              and a.business_id = p_business_id
         )
       )
       or (
         public.acting_api_client_id() is not null
         and p_business_id = any (public.api_client_business_ids())
       )
     );
$$;

create or replace function public.visible_business_ids()
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select b.id
    from public.businesses b
   where public.has_business_access(b.id);
$$;

-- Per-business capability flags from user_business_access.
create or replace function public.business_permission(p_business_id uuid, p_permission text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select public.is_admin()
      or exists (
        select 1
          from public.user_business_access a
         where a.user_id = public.current_user_id()
           and a.business_id = p_business_id
           and case p_permission
                 when 'manage_leads'      then a.can_manage_leads
                 when 'use_lead_sources'  then a.can_use_lead_sources
                 when 'use_profile_queue' then a.can_use_profile_queue
                 when 'delete_leads'      then a.can_delete_leads
                 else false
               end
      );
$$;

create or replace function public.can_manage_leads(p_business_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select public.business_permission(p_business_id, 'manage_leads'); $$;

create or replace function public.can_use_lead_sources(p_business_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select public.business_permission(p_business_id, 'use_lead_sources'); $$;

create or replace function public.can_delete_leads(p_business_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$ select public.business_permission(p_business_id, 'delete_leads'); $$;

-- manager = admin, or an access row whose level is manager.
create or replace function public.is_business_manager(p_business_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select public.is_admin()
      or exists (
        select 1
          from public.user_business_access a
         where a.user_id = public.current_user_id()
           and a.business_id = p_business_id
           and a.access_level = 'manager'
      );
$$;

-- ---------------------------------------------------------------------------
-- Lead scope (user_lead_scope.mode: all | assigned | own)
-- ---------------------------------------------------------------------------

create or replace function public.lead_scope_mode(p_business_id uuid)
  returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select s.mode
        from public.user_lead_scope s
       where s.user_id = public.current_user_id()
         and s.business_id = p_business_id
    ),
    'all'
  );
$$;

create or replace function public.lead_scope_allows(
  p_lead_id uuid,
  p_business_id uuid,
  p_owner_user_id uuid
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select case
           when public.is_admin() then true
           when public.current_user_id() is null then false
           else case public.lead_scope_mode(p_business_id)
                  when 'assigned' then
                    p_owner_user_id = public.current_user_id()
                    or exists (
                      select 1 from public.lead_assignments la
                       where la.lead_id = p_lead_id
                         and la.to_user_id = public.current_user_id()
                    )
                  when 'own' then
                    p_owner_user_id = public.current_user_id()
                    or exists (
                      select 1 from public.leads l
                       where l.id = p_lead_id
                         and l.created_by = public.current_user_id()
                    )
                  else true
                end
         end;
$$;

-- ---------------------------------------------------------------------------
-- Canonical-identity visibility (DB_CONTRACT.md §3: companies/people/social_profiles)
-- SECURITY DEFINER so a policy never recurses through the leads policy.
-- ---------------------------------------------------------------------------

create or replace function public.person_visible(p_person_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select public.is_admin()
      or (
        public.current_user_id() is not null
        and exists (
          select 1
            from public.leads l
           where l.person_id = p_person_id
             and l.deleted_at is null
             and public.has_business_access(l.business_id)
        )
      )
      or (
        public.acting_api_client_id() is not null
        and exists (
          select 1
            from public.leads l
           where l.person_id = p_person_id
             and l.deleted_at is null
             and public.is_api_client_allowed(l.business_id, 'leads:read')
        )
      );
$$;

create or replace function public.company_visible(p_company_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select public.is_admin()
      or (
        public.current_user_id() is not null
        and exists (
          select 1
            from public.leads l
           where l.company_id = p_company_id
             and l.deleted_at is null
             and public.has_business_access(l.business_id)
        )
      )
      or (
        public.acting_api_client_id() is not null
        and exists (
          select 1
            from public.leads l
           where l.company_id = p_company_id
             and l.deleted_at is null
             and public.is_api_client_allowed(l.business_id, 'leads:read')
        )
      );
$$;

-- ---------------------------------------------------------------------------
-- Sender-identity helpers (DB_CONTRACT.md §2 invariant 14, §3)
-- ---------------------------------------------------------------------------

create or replace function public.has_identity_business_access(
  p_identity_id uuid,
  p_business_id uuid
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.outreach_identity_business_access x
     where x.outreach_identity_id = p_identity_id
       and x.business_id = p_business_id
  );
$$;

-- Companion visible businesses = user_business_access INTERSECT identity access.
create or replace function public.companion_visible_business_ids(p_identity_id uuid)
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select a.business_id
    from public.user_business_access a
    join public.outreach_identity_business_access i
      on i.business_id = a.business_id
     and i.outreach_identity_id = p_identity_id
   where a.user_id = public.current_user_id();
$$;

comment on function public.companion_visible_business_ids(uuid) is
  'spec roles_and_permissions.extension_visibility_rule — intersection, never union.';

create or replace function public.identity_usable_by_actor(p_identity_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p_identity_id is not null
     and (
       public.is_admin()
       or (
         public.current_user_id() is not null
         and exists (
           select 1
             from public.outreach_identities i
            where i.id = p_identity_id
              and i.deleted_at is null
              and i.managed_by_user_id = public.current_user_id()
         )
       )
       or (
         public.acting_api_client_id() is not null
         and exists (
           select 1
             from public.outreach_identities i
            where i.id = p_identity_id
              and i.deleted_at is null
         )
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
-- Sequence / ingestion / knowledge visibility helpers
-- ---------------------------------------------------------------------------

create or replace function public.sequence_version_visible(p_version_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.sequence_versions v
      join public.sequences s on s.id = v.sequence_id
     where v.id = p_version_id
       and public.has_business_access(s.business_id)
  );
$$;

create or replace function public.import_batch_visible(p_batch_id uuid)
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
  );
$$;

create or replace function public.knowledge_asset_visible(p_asset_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.knowledge_assets a
     where a.id = p_asset_id
       and public.has_business_access(a.business_id)
  );
$$;

-- ---------------------------------------------------------------------------
-- Authorization assertions (DB_CONTRACT.md §4)
-- ---------------------------------------------------------------------------

create or replace function public.assert_business_scope(p_business_id uuid)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
begin
  if p_business_id is null then
    raise exception 'assert_business_scope: a business_id is required'
      using errcode = '42501';
  end if;

  if not public.has_business_access(p_business_id) then
    raise exception 'assert_business_scope: actor is not scoped to business %', p_business_id
      using errcode = '42501';
  end if;
end
$$;

create or replace function public.assert_identity_usable(p_identity_id uuid)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
begin
  if p_identity_id is null then
    raise exception 'assert_identity_usable: an outreach identity is required'
      using errcode = '42501';
  end if;

  if not public.identity_usable_by_actor(p_identity_id) then
    raise exception 'assert_identity_usable: actor may not use outreach identity %', p_identity_id
      using errcode = '42501';
  end if;
end
$$;

-- The `actor` argument of the audited RPCs must match the real caller unless
-- the caller is an admin (acting on behalf) or a service token.
create or replace function public.assert_actor(p_actor uuid)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
begin
  if p_actor is null then
    raise exception 'assert_actor: an actor is required'
      using errcode = '42501';
  end if;

  if public.current_user_id() is not null
     and p_actor <> public.current_user_id()
     and not public.is_admin() then
    raise exception 'assert_actor: actor % does not match the signed-in user', p_actor
      using errcode = '42501';
  end if;
end
$$;

create or replace function public.require_admin(p_reason text)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin permission required: %', coalesce(p_reason, 'admin only')
      using errcode = '42501';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Platform settings + DNC helpers
-- ---------------------------------------------------------------------------

create or replace function public.setting_json(
  p_key text,
  p_business_id uuid default null
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select s.value
        from public.platform_settings s
       where s.key = p_key
         and s.business_id is not distinct from p_business_id
    ),
    (
      select s.value
        from public.platform_settings s
       where s.key = p_key
         and s.business_id is null
    )
  );
$$;

create or replace function public.setting_text(
  p_key text,
  p_business_id uuid default null
)
  returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select case jsonb_typeof(public.setting_json(p_key, p_business_id))
           when 'null' then null
           when 'string' then public.setting_json(p_key, p_business_id) #>> '{}'
           else (public.setting_json(p_key, p_business_id))::text
         end;
$$;

create or replace function public.setting_int(
  p_key text,
  p_default integer,
  p_business_id uuid default null
)
  returns integer
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(public.setting_text(p_key, p_business_id), '')::numeric::integer,
    p_default
  );
$$;

create or replace function public.setting_bool(
  p_key text,
  p_default boolean,
  p_business_id uuid default null
)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(public.setting_text(p_key, p_business_id), '')::boolean,
    p_default
  );
$$;

create or replace function public.is_dnc_blocked(p_person_id uuid, p_channel text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p_person_id is not null
     and exists (
       select 1
         from public.contact_suppressions cs
        where cs.person_id = p_person_id
          and cs.channel = p_channel
          and cs.active
          and cs.revoked_at is null
     );
$$;

comment on function public.is_dnc_blocked(uuid, text) is
  'spec sequence_engine.do_not_contact — an explicit DNC suppresses the person+channel across every identity.';

-- ---------------------------------------------------------------------------
-- Audit writer used by triggers (DB_CONTRACT.md §4 enqueue_audit)
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_audit(
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_business_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_source_client text default null
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_actor_type text;
  v_actor_id uuid;
begin
  v_actor_type := case
                    when public.acting_api_client_id() is not null then 'api_client'
                    when public.current_user_id() is not null then 'user'
                    else 'system'
                  end;
  v_actor_id := coalesce(public.acting_api_client_id(), public.current_user_id());

  insert into public.audit_events (
    actor_type, actor_id, business_id, entity_type, entity_id, action,
    before_json, after_json, source_client, api_client_id
  )
  values (
    v_actor_type, v_actor_id, p_business_id, p_entity_type, p_entity_id, p_action,
    p_before, p_after,
    coalesce(p_source_client, current_setting('nexus.source_client', true)),
    public.acting_api_client_id()
  )
  returning id into v_id;

  return v_id;
end
$$;

create or replace function public.allowed_hard_delete()
  returns boolean
  language sql
  stable
as $$
  select coalesce(current_setting('nexus.allow_hard_delete', true), 'off') = 'on';
$$;

comment on function public.allowed_hard_delete() is
  'DB_CONTRACT.md §2 invariant 11 — hard delete is only reachable inside the audited admin flow.';

-- ---------------------------------------------------------------------------
-- Normalization helpers (DB_CONTRACT.md §2 invariants 3, 4, 13)
-- Deterministic so the same input always yields the same dedupe key.
-- ---------------------------------------------------------------------------

create or replace function public.normalize_url(p_url text)
  returns text
  language sql
  immutable
as $$
  select nullif(
    rtrim(
      split_part(
        split_part(
          regexp_replace(lower(btrim(coalesce(p_url, ''))), '^https?://', ''),
          '#', 1
        ),
        '?', 1
      ),
      '/'
    ),
    ''
  );
$$;

create or replace function public.normalize_linkedin_url(p_url text)
  returns text
  language sql
  immutable
as $$
  select nullif(
    rtrim(
      regexp_replace(public.normalize_url(p_url), '^(www\.|[a-z]{2}\.)+', ''),
      '/'
    ),
    ''
  );
$$;

create or replace function public.normalize_domain(p_domain text)
  returns text
  language sql
  immutable
as $$
  select nullif(
    rtrim(
      split_part(
        regexp_replace(
          split_part(
            regexp_replace(lower(btrim(coalesce(p_domain, ''))), '^https?://', ''),
            '/', 1
          ),
          '^(www\.)',
          ''
        ),
        ':', 1
      ),
      '.'
    ),
    ''
  );
$$;

create or replace function public.normalize_name(p_name text)
  returns text
  language sql
  immutable
as $$
  select nullif(
    btrim(regexp_replace(lower(btrim(coalesce(p_name, ''))), '[^a-z0-9]+', ' ', 'g')),
    ''
  );
$$;

create or replace function public.normalize_text(p_text text)
  returns text
  language sql
  immutable
as $$
  select nullif(btrim(coalesce(p_text, '')), '');
$$;

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger (DB_CONTRACT.md §0 "timestamps")
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
  returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

reset check_function_bodies;
