-- ---------------------------------------------------------------------------
-- 0023 — Business lifecycle: archive, restore, and a guarded permanent delete
--
-- `businesses.status` already accepted 'archived', and `cloneBusiness` already
-- copied configuration without touching history. What was missing was the
-- transition itself: nothing in the application could archive a business, nothing
-- stopped new leads, enrollments, message instances or imports being created inside
-- an archived one, and nothing stood between a business row and the cascade that
-- would destroy its history.
--
-- This migration adds three things:
--
--   1. `business_is_open()` — one predicate for "this business may accept new work".
--      Deliberately NOT folded into `has_business_access()`: that function decides
--      *visibility*, and an archived business must remain readable so its leads,
--      messages, replies, tasks and audit history stay available. Conflating the two
--      would make archiving indistinguishable from deletion.
--   2. `archive_business` / `restore_business` — audited RPCs, so the transition has
--      one implementation rather than a status column any caller could set.
--   3. A `BEFORE INSERT` trigger on the tables that represent new business-specific
--      work, so the block holds for every path — repository, MCP tool, raw SQL —
--      rather than only for the callers someone remembered to guard.
--
-- Permanent deletion is not implemented here on purpose. `businesses` is the root of
-- cascading foreign keys (`leads`, `message_instances`, `interviews`, `interactions`,
-- and through them the whole history of what was said to whom), so a delete is a
-- destructive cascade, not a cleanup. 0024 adds the guard that refuses it when any
-- protected history exists; the application refuses before it reaches the database.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- business_is_open — may this business accept new work?
--
-- `security definer` so a trigger on `leads` can call it without needing SELECT on
-- `businesses`, and `stable` so the planner may cache it within a statement.
-- ---------------------------------------------------------------------------
create or replace function public.business_is_open(p_business_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p_business_id is not null
     and exists (
       select 1
         from public.businesses b
        where b.id = p_business_id
          and b.status = 'active'
          and b.deleted_at is null
     );
$$;

comment on function public.business_is_open(uuid) is
  'spec business_units — an archived or soft-deleted business accepts no new leads, enrollments, messages or imports, while remaining readable.';

-- ---------------------------------------------------------------------------
-- The block itself.
--
-- A trigger rather than an assertion inside each writer because the set of writers
-- is large and open: repository code, MCP tools, the ingest pipeline, the seed
-- scripts. A single trigger per table cannot be forgotten by the next caller.
--
-- `business_id` is read from the row, so the trigger is correct for every insert
-- shape (VALUES, INSERT ... SELECT, and the `on conflict` paths).
-- ---------------------------------------------------------------------------
create or replace function public.assert_business_accepts_new_work()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_business_id uuid;
begin
  -- `to_jsonb(new)` avoids naming a column that not every gated table has; all four
  -- tables in this migration do carry `business_id`, but the function stays usable
  -- if it is attached to another one later.
  v_business_id := nullif(to_jsonb(new) ->> 'business_id', '')::uuid;

  if v_business_id is null then
    return new;
  end if;

  if not exists (
    select 1 from public.businesses b
     where b.id = v_business_id
       and b.status = 'active'
       and b.deleted_at is null
  ) then
    raise exception
      'business % does not accept new work: it is archived or deleted',
      v_business_id
      using errcode = '23514',
            hint = 'Restore the business first, or create the record in an active business. Existing history is unaffected.';
  end if;

  return new;
end
$$;

comment on function public.assert_business_accepts_new_work() is
  'spec business_units — refuses new business-specific work in an archived business. History is never blocked.';

-- New outreach, enrolments, imports and leads. Each is "new work inside the
-- business", which is what archiving is meant to stop.
do $$
declare
  v_table text;
  v_tables text[] := array['leads', 'sequence_enrollments', 'message_instances', 'import_batches'];
begin
  foreach v_table in array v_tables loop
    execute format('drop trigger if exists trg_%s_business_open on public.%I', v_table, v_table);
    execute format(
      'create trigger trg_%s_business_open before insert on public.%I
         for each row execute function public.assert_business_accepts_new_work()',
      v_table, v_table
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- archive_business / restore_business
--
-- Admin-only and audited. `assert_business_scope` is deliberately not called: an
-- admin may archive a business they were never granted, which is the point of the
-- operation, and `require_admin` is the check that matters.
-- ---------------------------------------------------------------------------
create or replace function public.archive_business(
  p_business_id uuid,
  p_actor uuid,
  p_reason text default null
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_open_leads integer;
  v_pending_messages integer;
begin
  perform public.assert_actor(p_actor);
  perform public.require_admin('archive_business');

  select * into v_business from public.businesses b where b.id = p_business_id for update;

  if not found then
    raise exception 'business % not found', p_business_id using errcode = 'P0002';
  end if;

  if v_business.deleted_at is not null then
    raise exception 'business % is deleted and cannot be archived', p_business_id
      using errcode = '23514';
  end if;

  if v_business.status = 'archived' then
    -- Idempotent: archiving an archived business is the operator's intent already
    -- satisfied, and an error here would make a retried request look like a failure.
    return jsonb_build_object(
      'business_id', p_business_id,
      'status', 'archived',
      'already_archived', true,
      'leads', (select count(*) from public.leads l where l.business_id = p_business_id and l.deleted_at is null),
      'messages', (select count(*) from public.message_instances m where m.business_id = p_business_id),
      'tasks', (select count(*) from public.tasks t where t.business_id = p_business_id)
    );
  end if;

  -- Counted for the audit row only. Archiving never deletes, so nothing here needs
  -- to be zero — the counts are what make the audit entry answer "what did this
  -- business hold when it was closed?" without a join back through time.
  select count(*) into v_open_leads
    from public.leads l
   where l.business_id = p_business_id and l.deleted_at is null;

  select count(*) into v_pending_messages
    from public.message_instances m
   where m.business_id = p_business_id and m.state <> 'SENT';

  update public.businesses b
     set status = 'archived',
         updated_at = now()
   where b.id = p_business_id;

  -- Unsent, scheduled outreach is cancelled rather than left to fall due inside an
  -- archived business. SENT instances are untouched: they are history.
  update public.sequence_enrollments e
     set state = 'paused',
         updated_at = now()
   where e.lead_id in (select l.id from public.leads l where l.business_id = p_business_id)
     and e.state = 'active';

  update public.message_instances m
     set invalidated_at = now(),
         regeneration_reason = 'business_archived'
   where m.business_id = p_business_id
     and m.sent_at is null
     and m.invalidated_at is null;

  perform public.enqueue_audit(
    'businesses', p_business_id, 'archive_business', p_business_id,
    jsonb_build_object('status', v_business.status),
    jsonb_build_object('status', 'archived', 'reason', p_reason),
    current_setting('nexus.source_client', true)
  );

  return jsonb_build_object(
    'business_id', p_business_id,
    'status', 'archived',
    'already_archived', false,
    'leads', v_open_leads,
    'unsent_messages_invalidated', v_pending_messages,
    'reason', p_reason
  );
end
$$;

comment on function public.archive_business(uuid, uuid, text) is
  'spec business_units — admin-only, audited, non-destructive. Preserves leads, messages, replies, tasks and history.';

create or replace function public.restore_business(
  p_business_id uuid,
  p_actor uuid
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
begin
  perform public.assert_actor(p_actor);
  perform public.require_admin('restore_business');

  select * into v_business from public.businesses b where b.id = p_business_id for update;

  if not found then
    raise exception 'business % not found', p_business_id using errcode = 'P0002';
  end if;

  if v_business.deleted_at is not null then
    raise exception 'business % is deleted and cannot be restored from archive', p_business_id
      using errcode = '23514';
  end if;

  if v_business.status <> 'archived' then
    return jsonb_build_object(
      'business_id', p_business_id,
      'status', v_business.status,
      'already_active', true
    );
  end if;

  update public.businesses b
     set status = 'active',
         updated_at = now()
   where b.id = p_business_id;

  -- Invalidated messages are left invalidated. Restoring the business does not
  -- resurrect a draft that was never sent; the operator regenerates it, which is
  -- the same path a publish takes.
  perform public.enqueue_audit(
    'businesses', p_business_id, 'restore_business', p_business_id,
    jsonb_build_object('status', 'archived'),
    jsonb_build_object('status', 'active'),
    current_setting('nexus.source_client', true)
  );

  return jsonb_build_object('business_id', p_business_id, 'status', 'active', 'already_active', false);
end
$$;

comment on function public.restore_business(uuid, uuid) is
  'spec business_units — admin-only, audited reversal of archive; invalidated drafts are not resurrected.';

-- ---------------------------------------------------------------------------
-- Business history census — what a permanent delete would destroy
--
-- Used by 0024's refusal and by the application before it calls anything. Each
-- count is of a record of something that happened: who was contacted, what was
-- said, what they replied, and what was decided. None of it can be reconstructed.
-- ---------------------------------------------------------------------------
create or replace function public.business_protected_history(p_business_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'leads', (select count(*) from public.leads l where l.business_id = p_business_id),
    'people_linked', (
      select count(distinct l.person_id) from public.leads l where l.business_id = p_business_id
    ),
    'companies_linked', (
      select count(distinct l.company_id) from public.leads l
       where l.business_id = p_business_id and l.company_id is not null
    ),
    'message_instances', (
      select count(*) from public.message_instances m where m.business_id = p_business_id
    ),
    'sent_messages', (
      select count(*) from public.message_instances m
       where m.business_id = p_business_id and m.state = 'SENT'
    ),
    'message_events', (
      select count(*) from public.message_events e where e.business_id = p_business_id
    ),
    'conversations', (
      select count(*) from public.conversations c where c.business_id = p_business_id
    ),
    'replies', (
      select count(*) from public.conversation_outcomes o where o.business_id = p_business_id
    ),
    'interactions', (
      select count(*) from public.interactions i where i.business_id = p_business_id
    ),
    'notes', (select count(*) from public.notes n where n.business_id = p_business_id),
    'tasks', (select count(*) from public.tasks t where t.business_id = p_business_id),
    'source_evidence', (
      select count(*) from public.source_evidence s where s.business_id = p_business_id
    ),
    'import_batches', (
      select count(*) from public.import_batches b where b.business_id = p_business_id
    ),
    'audit_events', (
      select count(*) from public.audit_events a where a.business_id = p_business_id
    ),
    'agent_runs', (select count(*) from public.agent_runs r where r.business_id = p_business_id),
    'research_snapshots', (
      select count(*) from public.research_snapshots r where r.business_id = p_business_id
    )
  );
$$;

comment on function public.business_protected_history(uuid) is
  'Every history record a permanent business delete would destroy. A non-zero count means the delete must be refused.';
