-- ============================================================================
-- NEXUS DB - 0034 V1.2 processor surface, aggregation views and read indexes
--
-- Everything here exists to keep V1.2 no slower than V1.1:
--
--   * `nexus_claim_ai_work` is how the server-side processor takes WAITING_AI work
--     without two processors extracting the same staged evidence. It reuses the job
--     lease rather than adding a second locking mechanism, and it excludes a job
--     whose lease is still live, so a crashed processor's work is picked up again
--     after the lease lapses rather than being lost.
--
--   * The three views are read projections for the Overview, Agent Jobs and
--     Insights screens. They are SECURITY INVOKER, so they are filtered by exactly
--     the RLS policies of the tables underneath and cannot become a way to read
--     across businesses.
--
--   * The indexes cover the lookups the V1.2 screens actually issue. They are
--     additive and partial where the query is partial, so the write cost of the
--     busiest tables barely moves.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- AI work claim (idempotent, lease-guarded, concurrency-safe)
-- ---------------------------------------------------------------------------
create or replace function public.nexus_claim_ai_work(
  p_limit integer default 5,
  p_business_id uuid default null,
  p_lease_seconds integer default 600
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
begin
  if p_business_id is not null then
    if not public.nexus_job_scope_ok(p_business_id, 'jobs:submit') then
      raise exception 'claiming AI work is not permitted for this actor' using errcode = '42501';
    end if;
  elsif public.acting_api_client_id() is null and not public.is_admin() then
    -- Sweeping every business is a deployment-level operation: an admin session or
    -- a scoped service token, never an ordinary user.
    raise exception 'claiming AI work across all businesses requires an admin or a service token'
      using errcode = '42501';
  end if;

  return query
  with candidate as (
    select j.id
      from public.agent_jobs j
     where j.status = 'WAITING_AI'
       and (p_business_id is null or j.business_id = p_business_id)
       and (
         public.is_admin()
         or (public.acting_api_client_id() is not null and j.business_id = any (public.api_client_business_ids()))
         or j.business_id = p_business_id
       )
       -- A live lease means another processor is already extracting this job. An
       -- expired one means it died, and the work is claimable again.
       and (j.lease_expires_at is null or j.lease_expires_at < now())
     order by j.created_at
     for update skip locked
     limit greatest(coalesce(p_limit, 5), 1)
  ),
  updated as (
    update public.agent_jobs j
       set lease_expires_at = now() + make_interval(secs => v_lease),
           claimed_by_agent = 'ai_processor',
           last_heartbeat_at = now(),
           updated_at = now()
      from candidate c
     where j.id = c.id
    returning j.id, j.business_id, j.job_type, j.lead_id, j.person_id, j.company_id,
              j.attempt_count, j.lease_expires_at
  )
  select u.id, u.business_id, u.job_type, u.lead_id, u.person_id, u.company_id,
         u.attempt_count, u.lease_expires_at
    from updated u;
end
$$;

comment on function public.nexus_claim_ai_work(integer, uuid, integer) is
  'V1.2 processor claim for WAITING_AI jobs. Lease-guarded and skip-locked, so two processors never extract the same evidence.';

-- ---------------------------------------------------------------------------
-- Read projections
-- ---------------------------------------------------------------------------
create or replace view public.ai_usage_daily
  with (security_invoker = true) as
select
  r.business_id,
  date_trunc('day', r.created_at)::date                as day,
  r.task,
  count(*)::bigint                                     as runs,
  count(*) filter (where r.cache_hit)::bigint          as cache_hits,
  count(*) filter (where r.status = 'FAILED')::bigint  as failures,
  coalesce(sum(r.tokens_in), 0)::bigint                as tokens_in,
  coalesce(sum(r.tokens_out), 0)::bigint               as tokens_out,
  coalesce(sum(r.estimated_cost_usd), 0)               as estimated_cost_usd,
  coalesce(avg(r.duration_ms), 0)::integer             as avg_duration_ms
from public.ai_runs r
group by r.business_id, date_trunc('day', r.created_at)::date, r.task;

comment on view public.ai_usage_daily is
  'V1.2 AI usage by business, day and task. Derived from the ledger; never contains a request or response body.';

create or replace view public.agent_job_queue_summary
  with (security_invoker = true) as
select
  j.business_id,
  j.status,
  count(*)::bigint                            as jobs,
  min(j.created_at)                           as oldest_created_at,
  min(j.lease_expires_at)                     as next_lease_expiry,
  coalesce(sum(j.attempt_count), 0)::bigint    as attempts
from public.agent_jobs j
group by j.business_id, j.status;

comment on view public.agent_job_queue_summary is
  'V1.2 Agent Jobs screen summary: OPEN / RUNNING / WAITING_AI / FAILED / COMPLETE per business.';

create or replace view public.lead_enrichment_funnel
  with (security_invoker = true) as
select
  e.business_id,
  e.status,
  count(*)::bigint                     as leads,
  coalesce(avg(e.completeness_score), 0)::integer as avg_completeness,
  count(*) filter (where e.last_error_code is not null)::bigint as with_error
from public.lead_enrichment e
group by e.business_id, e.status;

comment on view public.lead_enrichment_funnel is
  'V1.2 enrichment funnel for Overview/Insights: leads per enrichment state, average completeness and error count.';

grant select on public.ai_usage_daily to authenticated;
grant select on public.agent_job_queue_summary to authenticated;
grant select on public.lead_enrichment_funnel to authenticated;

-- ---------------------------------------------------------------------------
-- Indexes for the V1.2 read paths
-- ---------------------------------------------------------------------------

-- "which staging rows belong to this job" — asked by the completion guard and by
-- the processor after a submit.
create index if not exists source_evidence_agent_job_idx
  on public.source_evidence (business_id, agent_job_id)
  where agent_job_id is not null;

-- The Lead Detail timeline reads the newest events for one lead.
create index if not exists interactions_lead_recent_idx
  on public.interactions (lead_id, occurred_at desc);

-- The Leads list filters on source and orders by activity; V1.1 indexed business+status.
create index if not exists leads_business_source_idx
  on public.leads (business_id, source_type)
  where deleted_at is null;

create index if not exists leads_needs_profile_idx
  on public.leads (business_id, updated_at desc)
  where deleted_at is null and needs_profile;

-- Signals feed the "latest signal" column, one row per lead.
create index if not exists signals_lead_active_recent_idx
  on public.signals (lead_id, observed_at desc)
  where is_active;

-- The profile/company enrichment lookups that decide whether a job is needed.
create index if not exists people_linkedin_null_idx
  on public.people (updated_at desc)
  where normalized_linkedin_url is null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Retry: the one transition an operator may make on a terminal job
--
-- Retry is deliberately narrow. It resets a FAILED or CANCELLED job to OPEN and
-- clears the failure code, and it refuses anything else — in particular it cannot
-- reach COMPLETE, so an operator cannot shortcut the extraction the completion
-- rule requires. attempt_count is reset because a human explicitly decided to
-- grant another run; without that, a job at its attempt cap could never be retried
-- from the UI at all.
-- ---------------------------------------------------------------------------
create or replace function public.nexus_retry_agent_job(p_job_id uuid, p_reason text default null)
  returns table (id uuid, status text, attempt_count integer)
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
    raise exception 'retrying an agent job is not permitted for this actor' using errcode = '42501';
  end if;

  if v_job.status not in ('FAILED', 'CANCELLED') then
    raise exception 'only a failed or cancelled job can be retried (status %)', v_job.status
      using errcode = '55006';
  end if;

  update public.agent_jobs j
     set status = 'OPEN',
         attempt_count = 0,
         last_error_code = null,
         claimed_by_agent = null,
         claimed_at = null,
         lease_expires_at = null,
         updated_at = now()
   where j.id = p_job_id;

  insert into public.agent_job_events (job_id, business_id, event_type, actor_type, actor_id, note)
  values (p_job_id, v_job.business_id, 'created',
          case when public.acting_api_client_id() is not null then 'api_client' else 'user' end,
          coalesce(public.acting_api_client_id(), public.current_user_id()),
          left(coalesce(p_reason, 'Retried by an operator'), 500));

  return query select j.id, j.status, j.attempt_count from public.agent_jobs j where j.id = p_job_id;
end
$$;

revoke all on function public.nexus_retry_agent_job(uuid, text) from public, anon;
grant execute on function public.nexus_retry_agent_job(uuid, text) to authenticated;

revoke all on function public.nexus_claim_ai_work(integer, uuid, integer) from public, anon;
grant execute on function public.nexus_claim_ai_work(integer, uuid, integer) to authenticated;
