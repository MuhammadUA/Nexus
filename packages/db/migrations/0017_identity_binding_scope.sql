-- ---------------------------------------------------------------------------
-- 0017 — a business-level administrator may bind an outreach identity
--
-- `browser_sessions_insert` originally allowed a session for an identity only when the actor was
-- a global administrator or the identity's `managed_by_user_id`. That is narrower than the rest of
-- the product, where "admin" is also a per-business access level: a user with an admin-level grant
-- on the business that can see an identity manages that identity everywhere else — on the
-- identities screen, on the team screen, and through `identity.manage`.
--
-- The effect of the gap was that such a user could be shown the identity in the Companion's
-- selector, choose it, and have the insert refused with a policy violation surfaced as
-- "That record already exists." No data was exposed and no rule was bypassed: the row simply could
-- not be created for a user who was entitled to create it.
--
-- The check is expressed as a function so the policy stays readable and so the same rule can be
-- reused by any later policy that needs it.
-- ---------------------------------------------------------------------------

create or replace function public.manages_outreach_identity(p_identity_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select
    -- A global administrator manages every identity.
    public.is_admin()
    -- An RLS-bypassing writer — bootstrap and seeding, which announce themselves with the
    -- `service_role` claim — is acting with administrator authority by construction. The claim is
    -- set only inside `withServiceRole`, which also turns `row_security` off, so this cannot be
    -- reached by a request that did not already have the run of the database.
    --
    -- `nullif(..., '')` matters: an unset or emptied setting is the empty string, not null, and
    -- `''::jsonb` raises 22P02 rather than being false. A bare context — `set row_security = off`
    -- with no claims set at all, which is how the demo seed writes — hits exactly that.
    or coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role'
       = 'service_role'
    -- The identity's own manager manages it.
    or exists (
      select 1
        from public.outreach_identities i
       where i.id = p_identity_id
         and i.managed_by_user_id = public.current_user_id()
    )
    -- An admin-level grant on any business the identity is available to manages it. The join
    -- through `outreach_identity_business_access` is what keeps this scoped: an admin of one
    -- business cannot reach an identity that business cannot use.
    or exists (
      select 1
        from public.outreach_identity_business_access a
        join public.user_business_access g
          on g.business_id = a.business_id
         and g.user_id = public.current_user_id()
       where a.outreach_identity_id = p_identity_id
         and g.access_level = 'admin'
    );
$$;

comment on function public.manages_outreach_identity(uuid) is
  'True when the actor may act as manager of this outreach identity: global admin, its managed_by_user_id, or an admin-level grant on a business the identity is available to.';

drop policy if exists browser_sessions_insert on public.browser_sessions;
create policy browser_sessions_insert on public.browser_sessions
  for insert to authenticated
  with check (
    user_id = public.current_user_id()
    and (
      outreach_identity_id is null
      or public.manages_outreach_identity(outreach_identity_id)
    )
  );

-- ---------------------------------------------------------------------------
-- The same rule, in the trigger that guards every write to a session.
--
-- `validate_browser_session_identity` (0011) carried its own copy of the check —
-- `is_admin() or managed_by_user_id = new.user_id`. That copy is what actually raised, so widening
-- only the policy would have left the defect in place: a business-level administrator would still
-- have been refused with a `42501` hinting at an "explicit audited transfer" that no code path
-- offered. It now calls the same function the policy does, so the two cannot drift again.
--
-- The remaining checks — the identity exists, is active, and is available to the business — are
-- unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.validate_browser_session_identity()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_identity public.outreach_identities%rowtype;
begin
  if new.outreach_identity_id is null then
    return new;
  end if;

  select * into v_identity
    from public.outreach_identities i
   where i.id = new.outreach_identity_id;

  if not found then
    raise exception 'browser session references unknown outreach identity %', new.outreach_identity_id
      using errcode = '23503';
  end if;

  if v_identity.deleted_at is not null or v_identity.status <> 'active' then
    raise exception 'outreach identity % is not active', new.outreach_identity_id
      using errcode = '23514';
  end if;

  if not public.manages_outreach_identity(new.outreach_identity_id) then
    raise exception 'user % may not bind outreach identity %', new.user_id, new.outreach_identity_id
      using errcode = '42501',
            hint = 'an identity owned by another user requires an explicit audited transfer';
  end if;

  if new.default_business_id is not null
     and not public.has_identity_business_access(new.outreach_identity_id, new.default_business_id) then
    raise exception 'outreach identity % has no access to business %', new.outreach_identity_id, new.default_business_id
      using errcode = '42501';
  end if;

  return new;
end
$$;
