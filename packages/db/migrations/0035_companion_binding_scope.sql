-- ============================================================================
-- NEXUS DB - 0035 Companion binding scope
--
-- Implements
--   spec companion_extension.channel_account_and_business (V1.2 §36)
--   spec roles_and_permissions.extension_visibility_rule
--
-- The Companion binds one browser profile to one outreach (channel) account and
-- one default business. Two defects made that flow unusable in production, and
-- both live in the predicate the panel and the write path share:
--
--   1. `companion_visible_business_ids` derived the visible set as
--      `user_business_access INTERSECT outreach_identity_business_access` for
--      *every* caller. A global administrator legitimately has no
--      `user_business_access` row — `has_business_access` / `visible_business_ids`
--      short-circuit on `is_admin()` — so the intersection came back empty for
--      them and the Companion offered no business at all, and every bind was
--      refused. The admin case below is intentional: a global administrator sees
--      every business the chosen account is available to.
--
--      Server-side binding validation still requires account access, and still
--      requires a grant for a non-admin — see `companion_ineligible_reason`. The
--      admin branch widens *visibility* only; it never widens what may be bound.
--
--   2. Nothing refused an ineligible (account, business) pair server-side. The
--      browser_sessions policy checks that the actor manages the identity and the
--      0017 trigger checks that the identity has access to the business, but no
--      rule required the *user* to have a grant on that business, so a crafted
--      request could bind a pair the panel would never have offered. The reason
--      helper states the rule once and the trigger applies it to every write.
--
-- Existing rows are not revalidated: a binding made before this migration keeps
-- working (its panel selector simply will not offer the pair again).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Companion-visible businesses for a chosen outreach identity.
--
-- Global administrator  -> every business in outreach_identity_business_access
--                          for that identity.
-- Anyone else           -> user_business_access INTERSECT identity access, which
--                          is the spec's "never a union" rule and is unchanged.
--
-- SECURITY DEFINER, because the function is the policy input for the panel's
-- selectors and must not recurse through the RLS policies it feeds.
-- ---------------------------------------------------------------------------
create or replace function public.companion_visible_business_ids(p_identity_id uuid)
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select i.business_id
    from public.outreach_identity_business_access i
   where i.outreach_identity_id = p_identity_id
     and (
       -- The admin case is deliberate: a global administrator holds no
       -- user_business_access rows and is already entitled to every business, so
       -- the intersection below would deny them the whole Companion. Binding is
       -- still separately validated (account access + user grant) by
       -- `companion_ineligible_reason`, so this is visibility, not authority.
       public.is_admin()
       or exists (
         select 1
           from public.user_business_access a
          where a.user_id = public.current_user_id()
            and a.business_id = i.business_id
       )
     );
$$;

comment on function public.companion_visible_business_ids(uuid) is
  'spec roles_and_permissions.extension_visibility_rule — user access INTERSECT identity access, except that a global administrator (who holds no user_business_access row) sees every business the account may send from. Binding authority is still checked by companion_ineligible_reason.';

-- ---------------------------------------------------------------------------
-- Why a (account, business) pair is or is not bindable.
--
-- Returns a stable, non-disclosing code:
--
--   'ok'                 the pair may be bound
--   'identity_not_usable'the identity is missing, archived, or one this actor may not bind
--   'no_account_access'  the identity is not available to that business
--   'no_user_grant'      a non-admin caller has no user_business_access row for that business
--
-- `public.businesses` is never read, so the answer cannot reveal whether a
-- business exists: an unknown id and an existing business the account cannot
-- reach both answer 'no_account_access'. The order of the cases is what keeps it
-- that way — the identity is judged first, so a caller who may not use the
-- identity learns nothing about any business.
--
-- A NULL business is 'ok': "no default business" is a legitimate binding state
-- (the panel may bind before a business is chosen), and there is no business
-- scope to judge. The identity is still validated, so a NULL business cannot be
-- used to bind an identity the actor may not use.
--
-- `manages_outreach_identity` is wrapped in `coalesce(..., false)` deliberately. Its own
-- body ORs a jsonb comparison that is NULL when the caller's claims carry no `role`, so it
-- returns NULL -- not false -- for an ordinary signed-in user who does not manage the
-- identity. `not NULL` is NULL, so that CASE branch would be skipped and the pair would
-- fall through to the business checks as though the identity were usable. A predicate used
-- as an authorization input must never be three-valued.
-- ---------------------------------------------------------------------------
create or replace function public.companion_ineligible_reason(
  p_identity_id uuid,
  p_business_id uuid
)
  returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select case
           -- Archived and deleted identities are unusable for new work by anyone
           -- (0025), and the claim to an identity is the same predicate the
           -- browser_sessions policy uses (0017).
           when not exists (
             select 1
               from public.outreach_identities i
              where i.id = p_identity_id
                and i.deleted_at is null
                and i.status = 'active'
           ) then 'identity_not_usable'
           when not coalesce(public.manages_outreach_identity(p_identity_id), false)
             then 'identity_not_usable'
           when p_business_id is null then 'ok'
           -- The account must be available to the business (invariant 14).
           when not exists (
             select 1
               from public.outreach_identity_business_access x
              where x.outreach_identity_id = p_identity_id
                and x.business_id = p_business_id
           ) then 'no_account_access'
           -- A global administrator needs no grant; they already have every business.
           when public.is_admin() then 'ok'
           -- A service-role or scoped-token writer has no user grant to judge and is
           -- already validated by its own boundary.
           when public.current_user_id() is null then 'ok'
           -- The remaining case: a signed-in non-admin needs an explicit grant.
           when not exists (
             select 1
               from public.user_business_access a
              where a.user_id = public.current_user_id()
                and a.business_id = p_business_id
           ) then 'no_user_grant'
           else 'ok'
         end;
$$;

comment on function public.companion_ineligible_reason(uuid, uuid) is
  'spec companion_extension.channel_account_and_business — the bindable reason code for one (identity, business) pair. Non-disclosing: public.businesses is never read, so an unknown business and an unreachable one answer identically.';

-- ---------------------------------------------------------------------------
-- The same rule as a guard on the write.
--
-- The repository refuses an ineligible pair with the reason code before it
-- writes, but the repository is not the only door: a bearer token can reach the
-- table through the Data API. This trigger makes the database the authority, so
-- "the pair the panel would not offer" and "the pair the database accepts" are
-- the same set.
--
-- Deliberately narrow:
--
--   * it fires only when the identity or the default business is part of the
--     statement, so a heartbeat (`last_active_at`) or a revocation (`status`) is
--     never blocked by a binding that has since become stale;
--   * it applies only to a signed-in user. A service-role writer (bootstrap, demo
--     seed) and a scoped API client carry no `sub` claim, so `current_user_id()`
--     is NULL for them; they are already trusted writers with their own
--     boundary, exactly as in 0017's service_role branch;
--   * it does not touch `identity_usable_by_actor` or the 0017 identity trigger,
--     both of which keep their own, narrower, semantics.
-- ---------------------------------------------------------------------------
create or replace function public.assert_companion_binding_scope()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_reason text;
begin
  if new.outreach_identity_id is null then
    return new;
  end if;

  if public.current_user_id() is null then
    return new;
  end if;

  v_reason := public.companion_ineligible_reason(new.outreach_identity_id, new.default_business_id);

  if v_reason <> 'ok' then
    raise exception
      'outreach identity % may not be bound to business % (%)',
      new.outreach_identity_id, new.default_business_id, v_reason
      using errcode = '42501';
  end if;

  return new;
end
$$;

comment on function public.assert_companion_binding_scope() is
  'spec companion_extension.channel_account_and_business — refuses a user-written browser session whose (identity, business) pair is not bindable. Service-role and scoped-token writers are exempt.';

drop trigger if exists trg_browser_sessions_companion_scope on public.browser_sessions;
create trigger trg_browser_sessions_companion_scope
  before insert or update of outreach_identity_id, default_business_id
  on public.browser_sessions
  for each row execute function public.assert_companion_binding_scope();

-- ---------------------------------------------------------------------------
-- Privileges, stated explicitly rather than relying only on the schema-wide
-- default privileges that 0026 set up. The application calls both helpers after
-- `set local role authenticated`; anonymous callers may not.
-- ---------------------------------------------------------------------------
revoke all on function public.companion_visible_business_ids(uuid) from public, anon;
grant execute on function public.companion_visible_business_ids(uuid) to authenticated;

revoke all on function public.companion_ineligible_reason(uuid, uuid) from public, anon;
grant execute on function public.companion_ineligible_reason(uuid, uuid) to authenticated;

-- The trigger function is invoked by the database, never by a caller, so it is
-- revoked from every API-reachable role and granted to none of them.
revoke all on function public.assert_companion_binding_scope() from public, anon, authenticated;
