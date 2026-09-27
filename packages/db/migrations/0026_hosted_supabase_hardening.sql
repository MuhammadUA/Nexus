-- ============================================================================
-- NEXUS DB - 0026 hosted Supabase function hardening
--
-- PostgreSQL grants EXECUTE on newly created functions to PUBLIC by default.
-- Migration 0014 removes that default from all functions that exist at that
-- point, but migrations 0015-0025 add more functions afterward. On hosted
-- Supabase those functions are visible to the Data API, so repeat the intended
-- privilege boundary after the complete function set exists and harden future
-- migrations through ALTER DEFAULT PRIVILEGES.
--
-- The application deliberately executes database helpers after SET LOCAL ROLE
-- authenticated, so authenticated keeps EXECUTE. Anonymous callers do not.
-- ============================================================================

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;

alter default privileges in schema public
  revoke execute on functions from public;
alter default privileges in schema public
  revoke execute on functions from anon;
alter default privileges in schema public
  grant execute on functions to authenticated;

-- SECURITY DEFINER functions must never resolve attacker-controlled objects
-- through a mutable search_path. Apply the same fixed path to every application
-- function, including small SQL helpers and trigger functions.
do $$
declare
  v_function record;
begin
  for v_function in
    select n.nspname,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as identity_arguments
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = public, pg_temp',
      v_function.nspname,
      v_function.proname,
      v_function.identity_arguments
    );
  end loop;
end
$$;

