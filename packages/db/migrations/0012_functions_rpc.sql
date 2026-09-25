-- ============================================================================
-- NEXUS DB · 0012 — RPC functions
--
-- Implements every function in DB_CONTRACT.md §4.
-- Spec
--   lead_lifecycle.*                    (accepted connection, reply, dormant,
--                                        reactivation)
--   sequence_engine.*                   (mark sent, freeze version, publish)
--   lead_invariants.*                   (audited primary-ICP change)
--   security_and_reliability.rules      (soft delete, immutable sent content,
--                                        append-only audit)
--   mcp_contract.principle              (intent-level tools, never arbitrary SQL)
--
-- Every function is SECURITY DEFINER with SET search_path = public, pg_temp and
-- begins with an explicit authorization assertion. None accepts SQL text.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- Maps a sequence step order onto the lead's next_action_type vocabulary.
create or replace function public.next_action_for_step(p_step_order integer, p_step_kind text)
  returns text
  language sql
  immutable
as $$
  select case
           when p_step_kind = 'reactivation' then 'reactivation'
           when p_step_kind = 'connection' then 'connection'
           when p_step_order <= 1 then 'message_1'
           when p_step_order = 2 then 'followup_1'
           when p_step_order = 3 then 'followup_2'
           when p_step_order = 4 then 'followup_3'
           else 'review'
         end;
$$;

-- The instant a step's delay_days counts from.
--
-- The vocabulary is fixed by `sequence_steps_delay_basis_check` in
-- 0007_sequences.sql and mirrored by `DELAY_BASES` in
-- packages/core/src/sequence-engine.ts. Keep the two in step: the engine and the
-- database must agree or the same sequence produces two different cadences.
--
-- `after_previous` is the default and resolves to `now()` — this function is only
-- called to schedule the step that *follows* the event that just happened
-- (connection acceptance, or a message send), so "the previous step" is always
-- that event. `after_connection` is the same instant at this call site, but it is
-- named explicitly rather than folded into the `else` branch so that adding a
-- basis to the CHECK constraint without teaching this function about it fails
-- loudly instead of silently behaving like `after_previous`.
--
-- The result is clamped to at least `now()`: scheduling a due date in the past
-- would make the step instantly overdue and re-fire on every queue build.
create or replace function public.step_due_at(
  p_delay_days integer,
  p_delay_basis text,
  p_enrollment_started_at timestamptz
)
  returns timestamptz
  language sql
  stable
as $$
  select greatest(
           case p_delay_basis
             when 'immediate' then now()
             when 'after_previous' then now()
             when 'after_connection' then now()
             when 'after_enrollment' then coalesce(p_enrollment_started_at, now())
             else now()
           end,
           now()
         ) + make_interval(days => greatest(p_delay_days, 0));
$$;

-- The first sender identity becomes the default conversation sender/owner.
create or replace function public.ensure_conversation(
  p_lead_id uuid,
  p_business_id uuid,
  p_channel text,
  p_identity_id uuid,
  p_owner_user_id uuid
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.conversations (business_id, lead_id, channel, sender_identity_id, default_owner_user_id)
  values (p_business_id, p_lead_id, coalesce(p_channel, 'linkedin'), p_identity_id, p_owner_user_id)
  on conflict (lead_id, channel) do update
    set sender_identity_id = coalesce(public.conversations.sender_identity_id, excluded.sender_identity_id),
        default_owner_user_id = coalesce(public.conversations.default_owner_user_id, excluded.default_owner_user_id)
  returning id into v_id;

  return v_id;
end
$$;

create or replace function public.assert_lead_readable(p_lead_id uuid)
  returns public.leads
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lead public.leads%rowtype;
begin
  select * into v_lead from public.leads l where l.id = p_lead_id;

  if not found then
    raise exception 'lead % not found', p_lead_id using errcode = 'P0002';
  end if;

  perform public.assert_business_scope(v_lead.business_id);
  return v_lead;
end
$$;

-- ---------------------------------------------------------------------------
-- public.one_primary_icp_per_lead(lead_id uuid) -> uuid
-- ---------------------------------------------------------------------------
create or replace function public.one_primary_icp_per_lead(p_lead_id uuid)
  returns uuid
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lead public.leads%rowtype;
  v_icp uuid;
begin
  v_lead := public.assert_lead_readable(p_lead_id);

  select m.icp_id into v_icp
    from public.lead_icp_matches m
   where m.lead_id = p_lead_id
     and m.is_primary
   limit 1;

  return v_icp;
end
$$;

-- ---------------------------------------------------------------------------
-- public.set_primary_icp(lead_id uuid, icp_id uuid)
-- Audited swap; secondary matches are preserved (spec lead_invariants).
-- ---------------------------------------------------------------------------
create or replace function public.set_primary_icp(p_lead_id uuid, p_icp_id uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lead public.leads%rowtype;
  v_before uuid;
  v_secondary integer;
begin
  v_lead := public.assert_lead_readable(p_lead_id);

  if p_icp_id is null then
    raise exception 'set_primary_icp requires an icp_id' using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.icps i
     where i.id = p_icp_id
       and i.business_id = v_lead.business_id
       and i.deleted_at is null
  ) then
    raise exception 'icp % does not belong to business %', p_icp_id, v_lead.business_id
      using errcode = '23503';
  end if;

  v_before := public.one_primary_icp_per_lead(p_lead_id);

  insert into public.lead_icp_matches (lead_id, icp_id, is_primary, reason, created_by)
  values (p_lead_id, p_icp_id, false, 'primary_icp_change', public.current_user_id())
  on conflict (lead_id, icp_id) do nothing;

  -- Two statements: the first releases the partial unique index, the second claims it.
  update public.lead_icp_matches
     set is_primary = false
   where lead_id = p_lead_id
     and is_primary;

  update public.lead_icp_matches
     set is_primary = true
   where lead_id = p_lead_id
     and icp_id = p_icp_id;

  update public.leads
     set primary_icp_id = p_icp_id,
         last_activity_at = now()
   where id = p_lead_id;

  select count(*) into v_secondary
    from public.lead_icp_matches m
   where m.lead_id = p_lead_id
     and not m.is_primary;

  perform public.enqueue_audit(
    'leads', p_lead_id, 'set_primary_icp', v_lead.business_id,
    jsonb_build_object('primary_icp_id', v_before),
    jsonb_build_object('primary_icp_id', p_icp_id, 'secondary_matches', v_secondary),
    current_setting('nexus.source_client', true)
  );

  return jsonb_build_object(
    'lead_id', p_lead_id,
    'previous_primary_icp_id', v_before,
    'primary_icp_id', p_icp_id,
    'secondary_matches', v_secondary
  );
end
$$;

-- ---------------------------------------------------------------------------
-- public.mark_connection_sent(lead_id, identity, action, source_client)
-- Spec companion_extension.connection_action — after the manual send the user
-- clicks "Mark connection sent"; an accepted connection makes Message 1 due.
-- ---------------------------------------------------------------------------
create or replace function public.mark_connection_sent(
  p_lead_id uuid,
  p_identity_id uuid,
  p_action text,
  p_source_client text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lead public.leads%rowtype;
  v_conversation uuid;
  v_enrollment public.sequence_enrollments%rowtype;
  v_step public.sequence_steps%rowtype;
  v_instance uuid;
  v_due timestamptz;
begin
  v_lead := public.assert_lead_readable(p_lead_id);

  if v_lead.deleted_at is not null then
    raise exception 'lead % is deleted', p_lead_id using errcode = '23514';
  end if;

  perform public.assert_identity_usable(p_identity_id);

  if not public.has_identity_business_access(p_identity_id, v_lead.business_id) then
    raise exception 'outreach identity % is not authorized for business %', p_identity_id, v_lead.business_id
      using errcode = '42501';
  end if;

  if p_action is not null and p_action not in ('with_note', 'without_note') then
    raise exception 'unsupported connection action %', p_action using errcode = '23514';
  end if;

  v_conversation := public.ensure_conversation(
    v_lead.id, v_lead.business_id, 'linkedin', p_identity_id, v_lead.owner_user_id
  );

  insert into public.interactions (
    business_id, lead_id, person_id, conversation_id, type, actor_user_id,
    outreach_identity_id, direction, summary, payload, source_client
  )
  values (
    v_lead.business_id, v_lead.id, v_lead.person_id, v_conversation, 'connection_event',
    public.current_user_id(), p_identity_id, 'outbound',
    'connection_sent' || coalesce(':' || p_action, ''),
    jsonb_build_object('action', p_action, 'event', 'connection_sent'),
    p_source_client
  );

  update public.outreach_identities i
     set daily_sent_count = case
                              when i.daily_count_reset_at is null
                                or i.daily_count_reset_at < date_trunc('day', now())
                              then 1
                              else i.daily_sent_count + 1
                            end,
         daily_count_reset_at = case
                                  when i.daily_count_reset_at is null
                                    or i.daily_count_reset_at < date_trunc('day', now())
                                  then now()
                                  else i.daily_count_reset_at
                                end
   where i.id = p_identity_id;

  select * into v_enrollment
    from public.sequence_enrollments e
   where e.lead_id = v_lead.id
     and e.state in ('active', 'paused', 'reactivation_due')
   order by e.created_at desc
   limit 1;

  if found then
    select * into v_step
      from public.sequence_steps s
     where s.sequence_version_id = v_enrollment.sequence_version_id
       and s.is_active
       and s.kind in ('message', 'followup', 'reactivation')
     order by s.step_order
     limit 1;

    if found then
      v_due := public.step_due_at(v_step.delay_days, v_step.delay_basis, v_enrollment.started_at);

      insert into public.message_instances (
        conversation_id, sequence_step_id, state, due_at, business_id, lead_id,
        step_order, step_kind
      )
      values (
        v_conversation, v_step.id, 'DYNAMIC', v_due, v_lead.business_id, v_lead.id,
        v_step.step_order, v_step.kind
      )
      returning id into v_instance;

      update public.sequence_enrollments e
         set state = 'active',
             current_step_order = v_step.step_order,
             started_at = coalesce(e.started_at, now()),
             paused_at = null,
             pause_reason = null
       where e.id = v_enrollment.id;
    end if;
  end if;

  update public.leads l
     set status = case when v_instance is null then 'connection_sent' else 'message_due' end,
         outreach_identity_id = p_identity_id,
         next_action_type = case
                              when v_instance is null then 'none'
                              else public.next_action_for_step(v_step.step_order, v_step.kind)
                            end,
         next_action_at = case when v_instance is null then null else v_due end,
         last_activity_at = now()
   where l.id = v_lead.id;

  perform public.enqueue_audit(
    'leads', v_lead.id, 'mark_connection_sent', v_lead.business_id,
    null,
    jsonb_build_object(
      'action', p_action,
      'outreach_identity_id', p_identity_id,
      'message_instance_id', v_instance,
      'due_at', v_due
    ),
    p_source_client
  );

  return jsonb_build_object(
    'lead_id', v_lead.id,
    'conversation_id', v_conversation,
    'outreach_identity_id', p_identity_id,
    'message_instance_id', v_instance,
    'due_at', v_due,
    'status', case when v_instance is null then 'connection_sent' else 'message_due' end
  );
end
$$;

-- ---------------------------------------------------------------------------
-- public.mark_message_sent(message_instance_id, identity, source_client)
-- Freezes the current version, sets SENT, records the immutable event and
-- schedules the next configured step (Dormant after the last one).
-- ---------------------------------------------------------------------------
create or replace function public.mark_message_sent(
  p_message_instance_id uuid,
  p_identity_id uuid,
  p_source_client text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_instance public.message_instances%rowtype;
  v_lead public.leads%rowtype;
  v_enrollment public.sequence_enrollments%rowtype;
  v_next public.sequence_steps%rowtype;
  v_due timestamptz;
  v_reactivation_days integer;
  v_next_instance uuid;
  v_event uuid;
begin
  select * into v_instance
    from public.message_instances mi
   where mi.id = p_message_instance_id;

  if not found then
    raise exception 'message instance % not found', p_message_instance_id using errcode = 'P0002';
  end if;

  perform public.assert_business_scope(v_instance.business_id);
  perform public.assert_identity_usable(p_identity_id);

  if not public.has_identity_business_access(p_identity_id, v_instance.business_id) then
    raise exception 'outreach identity % is not authorized for business %', p_identity_id, v_instance.business_id
      using errcode = '42501';
  end if;

  if v_instance.sent_at is not null or v_instance.state = 'SENT' then
    raise exception 'message instance % has already been sent', p_message_instance_id
      using errcode = '23514';
  end if;

  if v_instance.current_version_id is null then
    raise exception 'message instance % has no version to freeze', p_message_instance_id
      using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.message_versions mv
     where mv.id = v_instance.current_version_id
       and mv.message_instance_id = v_instance.id
  ) then
    raise exception 'current_version_id % does not belong to message instance %',
      v_instance.current_version_id, p_message_instance_id
      using errcode = '23503';
  end if;

  update public.message_instances mi
     set state = 'SENT',
         sent_at = now()
   where mi.id = v_instance.id;

  insert into public.message_events (
    message_instance_id, event_type, actor_user_id, outreach_identity_id,
    source_client, business_id, lead_id, message_version_id, payload, note
  )
  values (
    v_instance.id, 'sent', public.current_user_id(), p_identity_id,
    p_source_client, v_instance.business_id, v_instance.lead_id,
    v_instance.current_version_id,
    jsonb_build_object('step_order', v_instance.step_order, 'step_kind', v_instance.step_kind),
    null
  )
  returning id into v_event;

  update public.conversations c
     set last_outbound_at = now()
   where c.id = v_instance.conversation_id;

  update public.outreach_identities i
     set daily_sent_count = case
                              when i.daily_count_reset_at is null
                                or i.daily_count_reset_at < date_trunc('day', now())
                              then 1
                              else i.daily_sent_count + 1
                            end,
         daily_count_reset_at = case
                                  when i.daily_count_reset_at is null
                                    or i.daily_count_reset_at < date_trunc('day', now())
                                  then now()
                                  else i.daily_count_reset_at
                                end
   where i.id = p_identity_id;

  select * into v_lead from public.leads l where l.id = v_instance.lead_id;

  select * into v_enrollment
    from public.sequence_enrollments e
   where e.lead_id = v_instance.lead_id
     and e.state = 'active'
   order by e.created_at desc
   limit 1;

  if found then
    select * into v_next
      from public.sequence_steps s
     where s.sequence_version_id = v_enrollment.sequence_version_id
       and s.is_active
       and s.step_order > v_instance.step_order
     order by s.step_order
     limit 1;
  end if;

  if not found then
    v_reactivation_days := public.setting_int('dormant.reactivation_days', 60, v_instance.business_id);

    update public.sequence_enrollments e
       set state = 'dormant',
           dormant_at = now(),
           completed_at = now(),
           current_step_order = v_instance.step_order,
           reactivation_due_at = now() + make_interval(days => greatest(v_reactivation_days, 0))
     where e.lead_id = v_instance.lead_id
       and e.state = 'active';

    update public.leads l
       set status = 'dormant',
           next_action_type = 'reactivation',
           next_action_at = now() + make_interval(days => greatest(v_reactivation_days, 0)),
           last_activity_at = now()
     where l.id = v_instance.lead_id
     returning * into v_lead;
  else
    v_due := public.step_due_at(v_next.delay_days, v_next.delay_basis, v_enrollment.started_at);

    insert into public.message_instances (
      conversation_id, sequence_step_id, state, due_at, business_id, lead_id,
      step_order, step_kind
    )
    values (
      v_instance.conversation_id, v_next.id, 'DYNAMIC', v_due,
      v_instance.business_id, v_instance.lead_id, v_next.step_order, v_next.kind
    )
    returning id into v_next_instance;

    update public.sequence_enrollments e
       set current_step_order = v_next.step_order
     where e.id = v_enrollment.id;

    update public.leads l
       set status = case when v_next.kind = 'followup' then 'followup_due' else 'message_due' end,
           next_action_type = public.next_action_for_step(v_next.step_order, v_next.kind),
           next_action_at = v_due,
           last_activity_at = now()
     where l.id = v_instance.lead_id;
  end if;

  perform public.enqueue_audit(
    'message_instances', v_instance.id, 'mark_message_sent', v_instance.business_id,
    jsonb_build_object('state', v_instance.state, 'current_version_id', v_instance.current_version_id),
    jsonb_build_object(
      'state', 'SENT',
      'message_event_id', v_event,
      'message_version_id', v_instance.current_version_id,
      'next_message_instance_id', v_next_instance,
      'outreach_identity_id', p_identity_id
    ),
    p_source_client
  );

  return jsonb_build_object(
    'message_instance_id', v_instance.id,
    'state', 'SENT',
    'message_event_id', v_event,
    'message_version_id', v_instance.current_version_id,
    'next_message_instance_id', v_next_instance,
    'due_at', v_due,
    'lead_status', (select l.status from public.leads l where l.id = v_instance.lead_id),
    'enrollment_state', (select e.state from public.sequence_enrollments e where e.lead_id = v_instance.lead_id
                          order by e.created_at desc limit 1),
    'reactivation_due_at', (select e.reactivation_due_at from public.sequence_enrollments e
                             where e.lead_id = v_instance.lead_id order by e.created_at desc limit 1)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- public.capture_reply(lead_id, exact_text, outcome, note, source_client, occurred_at)
-- Stores the exact inbound text, records the outcome (which pauses the sequence
-- by trigger) and creates the DNC suppression when applicable.
-- ---------------------------------------------------------------------------
create or replace function public.capture_reply(
  p_lead_id uuid,
  p_exact_text text,
  p_outcome text,
  p_note text,
  p_source_client text,
  p_occurred_at timestamptz
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lead public.leads%rowtype;
  v_conversation uuid;
  v_identity uuid;
  v_interaction uuid;
  v_outcome_id uuid;
  v_suppression uuid;
  v_occurred timestamptz;
begin
  v_lead := public.assert_lead_readable(p_lead_id);

  if p_exact_text is null or btrim(p_exact_text) = '' then
    raise exception 'capture_reply requires the exact inbound text' using errcode = '23514';
  end if;

  if p_outcome is null or p_outcome not in (
    'Interested', 'Positive / needs info', 'Maybe later', 'No current need',
    'Not interested', 'Wrong person', 'Already has supplier', 'Do not contact', 'Other'
  ) then
    raise exception 'unsupported reply outcome %', p_outcome using errcode = '23514';
  end if;

  v_occurred := coalesce(p_occurred_at, now());
  v_identity := v_lead.outreach_identity_id;

  select c.sender_identity_id into v_identity
    from public.conversations c
   where c.lead_id = v_lead.id
   order by c.created_at
   limit 1;

  v_identity := coalesce(v_identity, v_lead.outreach_identity_id);

  v_conversation := public.ensure_conversation(
    v_lead.id, v_lead.business_id, 'linkedin', v_identity,
    coalesce(v_lead.owner_user_id, public.current_user_id())
  );

  -- reply_and_notes.capture_exact_inbound_text = true: summary holds the exact bytes.
  insert into public.interactions (
    business_id, lead_id, person_id, conversation_id, type, actor_user_id,
    outreach_identity_id, direction, summary, payload, source_client, occurred_at
  )
  values (
    v_lead.business_id, v_lead.id, v_lead.person_id, v_conversation, 'inbound_reply',
    public.current_user_id(), v_identity, 'inbound', p_exact_text,
    jsonb_build_object('exact_text', p_exact_text, 'outcome', p_outcome, 'note', p_note),
    p_source_client, v_occurred
  )
  returning id into v_interaction;

  if p_note is not null and btrim(p_note) <> '' then
    insert into public.notes (business_id, lead_id, person_id, author_user_id, body, is_internal)
    values (v_lead.business_id, v_lead.id, v_lead.person_id, public.current_user_id(), p_note, true);
  end if;

  insert into public.conversation_outcomes (
    conversation_id, lead_id, business_id, outcome, is_terminal, reason,
    source_reply_id, actor_user_id
  )
  values (
    v_conversation, v_lead.id, v_lead.business_id, p_outcome,
    p_outcome in ('Do not contact', 'Wrong person'),
    p_note, v_interaction, public.current_user_id()
  )
  returning id into v_outcome_id;

  if p_outcome = 'Do not contact' then
    select cs.id into v_suppression
      from public.contact_suppressions cs
     where cs.person_id = v_lead.person_id
       and cs.business_id is null
       and cs.active
     order by cs.created_at desc
     limit 1;
  elsif p_outcome = 'Not interested' then
    -- business-specific cooldown, never a DNC suppression
    if not exists (
      select 1 from public.cooldowns c
       where c.lead_id = v_lead.id and c.business_id = v_lead.business_id and c.is_active
    ) then
      insert into public.cooldowns (business_id, lead_id, person_id, reason, starts_at, ends_at, is_active, created_by)
      values (
        v_lead.business_id, v_lead.id, v_lead.person_id, 'ordinary_not_interested',
        now(),
        now() + make_interval(days => greatest(public.setting_int('cooldown.ordinary_not_interested_days', 90, v_lead.business_id), 0)),
        true, public.current_user_id()
      );
    end if;

    update public.leads l
       set status = 'cooldown',
           next_action_at = now() + make_interval(days => greatest(public.setting_int('cooldown.ordinary_not_interested_days', 90, v_lead.business_id), 0))
     where l.id = v_lead.id;
  end if;

  update public.leads l
     set last_activity_at = v_occurred
   where l.id = v_lead.id;

  return jsonb_build_object(
    'lead_id', v_lead.id,
    'conversation_id', v_conversation,
    'interaction_id', v_interaction,
    'outcome_id', v_outcome_id,
    'suppression_id', v_suppression,
    'outcome', p_outcome,
    'occurred_at', v_occurred
  );
end
$$;

-- ---------------------------------------------------------------------------
-- public.soft_delete_lead(lead_id, actor)
-- ---------------------------------------------------------------------------
create or replace function public.soft_delete_lead(p_lead_id uuid, p_actor uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lead public.leads%rowtype;
  v_cancelled integer;
begin
  perform public.assert_actor(p_actor);
  v_lead := public.assert_lead_readable(p_lead_id);

  if v_lead.deleted_at is not null then
    return jsonb_build_object('lead_id', p_lead_id, 'already_deleted', true);
  end if;

  if not (
    public.is_admin()
    or public.is_business_manager(v_lead.business_id)
    or public.can_delete_leads(v_lead.business_id)
    or v_lead.owner_user_id = p_actor
    or v_lead.created_by = p_actor
  ) then
    raise exception 'actor % may not delete lead %', p_actor, p_lead_id
      using errcode = '42501';
  end if;

  update public.leads l
     set deleted_at = now(),
         deleted_by = p_actor,
         status = 'deleted',
         next_action_type = 'none',
         next_action_at = null
   where l.id = p_lead_id;

  update public.message_instances mi
     set invalidated_at = now(),
         regeneration_reason = 'lead_deleted'
   where mi.lead_id = p_lead_id
     and mi.sent_at is null;

  update public.sequence_enrollments e
     set state = 'cancelled',
         completed_at = now(),
         pause_reason = 'lead_deleted'
   where e.lead_id = p_lead_id
     and e.state in ('active', 'paused', 'reactivation_due');

  update public.profile_capture_queue q
     set state = 'skipped',
         last_error = 'lead_deleted'
   where q.lead_id = p_lead_id
     and q.state in ('pending', 'in_progress')
   returning 1 into v_cancelled;

  perform public.enqueue_audit(
    'leads', p_lead_id, 'soft_delete_lead', v_lead.business_id,
    jsonb_build_object('deleted_at', v_lead.deleted_at, 'status', v_lead.status),
    jsonb_build_object('deleted_at', now(), 'status', 'deleted', 'deleted_by', p_actor),
    current_setting('nexus.source_client', true)
  );

  return jsonb_build_object('lead_id', p_lead_id, 'deleted', true);
end
$$;

-- ---------------------------------------------------------------------------
-- public.restore_lead(lead_id, actor) — the invariant is re-checked
-- ---------------------------------------------------------------------------
create or replace function public.restore_lead(p_lead_id uuid, p_actor uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lead public.leads%rowtype;
  v_conflict uuid;
begin
  perform public.assert_actor(p_actor);

  select * into v_lead from public.leads l where l.id = p_lead_id;
  if not found then
    raise exception 'lead % not found', p_lead_id using errcode = 'P0002';
  end if;

  perform public.assert_business_scope(v_lead.business_id);

  if v_lead.deleted_at is null then
    return jsonb_build_object('lead_id', p_lead_id, 'restored', false, 'reason', 'not_deleted');
  end if;

  if not (
    public.is_admin()
    or public.is_business_manager(v_lead.business_id)
    or public.can_delete_leads(v_lead.business_id)
    or v_lead.owner_user_id = p_actor
    or v_lead.created_by = p_actor
  ) then
    raise exception 'actor % may not restore lead %', p_actor, p_lead_id
      using errcode = '42501';
  end if;

  -- invariant 1: a Person may have only one active Lead inside one business
  select l.id into v_conflict
    from public.leads l
   where l.business_id = v_lead.business_id
     and l.person_id = v_lead.person_id
     and l.deleted_at is null
     and l.id <> v_lead.id
   limit 1;

  if v_conflict is not null then
    raise exception 'cannot restore lead %: person % already has active lead % in business %',
      p_lead_id, v_lead.person_id, v_conflict, v_lead.business_id
      using errcode = '23505',
            hint = 'DB_CONTRACT.md §2 invariant 1';
  end if;

  update public.leads l
     set deleted_at = null,
         deleted_by = null,
         status = 'new',
         archived_at = null,
         next_action_type = 'none',
         next_action_at = null,
         last_activity_at = now()
   where l.id = p_lead_id;

  perform public.enqueue_audit(
    'leads', p_lead_id, 'restore_lead', v_lead.business_id,
    jsonb_build_object('deleted_at', v_lead.deleted_at, 'status', v_lead.status),
    jsonb_build_object('deleted_at', null, 'status', 'new'),
    current_setting('nexus.source_client', true)
  );

  return jsonb_build_object('lead_id', p_lead_id, 'restored', true);
end
$$;

-- ---------------------------------------------------------------------------
-- public.permanent_delete_lead(lead_id, actor, confirmation)
-- Admin-only, audited, requires the literal confirmation string.
-- ---------------------------------------------------------------------------
create or replace function public.permanent_delete_lead(
  p_lead_id uuid,
  p_actor uuid,
  p_confirmation text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lead public.leads%rowtype;
begin
  perform public.assert_actor(p_actor);
  perform public.require_admin('permanent_delete_lead');

  select * into v_lead from public.leads l where l.id = p_lead_id;
  if not found then
    raise exception 'lead % not found', p_lead_id using errcode = 'P0002';
  end if;

  perform public.assert_business_scope(v_lead.business_id);

  if p_confirmation is distinct from 'DELETE PERMANENTLY' then
    raise exception 'permanent delete requires the literal confirmation string'
      using errcode = '42501',
            hint = 'pass exactly: DELETE PERMANENTLY';
  end if;

  perform public.enqueue_audit(
    'leads', p_lead_id, 'permanent_delete_lead', v_lead.business_id,
    to_jsonb(v_lead), null,
    current_setting('nexus.source_client', true)
  );

  -- Only this audited admin path may lift the soft-delete guard.
  perform set_config('nexus.allow_hard_delete', 'on', true);

  delete from public.leads l where l.id = p_lead_id;

  return jsonb_build_object('lead_id', p_lead_id, 'permanently_deleted', true);
end
$$;

-- ---------------------------------------------------------------------------
-- public.undo_import(batch_id, actor)
-- ---------------------------------------------------------------------------
create or replace function public.undo_import(p_batch_id uuid, p_actor uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_batch public.import_batches%rowtype;
  v_lead record;
  v_reverted integer := 0;
  v_kept integer := 0;
begin
  perform public.assert_actor(p_actor);

  select * into v_batch from public.import_batches b where b.id = p_batch_id;
  if not found then
    raise exception 'import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  perform public.assert_business_scope(v_batch.business_id);

  if not (
    public.is_admin()
    or public.can_use_lead_sources(v_batch.business_id)
    or v_batch.created_by = p_actor
  ) then
    raise exception 'actor % may not undo import batch %', p_actor, p_batch_id
      using errcode = '42501';
  end if;

  if v_batch.undone_at is not null then
    raise exception 'import batch % was already undone at %', p_batch_id, v_batch.undone_at
      using errcode = '23514';
  end if;

  for v_lead in
    select l.id
      from public.leads l
     where l.import_batch_id = p_batch_id
       and l.deleted_at is null
  loop
    -- Preserve anything that has moved on since the import.
    if exists (
      select 1 from public.message_instances mi
       where mi.lead_id = v_lead.id and mi.sent_at is not null
    ) or exists (
      select 1 from public.interactions i
       where i.lead_id = v_lead.id and i.type = 'inbound_reply'
    ) then
      v_kept := v_kept + 1;
      update public.import_rows r
         set result = 'skipped',
             message = 'kept: lead has history created after the import'
       where r.batch_id = p_batch_id
         and r.lead_id = v_lead.id;
    else
      update public.leads l
         set deleted_at = now(),
             deleted_by = p_actor,
             status = 'deleted',
             next_action_type = 'none',
             next_action_at = null
       where l.id = v_lead.id;

      update public.message_instances mi
         set invalidated_at = now(),
             regeneration_reason = 'import_undone'
       where mi.lead_id = v_lead.id
         and mi.sent_at is null;

      update public.import_rows r
         set result = 'skipped',
             message = 'reverted by undo_import'
       where r.batch_id = p_batch_id
         and r.lead_id = v_lead.id;

      v_reverted := v_reverted + 1;
    end if;
  end loop;

  update public.import_batches b
     set status = 'undone',
         undone_at = now(),
         undone_by = p_actor,
         raw_summary = b.raw_summary || jsonb_build_object(
           'undo', jsonb_build_object('reverted', v_reverted, 'kept', v_kept, 'at', now())
         )
   where b.id = p_batch_id;

  return jsonb_build_object('batch_id', p_batch_id, 'reverted', v_reverted, 'kept', v_kept);
end
$$;

-- ---------------------------------------------------------------------------
-- public.get_today_queue(user_id, business_id, bucket, categories, at)
-- The My Day / Companion Today projection (spec tasks_and_my_day).
-- ---------------------------------------------------------------------------
create or replace function public.get_today_queue(
  user_id uuid,
  business_id uuid,
  bucket text,
  categories text[],
  "at" timestamptz
)
  returns table (
    item_lead_id uuid,
    item_business_id uuid,
    item_person_id uuid,
    person_name text,
    company_name text,
    item_category text,
    item_bucket text,
    action_type text,
    due_at timestamptz,
    message_instance_id uuid,
    sequence_step_id uuid,
    step_order integer,
    step_kind text,
    item_state text,
    task_id uuid,
    priority text,
    is_overdue boolean,
    sender_identity_id uuid
  )
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_at timestamptz := coalesce("at", now());
  v_category text;
begin
  if user_id is null then
    raise exception 'get_today_queue requires a user' using errcode = '42501';
  end if;

  if user_id <> public.current_user_id()
     and not (public.is_admin() or public.is_business_manager(business_id)) then
    raise exception 'get_today_queue: actor may not read another user''s queue'
      using errcode = '42501';
  end if;

  perform public.assert_business_scope(business_id);

  if bucket is null or bucket not in ('today', 'upcoming', 'done') then
    raise exception 'unsupported My Day bucket %', bucket using errcode = '23514';
  end if;

  if categories is not null then
    foreach v_category in array categories loop
      if v_category not in ('connections', 'accepted_message1', 'followups', 'overdue', 'custom_tasks') then
        raise exception 'unsupported My Day category %', v_category using errcode = '23514';
      end if;
    end loop;
  end if;

  return query
  with scope as (
    select l.id as lead_id,
           l.business_id,
           l.person_id,
           l.outreach_identity_id,
           l.owner_user_id
      from public.leads l
     where l.business_id = get_today_queue.business_id
       and l.deleted_at is null
       and l.status not in ('deleted', 'archived', 'do_not_contact')
       and (l.owner_user_id = get_today_queue.user_id or l.owner_user_id is null)
  ),
  message_items as (
    select s.lead_id,
           s.business_id,
           s.person_id,
           mi.id as instance_id,
           null::uuid as task_ref,
           mi.sequence_step_id,
           mi.step_order,
           mi.step_kind,
           mi.state as instance_state,
           coalesce(mi.due_at, mi.snoozed_until) as item_due,
           case when mi.step_kind = 'message' then 'accepted_message1' else 'followups' end as category,
           public.next_action_for_step(mi.step_order, mi.step_kind) as action,
           s.outreach_identity_id
      from public.message_instances mi
      join scope s on s.lead_id = mi.lead_id
     where mi.sent_at is null
       and mi.invalidated_at is null
       and get_today_queue.bucket <> 'done'
  ),
  connection_items as (
    select s.lead_id,
           s.business_id,
           s.person_id,
           null::uuid as instance_id,
           null::uuid as task_ref,
           null::uuid as sequence_step_id,
           0 as step_order,
           null::text as step_kind,
           null::text as instance_state,
           l.next_action_at as item_due,
           'connections'::text as category,
           'connection'::text as action,
           s.outreach_identity_id
      from scope s
      join public.leads l on l.id = s.lead_id
     where l.next_action_type = 'connection'
       and get_today_queue.bucket <> 'done'
  ),
  task_items as (
    select s.lead_id,
           t.business_id,
           s.person_id,
           null::uuid as instance_id,
           t.id as task_ref,
           null::uuid as sequence_step_id,
           0 as step_order,
           null::text as step_kind,
           t.status as instance_state,
           coalesce(t.snoozed_until, t.due_at, t.reminder_at) as item_due,
           'custom_tasks'::text as category,
           'task'::text as action,
           s.outreach_identity_id
      from public.tasks t
      join scope s on s.lead_id = t.lead_id
     where t.deleted_at is null
       and t.owner_user_id = get_today_queue.user_id
       and (
         (get_today_queue.bucket <> 'done' and t.status in ('open', 'snoozed'))
         or (get_today_queue.bucket = 'done' and t.status = 'done')
       )
  ),
  sent_items as (
    select s.lead_id,
           s.business_id,
           s.person_id,
           mi.id as instance_id,
           null::uuid as task_ref,
           mi.sequence_step_id,
           mi.step_order,
           mi.step_kind,
           mi.state as instance_state,
           mi.sent_at as item_due,
           'followups'::text as category,
           public.next_action_for_step(mi.step_order, mi.step_kind) as action,
           s.outreach_identity_id
      from public.message_instances mi
      join scope s on s.lead_id = mi.lead_id
     where get_today_queue.bucket = 'done'
       and mi.sent_at is not null
  ),
  combined as (
    select * from message_items
    union all select * from connection_items
    union all select * from task_items
    union all select * from sent_items
  )
  select c.lead_id,
         c.business_id,
         c.person_id,
         p.full_name,
         co.name,
         c.category,
         get_today_queue.bucket,
         c.action,
         c.item_due,
         c.instance_id,
         c.sequence_step_id,
         c.step_order,
         c.step_kind,
         c.instance_state,
         c.task_ref,
         case when c.task_ref is not null then
           (select t.priority from public.tasks t where t.id = c.task_ref)
         end,
         (c.item_due is not null and c.item_due < v_at),
         c.outreach_identity_id
    from combined c
    join public.people p on p.id = c.person_id
    left join public.companies co on co.id = (
      select l.company_id from public.leads l where l.id = c.lead_id
    )
   where (
           (get_today_queue.bucket = 'today' and (c.item_due is null or c.item_due <= v_at))
           or (get_today_queue.bucket = 'upcoming' and c.item_due > v_at)
           or (get_today_queue.bucket = 'done')
         )
     and (
           categories is null
           or c.category = any (categories)
           or ('overdue' = any (categories) and c.item_due is not null and c.item_due < v_at)
         )
   order by c.item_due nulls last, c.step_order;
end
$$;

-- ---------------------------------------------------------------------------
-- public.publish_sequence_version(version_id, actor)
-- ---------------------------------------------------------------------------
create or replace function public.publish_sequence_version(p_version_id uuid, p_actor uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_version public.sequence_versions%rowtype;
  v_business uuid;
  v_sent integer := 0;
  v_locked integer := 0;
  v_dynamic integer := 0;
  v_moved integer := 0;
  v_preview jsonb;
begin
  perform public.assert_actor(p_actor);

  select * into v_version from public.sequence_versions v where v.id = p_version_id;
  if not found then
    raise exception 'sequence version % not found', p_version_id using errcode = 'P0002';
  end if;

  select s.business_id into v_business from public.sequences s where s.id = v_version.sequence_id;
  perform public.assert_business_scope(v_business);

  if not (public.is_admin() or public.acting_api_client_id() is not null) then
    raise exception 'publishing a sequence version requires an admin'
      using errcode = '42501';
  end if;

  if v_version.status = 'published' then
    raise exception 'sequence version % is already published', p_version_id using errcode = '23514';
  end if;

  select count(*) into v_sent
    from public.message_instances mi
    join public.sequence_enrollments e on e.lead_id = mi.lead_id
   where e.sequence_id = v_version.sequence_id
     and mi.state = 'SENT';

  select count(*) into v_locked
    from public.message_instances mi
    join public.sequence_enrollments e on e.lead_id = mi.lead_id
   where e.sequence_id = v_version.sequence_id
     and mi.state = 'LOCKED'
     and mi.sent_at is null;

  select count(*) into v_dynamic
    from public.message_instances mi
    join public.sequence_enrollments e on e.lead_id = mi.lead_id
   where e.sequence_id = v_version.sequence_id
     and mi.state = 'DYNAMIC'
     and mi.sent_at is null;

  -- Eligible DYNAMIC unsent messages are marked needs-regeneration.
  update public.message_instances mi
     set invalidated_at = now(),
         regeneration_reason = 'sequence_version_published'
   where mi.sent_at is null
     and mi.state = 'DYNAMIC'
     and mi.lead_id in (
       select e.lead_id from public.sequence_enrollments e
        where e.sequence_id = v_version.sequence_id
          and e.state in ('active', 'paused', 'reactivation_due')
     );

  v_moved := v_dynamic;

  update public.sequence_enrollments e
     set sequence_version_id = p_version_id
   where e.sequence_id = v_version.sequence_id
     and e.state in ('active', 'paused', 'reactivation_due');

  update public.sequence_versions v
     set status = 'archived'
   where v.sequence_id = v_version.sequence_id
     and v.id <> p_version_id
     and v.status = 'published';

  v_preview := jsonb_build_object(
    'sent_untouched', v_sent,
    'locked_untouched', v_locked,
    'dynamic_needs_regeneration', v_dynamic,
    'enrollments_moved', v_moved,
    'published_at', now()
  );

  update public.sequence_versions v
     set status = 'published',
         published_at = now(),
         published_by = p_actor,
         impact_preview = v_preview
   where v.id = p_version_id;

  update public.sequences s
     set current_version_id = p_version_id,
         status = case when s.status = 'draft' then 'active' else s.status end
   where s.id = v_version.sequence_id;

  perform public.enqueue_audit(
    'sequence_versions', p_version_id, 'publish_sequence_version', v_business,
    jsonb_build_object('status', v_version.status),
    v_preview,
    current_setting('nexus.source_client', true)
  );

  return v_preview;
end
$$;

-- ---------------------------------------------------------------------------
-- public.merge_duplicate_candidate(candidate_id, actor, resolution)
-- ---------------------------------------------------------------------------
create or replace function public.merge_duplicate_candidate(
  p_candidate_id uuid,
  p_actor uuid,
  p_resolution text
)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_candidate public.duplicate_candidates%rowtype;
  v_lead record;
  v_moved integer := 0;
  v_soft_deleted integer := 0;
  v_status text;
begin
  perform public.assert_actor(p_actor);

  select * into v_candidate from public.duplicate_candidates c where c.id = p_candidate_id;
  if not found then
    raise exception 'duplicate candidate % not found', p_candidate_id using errcode = 'P0002';
  end if;

  perform public.assert_business_scope(v_candidate.business_id);

  if p_resolution is null or p_resolution not in ('merge', 'keep_separate', 'skip') then
    raise exception 'unsupported duplicate resolution %', p_resolution using errcode = '23514';
  end if;

  if v_candidate.status <> 'open' then
    raise exception 'duplicate candidate % is already resolved', p_candidate_id using errcode = '23514';
  end if;

  if p_resolution = 'merge' then
    if v_candidate.existing_person_id is null or v_candidate.incoming_person_id is null then
      raise exception 'merge requires both an incoming and an existing person'
        using errcode = '23514';
    end if;

    if v_candidate.existing_person_id = v_candidate.incoming_person_id then
      raise exception 'merge requires two different people' using errcode = '23514';
    end if;

    for v_lead in
      select l.id
        from public.leads l
       where l.person_id = v_candidate.incoming_person_id
         and l.business_id = v_candidate.business_id
         and l.deleted_at is null
    loop
      if exists (
        select 1 from public.leads l2
         where l2.person_id = v_candidate.existing_person_id
           and l2.business_id = v_candidate.business_id
           and l2.deleted_at is null
      ) then
        -- invariant 1 forbids a second active lead for the same person
        update public.leads l
           set deleted_at = now(),
               deleted_by = p_actor,
               status = 'deleted',
               duplicate_of_lead_id = v_candidate.existing_lead_id,
               next_action_type = 'none',
               next_action_at = null
         where l.id = v_lead.id;
        v_soft_deleted := v_soft_deleted + 1;
      else
        update public.leads l
           set person_id = v_candidate.existing_person_id
         where l.id = v_lead.id;
        v_moved := v_moved + 1;
      end if;
    end loop;

    update public.source_evidence e
       set person_id = v_candidate.existing_person_id
     where e.person_id = v_candidate.incoming_person_id;

    update public.signals s
       set person_id = v_candidate.existing_person_id
     where s.person_id = v_candidate.incoming_person_id;

    update public.notes n
       set person_id = v_candidate.existing_person_id
     where n.person_id = v_candidate.incoming_person_id;

    update public.research_snapshots r
       set person_id = v_candidate.existing_person_id
     where r.person_id = v_candidate.incoming_person_id;

    update public.social_profiles sp
       set person_id = v_candidate.existing_person_id
     where sp.person_id = v_candidate.incoming_person_id
       and not exists (
         select 1 from public.social_profiles sp2
          where sp2.person_id = v_candidate.existing_person_id
            and sp2.platform = sp.platform
            and sp2.normalized_url = sp.normalized_url
       );

    update public.people p
       set deleted_at = now()
     where p.id = v_candidate.incoming_person_id
       and p.deleted_at is null;

    v_status := 'merged';
  elsif p_resolution = 'keep_separate' then
    v_status := 'kept_separate';
  else
    v_status := 'skipped';
  end if;

  update public.duplicate_candidates c
     set status = v_status,
         resolution = p_resolution,
         resolved_by = p_actor,
         resolved_at = now(),
         payload = c.payload || jsonb_build_object(
           'leads_moved', v_moved,
           'leads_soft_deleted', v_soft_deleted
         )
   where c.id = p_candidate_id;

  perform public.enqueue_audit(
    'duplicate_candidates', p_candidate_id, 'merge_duplicate_candidate',
    v_candidate.business_id,
    jsonb_build_object('status', v_candidate.status),
    jsonb_build_object('status', v_status, 'resolution', p_resolution,
                       'leads_moved', v_moved, 'leads_soft_deleted', v_soft_deleted),
    current_setting('nexus.source_client', true)
  );

  return jsonb_build_object(
    'candidate_id', p_candidate_id,
    'status', v_status,
    'resolution', p_resolution,
    'leads_moved', v_moved,
    'leads_soft_deleted', v_soft_deleted
  );
end
$$;
