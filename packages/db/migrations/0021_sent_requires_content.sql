-- ---------------------------------------------------------------------------
-- 0021 — a SENT message must carry content that can be shown as history
--
-- `mark_message_sent` already refuses to send an instance with no
-- `current_version_id`, which closes the "SENT with nothing at all" case. It did
-- not close the one next to it: `message_versions.content` is `text not null`, so an
-- empty or whitespace-only body is a legal version. An instance frozen onto one of
-- those is SENT forever with nothing to display, and because a SENT instance's
-- versions and `current_version_id` are immutable by trigger there is no way to
-- repair it afterwards.
--
-- Both layers are added, and neither rewrites `mark_message_sent`:
--
--   * a `CHECK` constraint on `message_versions` — the durable invariant, covering
--     every write path including the MCP `nexus.submit_message_draft` tool; and
--   * a `BEFORE` trigger on `message_instances` for the SENT transition, so the
--     refusal is raised at the moment the state is frozen rather than at the insert
--     that caused it. A trigger is used deliberately instead of a guard inside
--     `mark_message_sent`: that function is 180 lines of sequence-advance logic, and
--     `create or replace` would mean duplicating all of it into this migration,
--     where the next change to the original would silently diverge.
--
-- The trigger is a backstop, not the primary check: the repository now refuses a
-- blank draft before the call, so an operator sees a sentence rather than a
-- constraint name. This exists so that *no* path — RPC, MCP tool or a future one —
-- can produce an unshowable SENT row.
-- ---------------------------------------------------------------------------

-- Whitespace-only is empty for this purpose: a body of spaces renders as an empty
-- message to the prospect and to the history view. `btrim` covers tabs and newlines.
alter table public.message_versions
  drop constraint if exists message_versions_content_not_blank_check;

alter table public.message_versions
  add constraint message_versions_content_not_blank_check
  check (btrim(content) <> '');

comment on constraint message_versions_content_not_blank_check on public.message_versions is
  'spec sequence_engine.message_states — a sent message is immutable history, so a blank body would be permanently unshowable.';

create or replace function public.assert_sent_message_has_content()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_content text;
begin
  if new.state <> 'SENT' then
    return new;
  end if;
  -- A row that was already SENT and still is: the version cannot change (a trigger refuses it),
  -- so there is nothing new to assert.
  if tg_op = 'UPDATE' and old.state = 'SENT' then
    return new;
  end if;

  if new.current_version_id is null then
    raise exception 'message instance % cannot be SENT without a current version', new.id
      using errcode = '23514';
  end if;

  select mv.content into v_content
    from public.message_versions mv
   where mv.id = new.current_version_id
     and mv.message_instance_id = new.id;

  if not found then
    raise exception 'current_version_id % does not belong to message instance %',
      new.current_version_id, new.id using errcode = '23503';
  end if;

  -- The message is immutable from here, so a blank body could never be corrected.
  if btrim(coalesce(v_content, '')) = '' then
    raise exception 'message instance % cannot be SENT: its current version has no content', new.id
      using errcode = '23514';
  end if;

  return new;
end
$$;

comment on function public.assert_sent_message_has_content() is
  'spec sequence_engine.message_states — a SENT message is immutable history, so it must have content.';

drop trigger if exists trg_message_instances_sent_requires_content on public.message_instances;
-- On every insert or update, not `update of state`: `mark_message_sent` sets `state` and `sent_at`
-- in one statement, but a future writer could set `current_version_id` on an instance that is
-- already SENT, and `update of state` would not fire for that.
create trigger trg_message_instances_sent_requires_content
  before insert or update on public.message_instances
  for each row execute function public.assert_sent_message_has_content();
