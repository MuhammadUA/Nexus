-- ---------------------------------------------------------------------------
-- 0020 — MCP tool invocation idempotency
--
-- DB_CONTRACT.md §2 invariant 6 ("the same (source_client, business_id,
-- idempotency_key) can never be processed twice") was enforced for ingestion
-- through `ingest_requests`. The MCP gateway declared `needsIdempotencyKey` on
-- several tools and did nothing with it: the key was read, checked for presence,
-- and discarded, so a client that retried `nexus.create_signal` after a timeout
-- inserted a second signal. Signals are append-only by design, so nothing in the
-- schema would ever have caught it.
--
-- A dedicated table rather than reusing `ingest_requests`: that table's
-- `payload_type`, `content_hash` and pipeline-shaped `result` describe an ingest,
-- and storing a `nexus.create_task` outcome in it would make the ingest audit
-- trail unreadable.
--
-- `api_client_id` is nullable because a tool may be called by a signed-in user
-- through the gateway; the uniqueness key therefore treats NULL as a distinct
-- value, and the actor id is part of what identifies the caller.
-- ---------------------------------------------------------------------------

create table if not exists public.mcp_tool_invocations (
  id               uuid primary key default gen_random_uuid(),
  api_client_id    uuid references public.api_clients (id) on delete set null,
  actor_user_id    uuid references public.users (id) on delete set null,
  business_id      uuid references public.businesses (id) on delete cascade,
  tool_name        text not null,
  idempotency_key  text not null,
  -- The hash of the arguments the key was first used with. Replaying a key with
  -- different arguments is a client bug, and returning the first result would hide
  -- it; the gateway refuses instead, which is why the hash is stored at all.
  arguments_hash   text not null,
  result           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

comment on table public.mcp_tool_invocations is
  'DB_CONTRACT.md §2 invariant 6 for MCP tools — one row per (caller, business, tool, idempotency_key).';

-- Two partial unique indexes rather than one: a user-called tool and a
-- client-called tool are different callers, and `unique (...)` treats NULLs as
-- distinct only because that is the default — stating it explicitly with two
-- indexes makes the intent obvious and the constraint enforceable.
create unique index if not exists mcp_tool_invocations_client_key
  on public.mcp_tool_invocations (api_client_id, business_id, tool_name, idempotency_key)
  where api_client_id is not null;

create unique index if not exists mcp_tool_invocations_user_key
  on public.mcp_tool_invocations (actor_user_id, business_id, tool_name, idempotency_key)
  where actor_user_id is not null;

create index if not exists mcp_tool_invocations_business_idx
  on public.mcp_tool_invocations (business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS — a caller may only see its own invocation records. The gateway writes and
-- reads them through the acting identity, so this is the same boundary as every
-- other table: another business's keys are not readable, and cannot be replayed.
-- ---------------------------------------------------------------------------

-- FORCE, not just ENABLE: the owner would otherwise bypass its own policies.
-- `0013_rls.sql` sets both in a loop over the tables that existed then, and this table
-- is newer, so it states both itself. `db:verify` fails a business_id table that is
-- missing FORCE, which is how this was caught.
alter table public.mcp_tool_invocations enable row level security;
alter table public.mcp_tool_invocations force row level security;

drop policy if exists mcp_tool_invocations_select on public.mcp_tool_invocations;
create policy mcp_tool_invocations_select on public.mcp_tool_invocations
  for select to authenticated
  using (
    public.is_admin()
    or (api_client_id is not null and api_client_id = public.acting_api_client_id())
    or (actor_user_id is not null and actor_user_id = public.current_user_id())
  );

drop policy if exists mcp_tool_invocations_insert on public.mcp_tool_invocations;
create policy mcp_tool_invocations_insert on public.mcp_tool_invocations
  for insert to authenticated
  with check (
    public.is_admin()
    or (api_client_id is not null and api_client_id = public.acting_api_client_id())
    or (actor_user_id is not null and actor_user_id = public.current_user_id())
  );

-- No update or delete policy: an idempotency record is evidence that a call
-- happened, and the result it maps to must not be rewritable.
--
-- `0014_grants.sql` granted on "all tables in schema public", which only covered the
-- tables that existed at the time; this one is newer, so its base grants are stated
-- here and then narrowed.
grant select, insert on public.mcp_tool_invocations to authenticated;

revoke update, delete, truncate on public.mcp_tool_invocations from authenticated;
