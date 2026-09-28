-- ============================================================================
-- NEXUS DB - 0032 V1.2 durable agent job queue
--
-- OpenCode is not always online, and the work it does — reading a live browser —
-- cannot be replaced by a request-scoped HTTP call. A job therefore has to be a
-- durable row that outlives every connection: it is created by the product or by
-- the automatic chaining rules, sits in `OPEN`, and waits. When an agent comes
-- online it lists open jobs through MCP, claims one atomically, heartbeats while
-- it works, and submits evidence.
--
-- Three rules shape the SQL here:
--
--   1. **Claiming is atomic and singular.** `... for update skip locked` inside a
--      single UPDATE means two agents racing for one job cannot both win, and the
--      loser does not block: it skips the locked row and takes the next one.
--   2. **A lease is a promise with an expiry.** A crashed agent must not park a job
--      in `RUNNING` forever. Every claim writes `lease_expires_at`; heartbeats push
--      it out; an expired lease makes the job claimable again and the reaper moves
--      it back to `OPEN` with an event that says why.
--   3. **Submitting is not completing.** `nexus_submit_agent_job_result` stages the
--      raw evidence and moves the job to `WAITING_AI` — it can never reach
--      `COMPLETE`. `nexus_complete_agent_job` is called only by the AI processor,
--      only from `WAITING_AI`, and only when no un-consumed staging row remains for
--      the job. That is the database-level expression of "OpenCode does not
--      complete the job; a validated structured commit does".
--
-- Writes go through the functions below rather than table policies: an UPDATE
-- policy broad enough to let the UI cancel a job would also be broad enough to let
-- a caller set `COMPLETE`, which is exactly the bypass rule 3 forbids. The table
-- is ENABLE + FORCE row level security with a read policy only.
-- ============================================================================

create table if not exists public.agent_jobs (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  lead_id               uuid references public.leads (id) on delete cascade,
  person_id             uuid references public.people (id) on delete set null,
  company_id            uuid references public.companies (id) on delete set null,
  job_type              text not null
                          constraint agent_jobs_type_check
                          check (job_type in (
                            'RESEARCH_COMPANY', 'RESEARCH_PERSON', 'RESEARCH_SIGNALS',
                            'CAPTURE_PROFILE', 'ENRICH_PROFILE', 'QUALIFY_LEAD',
                            'BUILD_CONTEXT', 'DRAFT_OUTREACH', 'OTHER'
                          )),
  priority              text not null default 'normal'
                          constraint agent_jobs_priority_check
                          check (priority in ('low', 'normal', 'high', 'urgent')),
  status                text not null default 'OPEN'
                          constraint agent_jobs_status_check
                          check (status in ('OPEN', 'RUNNING', 'WAITING_AI', 'COMPLETE', 'FAILED', 'CANCELLED')),
  instructions          text,
  required_capabilities text[] not null default '{}'::text[],
  created_by_type       text not null default 'system'
                          constraint agent_jobs_created_by_type_check
                          check (created_by_type in ('user', 'api_client', 'system', 'agent')),
  created_by_id         uuid,
  claimed_by_agent      text,
  claimed_at            timestamptz,
  lease_expires_at      timestamptz,
  last_heartbeat_at     timestamptz,
  attempt_count         integer not null default 0
                          constraint agent_jobs_attempt_check
                          check (attempt_count >= 0),
  max_attempts          integer not null default 3
                          constraint agent_jobs_max_attempts_check
                          check (max_attempts between 1 and 20),
  last_error_code       text,
  -- Why this job exists, and the stable key that makes automatic chaining
  -- deduplicable. Without the key, "create a company research job when research is
  -- missing" would create one per page load; without the reason, an operator
  -- looking at the queue could not tell a chained job from a hand-made one.
  dedupe_key            text,
  reason                text,
  result_ai_run_id      uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  completed_at          timestamptz
);

comment on table public.agent_jobs is
  'V1.2 durable agent work queue. Claim/lease/heartbeat are concurrency-safe; COMPLETE is reachable only through nexus_complete_agent_job after a structured commit and raw deletion.';

-- One active job per (business, dedupe key). COMPLETE/FAILED/CANCELLED rows keep
-- their key, so a re-created job later is a new row and the history is intact.
create unique index if not exists agent_jobs_active_dedupe_key
  on public.agent_jobs (business_id, dedupe_key)
  where dedupe_key is not null
    and status in ('OPEN', 'RUNNING', 'WAITING_AI');

-- The priority ordering is repeated in the claim function on purpose: this index
-- exists so the claim's ORDER BY is served by an index rather than by sorting the
-- whole open queue. The CASE is parenthesised because CREATE INDEX treats a
-- non-function-call expression as requiring its own parentheses.
create index if not exists agent_jobs_claimable_idx
  on public.agent_jobs (
    business_id,
    (case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end),
    created_at
  )
  where status in ('OPEN', 'RUNNING');

create index if not exists agent_jobs_status_idx
  on public.agent_jobs (business_id, status, updated_at desc);

create index if not exists agent_jobs_lead_idx
  on public.agent_jobs (lead_id, created_at desc);

create index if not exists agent_jobs_lease_idx
  on public.agent_jobs (lease_expires_at)
  where status = 'RUNNING';

drop trigger if exists agent_jobs_touch_updated_at on public.agent_jobs;
create trigger agent_jobs_touch_updated_at
  before update on public.agent_jobs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- agent_job_events — append-only history, never a research dump
-- ---------------------------------------------------------------------------
create table if not exists public.agent_job_events (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.agent_jobs (id) on delete cascade,
  business_id  uuid not null references public.businesses (id) on delete cascade,
  event_type   text not null
                 constraint agent_job_events_type_check
                 check (event_type in (
                   'created', 'claimed', 'heartbeat', 'released', 'failed',
                   'result_submitted', 'ai_started', 'completed', 'cancelled',
                   'lease_expired', 'retry_scheduled'
                 )),
  actor_type   text not null default 'system'
                 constraint agent_job_events_actor_type_check
                 check (actor_type in ('user', 'api_client', 'system', 'agent')),
  actor_id     uuid,
  agent_name   text,
  -- Short, operator-facing text only. Raw evidence belongs in raw_staging, which is
  -- deleted; a note here that quoted it would outlive the deletion policy.
  note         text,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

comment on table public.agent_job_events is
  'Append-only agent job history. Notes are short operator text; raw evidence is never written here.';

create index if not exists agent_job_events_job_idx
  on public.agent_job_events (job_id, created_at desc);

create index if not exists agent_job_events_business_idx
  on public.agent_job_events (business_id, created_at desc);

alter table public.agent_jobs enable row level security;
alter table public.agent_jobs force row level security;

alter table public.agent_job_events enable row level security;
alter table public.agent_job_events force row level security;

drop policy if exists agent_jobs_select on public.agent_jobs;
create policy agent_jobs_select on public.agent_jobs
  for select to authenticated
  using (public.has_business_access(business_id));

drop policy if exists agent_job_events_select on public.agent_job_events;
create policy agent_job_events_select on public.agent_job_events
  for select to authenticated
  using (public.has_business_access(business_id));

-- No insert/update/delete policies: every mutation goes through a function below,
-- so the COMPLETE transition cannot be forged by a direct UPDATE.
grant select on public.agent_jobs to authenticated;
grant select on public.agent_job_events to authenticated;
revoke insert, update, delete, truncate on public.agent_jobs from authenticated;
revoke insert, update, delete, truncate on public.agent_job_events from authenticated;

-- ---------------------------------------------------------------------------
-- Capability helper
-- ---------------------------------------------------------------------------
create or replace function public.nexus_job_scope_ok(p_business_id uuid, p_scope text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p_business_id is not null
     and (
       public.is_admin()
       or (
         public.current_user_id() is not null
         and public.has_business_access(p_business_id)
         and public.can_manage_leads(p_business_id)
       )
       or public.is_api_client_allowed(p_business_id, p_scope)
     );
$$;

comment on function public.nexus_job_scope_ok(uuid, text) is
  'V1.2 agent job capability: admin, a manager of that business, or a scoped agent token.';

-- ---------------------------------------------------------------------------
-- Enqueue (with deduplication)
-- ---------------------------------------------------------------------------
create or replace function public.nexus_create_agent_job(
  p_business_id uuid,
  p_job_type text,
  p_lead_id uuid default null,
  p_person_id uuid default null,
  p_company_id uuid default null,
  p_priority text default 'normal',
  p_instructions text default null,
  p_required_capabilities text[] default '{}'::text[],
  p_created_by_type text default 'system',
  p_created_by_id uuid default null,
  p_dedupe_key text default null,
  p_reason text default null
)
  returns table (job_id uuid, created boolean)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.nexus_job_scope_ok(p_business_id, 'jobs:create') then
    raise exception 'creating an agent job is not permitted for this actor' using errcode = '42501';
  end if;

  insert into public.agent_jobs (
    business_id, lead_id, person_id, company_id, job_type, priority, status,
    instructions, required_capabilities, created_by_type, created_by_id,
    dedupe_key, reason
  )
  values (
    p_business_id, p_lead_id, p_person_id, p_company_id, p_job_type, coalesce(p_priority, 'normal'), 'OPEN',
    p_instructions, coalesce(p_required_capabilities, '{}'::text[]), coalesce(p_created_by_type, 'system'), p_created_by_id,
    p_dedupe_key, p_reason
  )
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- A live job already carries this dedupe key: return it rather than creating a
    -- duplicate. Without a key there is no conflict to detect.
    select j.id into v_id
      from public.agent_jobs j
     where j.business_id = p_business_id
       and j.dedupe_key is not distinct from p_dedupe_key
       and j.status in ('OPEN', 'RUNNING', 'WAITING_AI')
     order by j.created_at
     limit 1;
    return query select v_id, false;
    return;
  end if;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, note, payload)
  values (
    v_id, p_business_id, 'created',
    case
      when public.acting_api_client_id() is not null then 'api_client'
      when public.current_user_id() is not null then 'user'
      else 'system'
    end,
    coalesce(public.acting_api_client_id(), public.current_user_id()),
    'Job created',
    jsonb_build_object(
      'job_type', p_job_type,
      'priority', coalesce(p_priority, 'normal'),
      'dedupe_key', p_dedupe_key,
      'reason', p_reason
    )
  );

  return query select v_id, true;
end
$$;

-- ---------------------------------------------------------------------------
-- Atomic claim
-- ---------------------------------------------------------------------------
create or replace function public.nexus_claim_agent_job(
  p_business_id uuid,
  p_agent text,
  p_capabilities text[] default '{}'::text[],
  p_job_id uuid default null,
  p_lease_seconds integer default 900
)
  returns table (
    id uuid,
    job_type text,
    priority text,
    status text,
    instructions text,
    required_capabilities text[],
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
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 900), 30), 7200);
  v_job public.agent_jobs;
begin
  if not public.nexus_job_scope_ok(p_business_id, 'jobs:claim') then
    raise exception 'claiming an agent job is not permitted for this actor' using errcode = '42501';
  end if;

  if p_agent is null or length(btrim(p_agent)) = 0 then
    raise exception 'claiming an agent job requires an agent name' using errcode = '22023';
  end if;

  -- One statement: the row is selected with FOR UPDATE SKIP LOCKED and updated by
  -- the same statement, so two agents racing for one job cannot both win and the
  -- loser moves straight on to the next candidate instead of blocking.
  update public.agent_jobs j
     set status = 'RUNNING',
         claimed_by_agent = btrim(p_agent),
         claimed_at = now(),
         last_heartbeat_at = now(),
         lease_expires_at = now() + make_interval(secs => v_lease),
         attempt_count = j.attempt_count + 1,
         last_error_code = null,
         updated_at = now()
   where j.id = (
     select c.id
       from public.agent_jobs c
      where c.business_id = p_business_id
        and (p_job_id is null or c.id = p_job_id)
        -- An expired lease makes a RUNNING job claimable again: this is the crash
        -- recovery path, and it is why a dead agent cannot park work forever.
        and (c.status = 'OPEN' or (c.status = 'RUNNING' and c.lease_expires_at < now()))
        and c.attempt_count < c.max_attempts
        and (
          c.required_capabilities = '{}'::text[]
          or c.required_capabilities <@ coalesce(p_capabilities, '{}'::text[])
        )
      order by
        case c.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
        c.created_at
      for update skip locked
      limit 1
   )
  returning * into v_job;

  -- Nothing claimable is not an error: an agent polling an empty queue must get an
  -- empty answer, not a failure it would retry.
  if v_job.id is null then
    return;
  end if;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, agent_name, note, payload)
  values (v_job.id, v_job.business_id, 'claimed',
          case when public.acting_api_client_id() is not null then 'api_client' else 'agent' end,
          public.acting_api_client_id(), v_job.claimed_by_agent, 'Job claimed',
          jsonb_build_object('lease_expires_at', v_job.lease_expires_at, 'attempt', v_job.attempt_count));

  return query
    select v_job.id, v_job.job_type, v_job.priority, v_job.status, v_job.instructions,
           v_job.required_capabilities, v_job.lead_id, v_job.person_id, v_job.company_id,
           v_job.attempt_count, v_job.lease_expires_at;
end
$$;

-- ---------------------------------------------------------------------------
-- Heartbeat / release / fail
-- ---------------------------------------------------------------------------
create or replace function public.nexus_heartbeat_agent_job(
  p_job_id uuid,
  p_agent text,
  p_lease_seconds integer default 900
)
  returns table (id uuid, status text, lease_expires_at timestamptz, attempt_count integer)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 900), 30), 7200);
  v_job public.agent_jobs;
begin
  select * into v_job from public.agent_jobs j where j.id = p_job_id;
  if v_job.id is null then
    raise exception 'unknown agent job' using errcode = 'P0002';
  end if;

  if not public.nexus_job_scope_ok(v_job.business_id, 'jobs:claim') then
    raise exception 'heartbeating an agent job is not permitted for this actor' using errcode = '42501';
  end if;

  if v_job.status <> 'RUNNING' or v_job.claimed_by_agent is distinct from btrim(p_agent) then
    -- Distinguishable from "not found": an agent whose lease was reaped needs to
    -- know that the job moved on, not that it never existed.
    raise exception 'agent job is not held by this agent' using errcode = '55006';
  end if;

  update public.agent_jobs j
     set last_heartbeat_at = now(),
         lease_expires_at = now() + make_interval(secs => v_lease),
         updated_at = now()
   where j.id = p_job_id;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, agent_name, note, payload)
  values (p_job_id, v_job.business_id, 'heartbeat',
          case when public.acting_api_client_id() is not null then 'api_client' else 'agent' end,
          public.acting_api_client_id(), btrim(p_agent), 'Lease extended',
          jsonb_build_object('lease_seconds', v_lease));

  return query
    select j.id, j.status, j.lease_expires_at, j.attempt_count
      from public.agent_jobs j where j.id = p_job_id;
end
$$;

create or replace function public.nexus_release_agent_job(
  p_job_id uuid,
  p_agent text,
  p_reason text default null
)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs;
begin
  select * into v_job from public.agent_jobs j where j.id = p_job_id;
  if v_job.id is null then
    raise exception 'unknown agent job' using errcode = 'P0002';
  end if;

  if not public.nexus_job_scope_ok(v_job.business_id, 'jobs:claim') then
    raise exception 'releasing an agent job is not permitted for this actor' using errcode = '42501';
  end if;

  if v_job.claimed_by_agent is not null and v_job.claimed_by_agent is distinct from btrim(p_agent) then
    raise exception 'agent job is held by a different agent' using errcode = '55006';
  end if;

  -- Release returns the job to the queue unchanged: a released attempt counts
  -- against max_attempts (it was already incremented by the claim), so a job that
  -- keeps failing cannot be released forever.
  update public.agent_jobs j
     set status = 'OPEN',
         claimed_by_agent = null,
         claimed_at = null,
         lease_expires_at = null,
         updated_at = now()
   where j.id = p_job_id;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, agent_name, note)
  values (p_job_id, v_job.business_id, 'released',
          case when public.acting_api_client_id() is not null then 'api_client' else 'agent' end,
          public.acting_api_client_id(), btrim(p_agent),
          left(coalesce(p_reason, 'Released by agent'), 500));
end
$$;

create or replace function public.nexus_fail_agent_job(
  p_job_id uuid,
  p_agent text,
  p_error_code text,
  p_message text default null,
  p_retryable boolean default true
)
  returns table (id uuid, status text, attempt_count integer)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs;
  v_status text;
begin
  select * into v_job from public.agent_jobs j where j.id = p_job_id;
  if v_job.id is null then
    raise exception 'unknown agent job' using errcode = 'P0002';
  end if;

  if not public.nexus_job_scope_ok(v_job.business_id, 'jobs:submit') then
    raise exception 'failing an agent job is not permitted for this actor' using errcode = '42501';
  end if;

  if v_job.claimed_by_agent is not null and v_job.claimed_by_agent is distinct from btrim(p_agent) then
    raise exception 'agent job is held by a different agent' using errcode = '55006';
  end if;

  -- Retry while attempts remain, otherwise FAILED. A non-retryable failure is
  -- terminal immediately: retrying a malformed request forever is worse than
  -- showing an operator a failed job.
  v_status := case
                when p_retryable and v_job.attempt_count < v_job.max_attempts then 'OPEN'
                else 'FAILED'
              end;

  update public.agent_jobs j
     set status = v_status,
         claimed_by_agent = null,
         claimed_at = null,
         lease_expires_at = null,
         last_error_code = left(coalesce(p_error_code, 'agent_failed'), 120),
         updated_at = now()
   where j.id = p_job_id;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, agent_name, note, payload)
  values (p_job_id, v_job.business_id,
          case when v_status = 'OPEN' then 'retry_scheduled' else 'failed' end,
          case when public.acting_api_client_id() is not null then 'api_client' else 'agent' end,
          public.acting_api_client_id(), btrim(p_agent),
          left(coalesce(p_message, 'Agent reported a failure'), 500),
          jsonb_build_object('error_code', p_error_code, 'retryable', p_retryable, 'status', v_status));

  return query select j.id, j.status, j.attempt_count from public.agent_jobs j where j.id = p_job_id;
end
$$;

create or replace function public.nexus_cancel_agent_job(p_job_id uuid, p_reason text default null)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs;
begin
  select * into v_job from public.agent_jobs j where j.id = p_job_id;
  if v_job.id is null then
    raise exception 'unknown agent job' using errcode = 'P0002';
  end if;

  if not public.nexus_job_scope_ok(v_job.business_id, 'jobs:create') then
    raise exception 'cancelling an agent job is not permitted for this actor' using errcode = '42501';
  end if;

  if v_job.status = 'COMPLETE' then
    raise exception 'a completed agent job cannot be cancelled' using errcode = '55006';
  end if;

  update public.agent_jobs j
     set status = 'CANCELLED',
         claimed_by_agent = null,
         claimed_at = null,
         lease_expires_at = null,
         updated_at = now()
   where j.id = p_job_id;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, note)
  values (p_job_id, v_job.business_id, 'cancelled',
          case when public.acting_api_client_id() is not null then 'api_client' else 'user' end,
          coalesce(public.acting_api_client_id(), public.current_user_id()),
          left(coalesce(p_reason, 'Cancelled'), 500));
end
$$;

-- ---------------------------------------------------------------------------
-- Submit result: stage raw, wait for AI. Never COMPLETE.
-- ---------------------------------------------------------------------------
create or replace function public.nexus_submit_agent_job_result(
  p_job_id uuid,
  p_agent text,
  p_payload text,
  p_content_hash text,
  p_kind text default 'company_research',
  p_source_type text default 'web',
  p_source_url text default null
)
  returns table (job_id uuid, status text, raw_staging_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs;
  v_raw uuid;
begin
  select * into v_job from public.agent_jobs j where j.id = p_job_id;
  if v_job.id is null then
    raise exception 'unknown agent job' using errcode = 'P0002';
  end if;

  if not public.nexus_job_scope_ok(v_job.business_id, 'jobs:submit') then
    raise exception 'submitting an agent job result is not permitted for this actor' using errcode = '42501';
  end if;

  if v_job.claimed_by_agent is not null and v_job.claimed_by_agent is distinct from btrim(p_agent) then
    raise exception 'agent job is held by a different agent' using errcode = '55006';
  end if;

  if v_job.status not in ('RUNNING') then
    raise exception 'only a running agent job accepts a result (status %)', v_job.status using errcode = '55006';
  end if;

  -- The raw body goes to staging and nowhere else. It is returned to the caller as
  -- an id so the AI step can find it, and it is deleted the moment the structured
  -- commit for it has been verified.
  v_raw := public.nexus_stage_raw(
    v_job.business_id, v_job.lead_id, v_job.person_id, v_job.company_id, v_job.id,
    p_kind, p_source_type, p_source_url, p_payload, p_content_hash, btrim(p_agent)
  );

  update public.agent_jobs j
     set status = 'WAITING_AI',
         lease_expires_at = null,
         last_heartbeat_at = now(),
         updated_at = now()
   where j.id = p_job_id;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, agent_name, note, payload)
  values (p_job_id, v_job.business_id, 'result_submitted',
          case when public.acting_api_client_id() is not null then 'api_client' else 'agent' end,
          public.acting_api_client_id(), btrim(p_agent),
          'Evidence staged; awaiting AI extraction',
          jsonb_build_object('raw_staging_id', v_raw, 'content_hash', p_content_hash, 'kind', p_kind));

  return query select p_job_id, 'WAITING_AI'::text, v_raw;
end
$$;

-- ---------------------------------------------------------------------------
-- Complete: only from WAITING_AI, only after the staged raw body is gone
-- ---------------------------------------------------------------------------
create or replace function public.nexus_complete_agent_job(p_job_id uuid, p_ai_run_id uuid default null)
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
    raise exception 'completing an agent job is not permitted for this actor' using errcode = '42501';
  end if;

  if v_job.status <> 'WAITING_AI' then
    raise exception 'only a job awaiting AI can complete (status %)', v_job.status using errcode = '55006';
  end if;

  select count(*) into v_pending
    from public.raw_staging r
   where r.agent_job_id = p_job_id
     and r.consumed_at is null;

  if v_pending > 0 then
    -- The verification step of the raw lifecycle, enforced by the database rather
    -- than by processor discipline: evidence that still exists has not been
    -- committed, so the job cannot be reported done.
    raise exception 'agent job still has % un-consumed raw staging row(s)', v_pending using errcode = '55006';
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
          'Structured commit verified and raw evidence deleted',
          jsonb_build_object('ai_run_id', p_ai_run_id));

  return query select j.id, j.status from public.agent_jobs j where j.id = p_job_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Lease reaper — no job stays RUNNING because its agent died
-- ---------------------------------------------------------------------------
create or replace function public.nexus_reap_expired_job_leases(p_limit integer default 50)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_reaped integer := 0;
begin
  with expired as (
    select j.id, j.business_id, j.attempt_count, j.max_attempts
      from public.agent_jobs j
     where j.status = 'RUNNING'
       and j.lease_expires_at is not null
       and j.lease_expires_at < now()
     order by j.lease_expires_at
     limit greatest(coalesce(p_limit, 50), 1)
  ),
  updated as (
    update public.agent_jobs j
       set status = case when e.attempt_count >= e.max_attempts then 'FAILED' else 'OPEN' end,
           claimed_by_agent = null,
           claimed_at = null,
           lease_expires_at = null,
           last_error_code = case when e.attempt_count >= e.max_attempts then 'lease_expired_no_attempts' else j.last_error_code end,
           updated_at = now()
      from expired e
     where j.id = e.id
    returning j.id, j.business_id, j.status
  )
  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, note, payload)
  select u.id, u.business_id, 'lease_expired', 'system',
         case when u.status = 'FAILED' then 'Lease expired with no attempts left; job failed'
              else 'Lease expired; job returned to the queue' end,
         jsonb_build_object('resulting_status', u.status)
    from updated u;

  get diagnostics v_reaped = row_count;
  return v_reaped;
end
$$;

revoke all on function public.nexus_job_scope_ok(uuid, text) from public, anon;
revoke all on function public.nexus_create_agent_job(uuid, text, uuid, uuid, uuid, text, text, text[], text, uuid, text, text) from public, anon;
revoke all on function public.nexus_claim_agent_job(uuid, text, text[], uuid, integer) from public, anon;
revoke all on function public.nexus_heartbeat_agent_job(uuid, text, integer) from public, anon;
revoke all on function public.nexus_release_agent_job(uuid, text, text) from public, anon;
revoke all on function public.nexus_fail_agent_job(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.nexus_cancel_agent_job(uuid, text) from public, anon;
revoke all on function public.nexus_submit_agent_job_result(uuid, text, text, text, text, text, text) from public, anon;
revoke all on function public.nexus_complete_agent_job(uuid, uuid) from public, anon;
revoke all on function public.nexus_reap_expired_job_leases(integer) from public, anon;

grant execute on function public.nexus_job_scope_ok(uuid, text) to authenticated;
grant execute on function public.nexus_create_agent_job(uuid, text, uuid, uuid, uuid, text, text, text[], text, uuid, text, text) to authenticated;
grant execute on function public.nexus_claim_agent_job(uuid, text, text[], uuid, integer) to authenticated;
grant execute on function public.nexus_heartbeat_agent_job(uuid, text, integer) to authenticated;
grant execute on function public.nexus_release_agent_job(uuid, text, text) to authenticated;
grant execute on function public.nexus_fail_agent_job(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.nexus_cancel_agent_job(uuid, text) to authenticated;
grant execute on function public.nexus_submit_agent_job_result(uuid, text, text, text, text, text, text) to authenticated;
grant execute on function public.nexus_complete_agent_job(uuid, uuid) to authenticated;
grant execute on function public.nexus_reap_expired_job_leases(integer) to authenticated;
