-- ============================================================================
-- NEXUS DB · 0016 — user API tokens
--
-- The Companion side panel and the web client authenticate as the *signed-in user*,
-- not as a service. They therefore need a bearer credential that resolves to a
-- `user_id`, after which the request runs through the ordinary RLS path — the same
-- policies, the same audit trail, the same audit actor as a browser session.
--
-- This is deliberately NOT `api_clients`. That table is for *external agents*
-- (ChatGPT, OpenCode, BrowserOS) and carries scopes and an explicit business
-- allow-list, because those callers act on behalf of a service, not a person.
-- Conflating the two would either over-privilege a personal token or force every
-- personal token to declare scopes it does not need.
--
-- spec `security_and_reliability.rules`: "Supabase service role is server-only and
-- never exposed to browser or extension" and "Extension uses user-scoped
-- authentication." This table is what makes the second rule implementable.
--
-- Only a SHA-256 hash of the token is stored, so a database disclosure does not
-- yield a usable credential. No role holds table privileges: the only reachable path
-- is the SECURITY DEFINER resolver below.
-- ============================================================================

create table if not exists public.user_api_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  -- Human label so an operator can tell two browsers apart ("Office Chrome").
  label         text not null default 'Companion',
  -- SHA-256 hex of the raw token. Never the token itself.
  token_hash    text not null,
  -- First few characters, for display only; not enough to reconstruct the token.
  token_prefix  text not null,
  client        text not null default 'companion'
                  constraint user_api_tokens_client_check
                  check (client in ('companion', 'web', 'cli')),
  -- Set when the token was last used, so stale tokens can be pruned.
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.user_api_tokens is
  'User-scoped bearer tokens (Companion/web). Hash only; resolved via resolve_user_token().';

create unique index if not exists user_api_tokens_hash_key
  on public.user_api_tokens (token_hash);

create index if not exists user_api_tokens_user_idx
  on public.user_api_tokens (user_id, created_at desc);

-- FORCE RLS with no policies: unreachable except through the resolver below.
alter table public.user_api_tokens enable row level security;
alter table public.user_api_tokens force row level security;

-- ---------------------------------------------------------------------------
-- issue_user_token(user, label, client, ttl) — returns the id, NOT the token.
-- ---------------------------------------------------------------------------
-- The raw token is generated in Node and hashed before it reaches the database, so
-- the plaintext never appears in a query log, a statement trace or a backup.
create or replace function public.issue_user_token(
  p_user_id uuid,
  p_token_hash text,
  p_token_prefix text,
  p_label text default 'Companion',
  p_client text default 'companion',
  p_ttl_days integer default 30
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_token_hash is null or length(p_token_hash) < 32 then
    raise exception 'a token hash is required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.users u where u.id = p_user_id and u.deleted_at is null) then
    raise exception 'user % not found', p_user_id using errcode = 'P0002';
  end if;

  insert into public.user_api_tokens (user_id, label, token_hash, token_prefix, client, expires_at)
  values (
    p_user_id,
    coalesce(nullif(trim(p_label), ''), 'Companion'),
    p_token_hash,
    p_token_prefix,
    p_client,
    case
      when p_ttl_days is null or p_ttl_days <= 0 then null
      else now() + make_interval(days => p_ttl_days)
    end
  )
  returning id into v_id;

  return v_id;
end
$$;

comment on function public.issue_user_token(uuid, text, text, text, text, integer) is
  'Records a hashed user token. Returns the row id; the raw token is never stored.';

-- ---------------------------------------------------------------------------
-- resolve_user_token(hash) — maps a bearer token to a user, or nothing.
-- ---------------------------------------------------------------------------
-- Returns the acting user id so the gateway can publish it as `request.jwt.claims`
-- and let RLS do the authorization. Also stamps `last_used_at`.
create or replace function public.resolve_user_token(p_token_hash text)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if p_token_hash is null or length(p_token_hash) = 0 then
    return null;
  end if;

  select t.user_id into v_user_id
    from public.user_api_tokens t
    join public.users u on u.id = t.user_id
   where t.token_hash = p_token_hash
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now())
     and u.deleted_at is null
     and u.status = 'active';

  if v_user_id is null then
    return null;
  end if;

  update public.user_api_tokens
     set last_used_at = now()
   where token_hash = p_token_hash;

  return v_user_id;
end
$$;

comment on function public.resolve_user_token(text) is
  'Bearer token -> user id for the API gateway. Returns NULL for unknown, revoked, expired or disabled.';

-- ---------------------------------------------------------------------------
-- revoke_user_token(user, token_id) — self-service revocation.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_user_token(p_user_id uuid, p_token_id uuid)
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
   where id = p_token_id
     and user_id = p_user_id
     and revoked_at is null;

  get diagnostics v_count = row_count;
  return v_count > 0;
end
$$;
