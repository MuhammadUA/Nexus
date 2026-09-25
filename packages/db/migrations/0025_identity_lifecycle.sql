-- ---------------------------------------------------------------------------
-- 0025 — Outreach identity lifecycle: archive, unassign, and a safe-delete guard
--
-- The identity model already had transfer. What it lacked was the rest of the
-- lifecycle, and one of the gaps was a silent data-loss path:
--
--   Every foreign key that points at `outreach_identities` is `on delete set null` —
--   `message_events.outreach_identity_id`, `conversations.sender_identity_id`,
--   `leads.outreach_identity_id`, `interactions.outreach_identity_id`,
--   `browser_sessions.outreach_identity_id`. So deleting an identity does not fail:
--   it *succeeds*, and quietly erases who sent every message that identity ever sent.
--   The message text survives; the attribution does not. For a CRM whose spec says
--   "sent message content is immutable history" and whose duplicate-outreach rule
--   depends on "the prior sender must be visible", that is worse than a hard failure,
--   because nothing reports it.
--
-- Three pieces here:
--
--   1. **`retired` is terminal and means archived.** `outreach_identities.status`
--      already accepted 'retired'; 0025 gives it teeth — an archived identity may not
--      be reactivated, because "who may send as this account" is a decision with a
--      history and silently reversing it would make the history misleading.
--   2. **An archived identity is unusable for new work** — including for an admin.
--      `identity_usable_by_actor` previously short-circuited on `is_admin()` *before*
--      looking at the identity at all, so an admin could send as a retired identity,
--      bind a browser to it, or enrol a lead with it. The admin branch is now still
--      subject to the identity's own state, which is the whole point of retiring one.
--   3. **Deletion is refused when the identity carries attribution.** A trigger, so it
--      holds for every caller, and a typed rejection the application surfaces as
--      "archive it instead".
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Archiving is a one-way door.
--
-- `restrict_identity_self_update` already confines a non-admin owner to presentation
-- fields, so this only has to constrain an admin. An explicit exception carries the
-- operator-facing reason; silently ignoring the change would leave a screen showing a
-- value the database did not store.
-- ---------------------------------------------------------------------------
create or replace function public.assert_identity_status_transition()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if old.status = 'retired' and new.status is distinct from 'retired' then
    raise exception
      'outreach identity % is archived and cannot be reactivated', old.id
      using errcode = '23514',
            hint = 'Create a new identity instead. Historical attribution on this one is preserved and must stay unambiguous.';
  end if;

  return new;
end
$$;

comment on function public.assert_identity_status_transition() is
  'spec identity_model — retiring an identity is terminal; un-retiring would make historical attribution ambiguous.';

drop trigger if exists trg_outreach_identities_status_transition on public.outreach_identities;
create trigger trg_outreach_identities_status_transition
  before update on public.outreach_identities
  for each row execute function public.assert_identity_status_transition();

-- ---------------------------------------------------------------------------
-- An archived identity cannot be used for new work — by anyone.
--
-- The previous definition was:
--
--   select p_identity_id is not null
--      and (public.is_admin() or (… owner and deleted_at is null …) or (… api client …))
--
-- Two problems. `is_admin()` came first, so an admin bypassed the identity's state
-- entirely; and the owner branch checked `deleted_at` but never `status`, so a paused
-- identity was equally usable. Both are corrected, and the `status = 'active'`
-- requirement is now stated once, before the branch, so no branch can omit it.
--
-- `deleted_at` still counts as unusable. Reading an identity's history remains
-- possible — visibility is `identity_visible`, which this does not touch.
-- ---------------------------------------------------------------------------
create or replace function public.identity_usable_by_actor(p_identity_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p_identity_id is not null
     and exists (
       select 1
         from public.outreach_identities i
        where i.id = p_identity_id
          and i.deleted_at is null
          and i.status = 'active'
     )
     and (
       public.is_admin()
       or (
         public.current_user_id() is not null
         and exists (
           select 1
             from public.outreach_identities i
            where i.id = p_identity_id
              and i.managed_by_user_id = public.current_user_id()
         )
       )
       or (
         public.acting_api_client_id() is not null
         and exists (
           select 1
             from public.outreach_identity_business_access x
            where x.outreach_identity_id = p_identity_id
              and x.business_id = any (public.api_client_business_ids())
         )
       )
     );
$$;

comment on function public.identity_usable_by_actor(uuid) is
  'spec identity_model — an active, non-deleted identity that the actor owns or administers. An archived identity is unusable for new work even by an admin.';

-- ---------------------------------------------------------------------------
-- Identity attribution census — what deleting this identity would orphan
-- ---------------------------------------------------------------------------
create or replace function public.identity_attribution(p_identity_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- The load-bearing count. `message_instances` carries no identity column, so the
    -- sender is recorded on the `sent` event, and that event is the only place the
    -- CRM says who actually reached a person. `on delete set null` on the column
    -- means deleting the identity would blank it rather than fail.
    'sent_messages', (
      select count(*) from public.message_events e
       where e.outreach_identity_id = p_identity_id and e.event_type = 'sent'
    ),
    'message_events', (
      select count(*) from public.message_events e where e.outreach_identity_id = p_identity_id
    ),
    'conversations', (
      select count(*) from public.conversations c where c.sender_identity_id = p_identity_id
    ),
    'leads', (
      select count(*) from public.leads l where l.outreach_identity_id = p_identity_id
    ),
    'interactions', (
      select count(*) from public.interactions i where i.outreach_identity_id = p_identity_id
    ),
    'browser_sessions', (
      select count(*) from public.browser_sessions s where s.outreach_identity_id = p_identity_id
    ),
    'transfers', (
      select count(*) from public.identity_transfers t where t.outreach_identity_id = p_identity_id
    )
  );
$$;

comment on function public.identity_attribution(uuid) is
  'Records that name this identity as the sender. A non-zero count means deletion would erase attribution; archive instead.';

-- ---------------------------------------------------------------------------
-- The guard.
--
-- `message_events` with `event_type = 'sent'` is the one count worth explaining: it
-- is written by `mark_message_sent`, so a single row is proof that this identity
-- actually reached someone. Everything else is corroboration.
-- ---------------------------------------------------------------------------
create or replace function public.assert_identity_deletable()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_attribution jsonb;
  v_total integer;
  v_reasons text[];
begin
  v_attribution := public.identity_attribution(old.id);

  select coalesce(sum(value::int), 0)
    into v_total
    from jsonb_each_text(v_attribution);

  if v_total > 0 then
    select array_agg(format('%s %s', key, value))
      into v_reasons
      from jsonb_each_text(v_attribution)
     where value::int > 0;

    raise exception
      'outreach identity % is referenced by history and cannot be deleted (%s)',
      old.id, array_to_string(v_reasons, ', ')
      using errcode = '23514',
            hint = 'Archive the identity instead: its status becomes retired, it disappears from sender and binding selectors, and every historical attribution stays intact.';
  end if;

  return old;
end
$$;

comment on function public.assert_identity_deletable() is
  'spec identity_model — deleting an identity would null the sender on every message it sent, so it is refused and archive is required.';

drop trigger if exists trg_outreach_identities_protect_attribution on public.outreach_identities;
create trigger trg_outreach_identities_protect_attribution
  before delete on public.outreach_identities
  for each row execute function public.assert_identity_deletable();

-- ---------------------------------------------------------------------------
-- No new index is needed for the archive action's session revocation.
--
-- `browser_sessions_active_identity_key` (0010) already enforces spec invariant 15
-- ("one active browser session per outreach identity"), so a bind that raced the
-- revocation would fail loudly on that index rather than leaving a retired identity
-- bound to a live browser. Naming it here so the reasoning is discoverable: the
-- archive action below depends on it.
-- ---------------------------------------------------------------------------
