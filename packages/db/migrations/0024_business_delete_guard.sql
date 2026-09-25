-- ---------------------------------------------------------------------------
-- 0024 — Permanent business deletion is refused when protected history exists
--
-- `businesses` is the root of cascading foreign keys. Deleting one row takes with it
-- every lead, conversation, message instance and version, message event, interaction,
-- note, task, source-evidence row and import batch that belonged to it — and through
-- `message_instances.current_version_id` the exact text that was sent to real people.
-- A reply is evidence that someone answered; a message is evidence of what they were
-- told. Neither can be reconstructed, and neither is a cache.
--
-- So permanent deletion is not "cleanup with a scary button". It is allowed only for a
-- business that has no history to lose — one created by mistake.
--
-- The refusal lives in a BEFORE DELETE trigger rather than only in the application for
-- the same reason the archive block does: `businesses_delete` is granted to any admin
-- by RLS, so a single `delete from public.businesses` — from a future screen, a script,
-- or the MCP surface — would otherwise cascade without ever meeting the guard.
--
-- Note on `allowed_hard_delete()`: that setting governs whether history rows may be
-- *purged* (leads in Trash, audit rows). It deliberately does not unlock this guard.
-- "May I purge a trashed lead" and "may I destroy a business and everything in it" are
-- different questions, and conflating them would make `nexus.allow_hard_delete = on`
-- a one-word way to lose a tenant's entire history.
-- ---------------------------------------------------------------------------

create or replace function public.assert_business_deletable()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_history jsonb;
  v_total integer;
  v_reasons text[];
begin
  v_history := public.business_protected_history(old.id);

  select coalesce(sum(value::int), 0)
    into v_total
    from jsonb_each_text(v_history);

  if v_total > 0 then
    select array_agg(format('%s %s', key, value))
      into v_reasons
      from jsonb_each_text(v_history)
     where value::int > 0;

    raise exception
      'business % has protected history and cannot be permanently deleted (%s)',
      old.id, array_to_string(v_reasons, ', ')
      using errcode = '23514',
            hint = 'Archive the business instead: archiving preserves every lead, message, reply, task and audit row, and removes it from active selectors and new work.';
  end if;

  -- Nothing to preserve. The delete proceeds, and the audit trail of the deletion
  -- itself is written by the `businesses` audit trigger that already exists.
  return old;
end
$$;

comment on function public.assert_business_deletable() is
  'spec business_units — a business with any history record may not be permanently deleted; archive it.';

drop trigger if exists trg_businesses_protect_history on public.businesses;
create trigger trg_businesses_protect_history
  before delete on public.businesses
  for each row execute function public.assert_business_deletable();
