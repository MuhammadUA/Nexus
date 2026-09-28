-- ============================================================================
-- NEXUS DB - 0036 lead qualification and model-only agent work
--
-- Two additive pieces that close the last functional gap in the V1.2 AI
-- pipeline: the ICP qualification result needs a durable home, and the queue
-- needs a way to run jobs that need *only* the model.
--
-- 1. `lead_icp_matches` already records which ICP a lead matches and is primary
--    (invariant: one primary per lead, changed only through the audited
--    `set_primary_icp`). What it could not hold is the rest of the model's
--    qualification: the intent score it also returns, the recommended angle, why
--    a lead was disqualified, the confidence, and the provenance of the answer.
--    Those are added as columns rather than a new table, for two reasons: the
--    context pack already reads `match_score`/`reason` from this table, so
--    persisting here makes message drafting pick the new fit/intent up by
--    construction (the pack's input hash changes); and a second table would need
--    its own RLS, its own "one primary" reasoning and its own join in every read.
--
--    `intent_score` is deliberately nullable: an unqualified lead has no intent
--    score, and the context pack must be able to say "not assessed" rather than
--    print a zero the model never produced (V1.2 §23.3).
--
-- 2. `nexus_claim_ai_direct_work` claims jobs whose work is a model call and
--    nothing else — `QUALIFY_LEAD` and `BUILD_CONTEXT`. They are created `OPEN`
--    by the chaining planner, and the existing `nexus_claim_ai_work` only takes
--    `WAITING_AI` (jobs that an agent has staged evidence for). Without this
--    claim those two types sat `OPEN` for ever: an operator's BUILD_CONTEXT job
--    was never processed, and a QUALIFY_LEAD job was reported as
--    `no_processor_for_job_type`. The claim is the same atomic shape as the
--    existing one — `FOR UPDATE SKIP LOCKED` inside a single UPDATE, a lease, and
--    attempts counted against `max_attempts` — so two processors cannot take the
--    same job and a crashed processor's work returns to the queue.
--
--    Completion for these jobs goes through `nexus_complete_direct_agent_job`
--    (also here) rather than `nexus_complete_agent_job`, which requires
--    `WAITING_AI`. The completion rule's substance is unchanged and still
--    enforced: the job must be held by the claiming processor, and no
--    un-consumed `raw_staging` row may remain for it. For a model-only job the
--    caller has already persisted the structured result before it calls this.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- lead_icp_matches — the qualification result
-- ---------------------------------------------------------------------------
alter table public.lead_icp_matches
  add column if not exists intent_score integer,
  add column if not exists recommended_angle text,
  add column if not exists reasons text[] not null default '{}'::text[],
  add column if not exists disqualifiers text[] not null default '{}'::text[],
  add column if not exists confidence numeric(4, 3),
  add column if not exists ai_run_id uuid references public.ai_runs (id) on delete set null,
  add column if not exists qualified_at timestamptz,
  -- The qualification input hash the stored answer belongs to. Requalification is
  -- a new hash, so "did the facts change" is answerable without recomputing the
  -- model call, and the same facts never buy a second one.
  add column if not exists input_hash text;

comment on column public.lead_icp_matches.intent_score is
  'V1.2 ICP_QUALIFICATION intent score (0-100). NULL means not assessed; never defaulted to 0.';
comment on column public.lead_icp_matches.input_hash is
  'The normalised qualification input hash this answer belongs to — changed facts produce a new hash and a new answer.';
comment on column public.lead_icp_matches.ai_run_id is
  'The ai_runs row that produced this qualification, for token/cost attribution.';

alter table public.lead_icp_matches
  drop constraint if exists lead_icp_matches_intent_score_check;
alter table public.lead_icp_matches
  add constraint lead_icp_matches_intent_score_check
  check (intent_score is null or (intent_score >= 0 and intent_score <= 100));

alter table public.lead_icp_matches
  drop constraint if exists lead_icp_matches_confidence_check;
alter table public.lead_icp_matches
  add constraint lead_icp_matches_confidence_check
  check (confidence is null or (confidence >= 0 and confidence <= 1));

create index if not exists lead_icp_matches_qualified_idx
  on public.lead_icp_matches (lead_id, qualified_at desc)
  where qualified_at is not null;

-- The cache-materialisation lookup: "is there an answer for exactly this input?"
create index if not exists lead_icp_matches_input_hash_idx
  on public.lead_icp_matches (lead_id, input_hash)
  where input_hash is not null;

-- ---------------------------------------------------------------------------
-- nexus_claim_ai_direct_work — model-only jobs
-- ---------------------------------------------------------------------------
create or replace function public.nexus_claim_ai_direct_work(
  p_limit integer default 5,
  p_business_id uuid default null,
  p_lease_seconds integer default 600,
  p_job_types text[] default array['QUALIFY_LEAD', 'BUILD_CONTEXT'],
  p_capabilities text[] default array['ai_qualify', 'ai_context']
)
  returns table (
    job_id uuid,
    business_id uuid,
    job_type text,
    lead_id uuid,
    person_id uuid,
    company_id uuid,
    attempt_count integer,
    lease_expires_at timestamptz
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 600), 60), 3600);
  v_types text[] := coalesce(p_job_types, array['QUALIFY_LEAD', 'BUILD_CONTEXT']);
  v_caps text[] := coalesce(p_capabilities, array['ai_qualify', 'ai_context']);
begin
  if p_business_id is not null then
    if not public.nexus_job_scope_ok(p_business_id, 'jobs:submit') then
      raise exception 'claiming model-only agent work is not permitted for this actor'
        using errcode = '42501';
    end if;
  elsif public.acting_api_client_id() is null and not public.is_admin() then
    raise exception 'claiming model-only agent work across all businesses requires an admin or a service token'
      using errcode = '42501';
  end if;

  return query
  with candidate as (
    select j.id
      from public.agent_jobs j
     where j.status = 'OPEN'
       and j.job_type = any (v_types)
       -- A job whose required capabilities the processor does not hold is never
       -- offered: the capability list is the contract, not a hint.
       and (j.required_capabilities = '{}'::text[] or j.required_capabilities <@ v_caps)
       and (p_business_id is null or j.business_id = p_business_id)
       and (
         public.is_admin()
         or (public.acting_api_client_id() is not null and j.business_id = any (public.api_client_business_ids()))
         or j.business_id = p_business_id
       )
       and j.attempt_count < j.max_attempts
     order by
       case j.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
       j.created_at
     for update skip locked
     limit greatest(coalesce(p_limit, 5), 1)
  ),
  updated as (
    update public.agent_jobs j
       set status = 'RUNNING',
           claimed_by_agent = 'ai_processor',
           claimed_at = now(),
           last_heartbeat_at = now(),
           lease_expires_at = now() + make_interval(secs => v_lease),
           attempt_count = j.attempt_count + 1,
           last_error_code = null,
           updated_at = now()
      from candidate c
     where j.id = c.id
    returning j.id, j.business_id, j.job_type, j.lead_id, j.person_id, j.company_id,
              j.attempt_count, j.lease_expires_at
  ),
  logged as (
    insert into public.agent_job_events (job_id, business_id, event_type, actor_type, note, payload)
    select u.id, u.business_id, 'claimed', 'system', 'Claimed by the AI processor for a model call',
           jsonb_build_object('lease_expires_at', u.lease_expires_at, 'attempt', u.attempt_count)
      from updated u
    returning 1 as done
  )
  select u.id, u.business_id, u.job_type, u.lead_id, u.person_id, u.company_id,
         u.attempt_count, u.lease_expires_at
    from updated u,
         -- Forces the event insert to run; it cannot change the row count.
         (select count(*) as n from logged) l;
end
$$;

comment on function public.nexus_claim_ai_direct_work(integer, uuid, integer, text[], text[]) is
  'V1.2: claims OPEN jobs whose work is a model call (QUALIFY_LEAD, BUILD_CONTEXT). Lease-guarded and skip-locked.';

-- ---------------------------------------------------------------------------
-- nexus_complete_direct_agent_job — completion for a model-only job
-- ---------------------------------------------------------------------------
create or replace function public.nexus_complete_direct_agent_job(
  p_job_id uuid,
  p_ai_run_id uuid default null,
  p_agent text default 'ai_processor'
)
  returns table (job_id uuid, status text)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs;
  v_pending integer;
begin
  select * into v_job from public.agent_jobs j where j.id = p_job_id;
  if v_job.id is null then
    raise exception 'unknown agent job' using errcode = 'P0002';
  end if;

  if not public.nexus_job_scope_ok(v_job.business_id, 'jobs:submit') then
    raise exception 'completing agent work is not permitted for this actor' using errcode = '42501';
  end if;

  if v_job.status <> 'RUNNING' or v_job.claimed_by_agent is distinct from btrim(p_agent) then
    raise exception 'only the agent holding a running job may complete it (status %)', v_job.status
      using errcode = '55006';
  end if;

  select count(*) into v_pending
    from public.raw_staging r
   where r.agent_job_id = p_job_id
     and r.consumed_at is null;

  if v_pending > 0 then
    -- The same rule as an evidence-backed job: nothing may be reported done while
    -- a staged body it produced still exists.
    raise exception 'agent job still has % un-consumed raw staging row(s)', v_pending
      using errcode = '55006';
  end if;

  update public.agent_jobs j
     set status = 'COMPLETE',
         completed_at = now(),
         result_ai_run_id = p_ai_run_id,
         claimed_by_agent = null,
         lease_expires_at = null,
         updated_at = now()
   where j.id = p_job_id;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, note, payload)
  values (p_job_id, v_job.business_id, 'completed', 'system', null,
          'Structured result persisted by the AI processor',
          jsonb_build_object('ai_run_id', p_ai_run_id, 'job_type', v_job.job_type));

  return query select j.id, j.status from public.agent_jobs j where j.id = p_job_id;
end
$$;

comment on function public.nexus_complete_direct_agent_job(uuid, uuid, text) is
  'V1.2: completes a model-only job the processor holds, after the structured result has been persisted.';

revoke all on function public.nexus_claim_ai_direct_work(integer, uuid, integer, text[], text[]) from public, anon;
revoke all on function public.nexus_complete_direct_agent_job(uuid, uuid, text) from public, anon;
grant execute on function public.nexus_claim_ai_direct_work(integer, uuid, integer, text[], text[]) to authenticated;
grant execute on function public.nexus_complete_direct_agent_job(uuid, uuid, text) to authenticated;
