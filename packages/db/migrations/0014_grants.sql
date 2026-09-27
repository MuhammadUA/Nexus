-- ============================================================================
-- NEXUS DB · 0014 — grants
--
-- Implements DB_CONTRACT.md §0 (RLS is the only correctness path) and §5
--            (dangerous defaults are revoked)
-- Spec
--   security_and_reliability.rules  ("Supabase service role is server-only",
--                                    "Extension uses user-scoped authentication",
--                                    "RLS enforces team/business/user visibility")
--   mcp_contract.forbidden_tool      (never expose arbitrary SQL)
--
-- Table privileges are granted to `authenticated` so that RLS — and only RLS —
-- decides which rows are reachable. `anon` deliberately receives nothing:
-- every policy in 0013 is `to authenticated`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Schema usage
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges for authenticated users (RLS filters the rows)
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- Function privileges: revoke the PostgreSQL default of EXECUTE to PUBLIC and
-- re-grant only to authenticated. Trigger functions are unaffected because
-- trigger execution does not check EXECUTE.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
-- On hosted Supabase auth.uid() is provider-managed and owned by
-- supabase_auth_admin, so the application migration runner must not alter its
-- grants. Bare PostgreSQL/PGlite owns the compatibility shim and can grant it.
do $$
begin
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth'
       and p.proname = 'uid'
       and pg_get_userbyid(p.proowner) = current_user
  ) then
    grant execute on function auth.uid() to authenticated;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Revoke dangerous defaults
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on schema public from anon;
revoke create on schema public from public;
do $$
begin
  if exists (
    select 1
      from pg_namespace n
     where n.nspname = 'auth'
       and pg_get_userbyid(n.nspowner) = current_user
  ) then
    revoke all on schema auth from public;
    revoke all on schema auth from anon;
  end if;
end
$$;

-- The audit ledger and the message history are append-only for every principal.
revoke update, delete, truncate on public.audit_events from authenticated;
revoke update, delete, truncate on public.message_events from authenticated;
revoke delete, truncate on public.message_instances from authenticated;
revoke delete, truncate on public.message_versions from authenticated;
revoke delete, truncate on public.ingest_requests from authenticated;

comment on schema public is
  'NEXUS application schema. Every table is ENABLE + FORCE row level security; see DB_CONTRACT.md §3.';
