-- ============================================================================
-- NEXUS DB . 0015 - local development authentication
--
-- Spec `security_and_reliability.stack` names Supabase Auth as the auth provider.
-- This migration does NOT replace it: Supabase remains the production provider,
-- and `auth.uid()` still reads `request.jwt.claims` exactly as Supabase sets it.
--
-- What this adds is a *local* credential path so the application is runnable,
-- testable and reviewable without a cloud project. It is deliberately narrow:
--
--   * `user_credentials` is a SEPARATE table from `users`, so a password hash can
--     never leak through an ordinary `select * from users` (which is reachable by
--     a user reading their own profile row).
--   * NO role - not `authenticated`, not `anon` - is granted ANY privilege on the
--     table. There is therefore no RLS policy to get wrong: the only reachable
--     path to a credential row is the SECURITY DEFINER functions below.
--   * `authenticate_user` returns just the credential record. It never exposes a
--     hash to a role that could be reached from a browser session.
--
-- Verification itself happens in Node (scrypt), and the expected hash is passed IN
-- to the comparison function; the database never computes a slow KDF, so a login
-- flood cannot pin a database worker.
--
-- Spec `screen_inventory` A01/U01: "No login panel contains hard-coded explanatory
-- examples about a specific user/business." Nothing here is surfaced to the UI.
--
-- ASCII only, deliberately: this file is a migration artifact and must apply
-- identically regardless of editor encoding, so no typographic punctuation.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- user_credentials - one row per user that has a local password set.
-- ---------------------------------------------------------------------------
create table if not exists public.user_credentials (
  user_id         uuid primary key references public.users (id) on delete cascade,
  -- Format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`. The algorithm and its
  -- parameters are stored with the hash so parameters can be raised later
  -- without invalidating existing credentials.
  password_hash   text not null,
  algorithm       text not null default 'scrypt'
                    constraint user_credentials_algorithm_check
                    check (algorithm in ('scrypt')),
  -- Set when the credential was rotated; used to invalidate sessions issued
  -- before the rotation.
  rotated_at      timestamptz,
  failed_attempts integer not null default 0
                    constraint user_credentials_failed_attempts_check
                    check (failed_attempts >= 0),
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.user_credentials is
  'Local development credential store. Reachable only through authenticate_user() and set_user_credential(); no role holds table privileges.';

-- FORCE RLS with no policies at all: even the table owner is bound by it unless
-- `row_security = off`, and non-owner roles hold no grants either.
alter table public.user_credentials enable row level security;
alter table public.user_credentials force row level security;

-- ---------------------------------------------------------------------------
-- set_user_credential(user, hash) - admin-only credential write.
-- ---------------------------------------------------------------------------
create or replace function public.set_user_credential(
  p_user_id uuid,
  p_password_hash text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  perform public.require_admin('set_user_credential');

  if p_password_hash is null or length(p_password_hash) < 20 then
    raise exception 'a password hash is required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.users u where u.id = p_user_id) then
    raise exception 'user % not found', p_user_id using errcode = 'P0002';
  end if;

  insert into public.user_credentials (user_id, password_hash, rotated_at)
  values (p_user_id, p_password_hash, now())
  on conflict (user_id) do update
    set password_hash = excluded.password_hash,
        rotated_at = now(),
        updated_at = now(),
        failed_attempts = 0,
        locked_until = null;

  perform public.enqueue_audit(
    'user_credentials', p_user_id, 'set_user_credential', null, null, null,
    current_setting('nexus.source_client', true)
  );

  return jsonb_build_object('user_id', p_user_id, 'credential_set', true);
end
$$;

comment on function public.set_user_credential(uuid, text) is
  'Admin-only credential write. Audited; the hash itself is never returned or logged.';

-- ---------------------------------------------------------------------------
-- authenticate_user(email) - the credential record for one email.
-- ---------------------------------------------------------------------------
-- Returns a TABLE rather than a jsonb object so callers read typed columns
-- (`select password_hash from public.authenticate_user($1)`) instead of indexing
-- into an opaque document. Restricted to the service path: `anon` and
-- `authenticated` hold no EXECUTE grant (see 0014_grants.sql), so it is
-- unreachable from a browser session.
create or replace function public.authenticate_user(p_email text)
  returns table (
    user_id uuid,
    password_hash text,
    role text,
    status text,
    locked_until timestamptz
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select u.id, c.password_hash, u.role, u.status, c.locked_until
    from public.users u
    join public.user_credentials c on c.user_id = u.id
   where lower(u.email) = lower(trim(p_email))
     and u.deleted_at is null
     and u.status <> 'disabled';
$$;

comment on function public.authenticate_user(text) is
  'Returns the credential record for one email so the caller can verify the hash. Service-path only: no EXECUTE grant for anon/authenticated.';

-- ---------------------------------------------------------------------------
-- record_login_attempt(user, success) - lockout bookkeeping.
-- ---------------------------------------------------------------------------
create or replace function public.record_login_attempt(
  p_user_id uuid,
  p_success boolean,
  p_max_failures integer default 8,
  p_lock_minutes integer default 15
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
  v_locked timestamptz;
begin
  if p_success then
    update public.user_credentials
       set failed_attempts = 0, locked_until = null, updated_at = now()
     where user_id = p_user_id;
    return jsonb_build_object('locked', false);
  end if;

  update public.user_credentials
     set failed_attempts = failed_attempts + 1,
         updated_at = now(),
         locked_until = case
                          when failed_attempts + 1 >= greatest(p_max_failures, 1)
                          then now() + make_interval(mins => greatest(p_lock_minutes, 1))
                          else locked_until
                        end
   where user_id = p_user_id
  returning failed_attempts, locked_until into v_attempts, v_locked;

  return jsonb_build_object(
    'locked', v_locked is not null and v_locked > now(),
    'failed_attempts', v_attempts,
    'locked_until', v_locked
  );
end
$$;

comment on function public.record_login_attempt(uuid, boolean, integer, integer) is
  'Lockout bookkeeping for the local credential path. Service-path only.';

-- ---------------------------------------------------------------------------
-- Platform setting: whether the local credential path is permitted at all.
-- ---------------------------------------------------------------------------
-- The conflict target MUST match the partial unique index for a global row.
--
-- `platform_settings` carries two constraints:
--     unique (business_id, key)               -- NULLS DISTINCT by default
--     unique (key) where business_id is null  -- the partial index
--
-- Because the composite constraint treats NULL as distinct, `on conflict
-- (business_id, key)` can never match an existing row whose business_id IS NULL.
-- The insert therefore proceeds and then violates the partial index with
-- `duplicate key value violates unique constraint "platform_settings_global_key"`.
--
-- That is not hypothetical: the web app re-applies the migration set on every boot
-- when it runs on the embedded PostgreSQL driver, so the SECOND server start failed
-- outright while the first looked perfectly healthy. Migration 0010 already gets
-- this right by naming the partial index condition as the inference clause; this
-- statement now does the same. `packages/db/test/migration-idempotency.test.ts`
-- asserts the whole set can be applied twice.
insert into public.platform_settings (business_id, key, value)
values (
  null,
  'security.local_auth_enabled',
  '{"enabled": false, "note": "Set true only for local development. Supabase Auth is the production provider."}'::jsonb
)
on conflict (key) where business_id is null do nothing;
