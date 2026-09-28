-- ============================================================================
-- NEXUS DB - 0027 least-privilege runtime service boundary
--
-- A hosted deployment must resolve hashed credentials and bootstrap its first
-- administrator without connecting as the database owner or holding BYPASSRLS.
-- The NOLOGIN role below can execute only the small SECURITY DEFINER surface
-- declared here. Normal application work still SET LOCAL ROLE authenticated and
-- remains subject to forced RLS.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nexus_service') then
    create role nexus_service nologin noinherit nobypassrls;
  end if;
end
$$;

grant usage on schema public to nexus_service;

create or replace function public.nexus_deployment_is_claimed()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (select 1 from public.users);
$$;

create or replace function public.nexus_bootstrap_first_admin(
  p_email text,
  p_full_name text,
  p_password_hash text
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  lock table public.users in share row exclusive mode;
  if exists (select 1 from public.users) then
    return null;
  end if;

  insert into public.users (email, full_name, role, status)
  values (lower(trim(p_email)), trim(p_full_name), 'admin', 'active')
  returning id into v_user_id;

  insert into public.user_credentials (user_id, password_hash)
  values (v_user_id, p_password_hash);

  insert into public.audit_events
    (actor_type, actor_id, entity_type, entity_id, action, after_json, source_client)
  values
    ('system', v_user_id, 'users', v_user_id, 'bootstrap_first_admin',
     jsonb_build_object('email', lower(trim(p_email)), 'role', 'admin'), 'web-bootstrap');

  return v_user_id;
end
$$;

create or replace function public.nexus_resolve_api_client(p_token_hash text)
  returns table (id uuid, name text, scopes text[], business_ids uuid[])
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  select c.id, c.name, c.scopes, c.business_ids
    from public.api_clients c
   where c.token_hash = p_token_hash
     and c.is_active
     and c.revoked_at is null
     and (c.expires_at is null or c.expires_at > now());
$$;

create or replace function public.nexus_get_user_profile(p_user_id uuid)
  returns table (id uuid, email text, full_name text, role text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select u.id, u.email, u.full_name, u.role
    from public.users u
   where u.id = p_user_id
     and u.deleted_at is null
     and u.status = 'active';
$$;

create or replace function public.nexus_revoke_user_token_by_hash(p_token_hash text)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.user_api_tokens
     set revoked_at = now()
   where token_hash = p_token_hash
     and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end
$$;

revoke all on function public.nexus_deployment_is_claimed() from public, anon, authenticated;
revoke all on function public.nexus_bootstrap_first_admin(text, text, text) from public, anon, authenticated;
revoke all on function public.nexus_resolve_api_client(text) from public, anon, authenticated;
revoke all on function public.nexus_get_user_profile(uuid) from public, anon, authenticated;
revoke all on function public.nexus_revoke_user_token_by_hash(text) from public, anon, authenticated;

grant execute on function public.nexus_deployment_is_claimed() to nexus_service;
grant execute on function public.nexus_bootstrap_first_admin(text, text, text) to nexus_service;
grant execute on function public.nexus_resolve_api_client(text) to nexus_service;
grant execute on function public.nexus_get_user_profile(uuid) to nexus_service;
grant execute on function public.nexus_revoke_user_token_by_hash(text) to nexus_service;

-- Existing credential functions are also service-only. Migration 0026 grants
-- the general application function surface to authenticated; re-tighten these
-- specific secret-bearing entry points after that broad application grant.
revoke all on function public.authenticate_user(text) from public, anon, authenticated;
revoke all on function public.record_login_attempt(uuid, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.issue_user_token(uuid, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.resolve_user_token(text) from public, anon, authenticated;

grant execute on function public.authenticate_user(text) to nexus_service;
grant execute on function public.record_login_attempt(uuid, boolean, integer, integer) to nexus_service;
grant execute on function public.issue_user_token(uuid, text, text, text, text, integer) to nexus_service;
grant execute on function public.resolve_user_token(text) to nexus_service;
