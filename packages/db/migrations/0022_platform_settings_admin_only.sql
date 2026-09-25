-- ---------------------------------------------------------------------------
-- 0022 — global platform settings are admin-only
--
-- `platform_settings_select` was:
--
--   using (business_id is null or public.has_business_access(business_id))
--
-- The first disjunct is the problem. A *global* row — `business_id is null` — is
-- platform configuration: the DNC suppression rule, the reply-pause rule, the
-- dormant-reactivation window, retention defaults, security defaults. Any
-- authenticated user could read every one of them, from any business, regardless of
-- their grants. The write policy was already admin-only, so this was a read of
-- configuration that only an administrator is meant to see at all.
--
-- The only page that reads this table today, `/settings`, is already admin-only
-- through `requireRouteAccess` — but that is a property of one call site, not of the
-- table. A policy that grants a read is the boundary, and the next page to read
-- `platform_settings` would have inherited the grant. `db:verify` and the tests in
-- `platform-settings-scope.test.ts` assert the policy itself, so the boundary no
-- longer depends on remembering to gate the caller.
--
-- Business-scoped rows keep their existing rule: a row is readable by someone with
-- access to that business. Only the global case is narrowed.
--
-- The application does not need broader read access. `setting_json` and
-- `setting_text` (0001) are `security definer`, so any internal consumer of a
-- setting already reads it through a function, with RLS bypassed by design and the
-- decision made by the calling code. `listPlatformSettings` in the web app is only
-- reachable from the admin settings route.
-- ---------------------------------------------------------------------------

drop policy if exists platform_settings_select on public.platform_settings;
create policy platform_settings_select on public.platform_settings
  for select to authenticated
  using (
    case
      when business_id is null then public.is_admin()
      else public.has_business_access(business_id)
    end
  );

comment on policy platform_settings_select on public.platform_settings is
  'Global (business_id is null) settings are admin-only; a business-scoped row needs access to that business.';
