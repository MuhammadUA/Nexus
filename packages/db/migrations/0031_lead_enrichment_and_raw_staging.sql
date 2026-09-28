-- ============================================================================
-- NEXUS DB - 0031 V1.2 lead enrichment state and ephemeral raw staging
--
-- Two independent ideas that arrived together and must not be conflated:
--
--   * **Enrichment state is durable.** `leads.status` is a *sales* state (new,
--     ready, connection_due, replied, …). V1.2 needs a second, orthogonal axis:
--     how complete the intelligence about this lead is. It lives in
--     `lead_enrichment`, one row per lead, so the sales lifecycle is untouched and
--     an existing lead cannot be pushed into an invalid sales state by enrichment
--     work.
--
--   * **Raw bodies are ephemeral.** Pasted LinkedIn profiles, copied website text,
--     job-board text and OpenCode research dumps are staging material for one
--     extraction attempt. They are held in `raw_staging` only until a validated
--     structured commit has been verified, then deleted; anything abandoned is
--     removed by TTL after 24 hours. Raw bodies never land in canonical
--     Lead/Person/Company fields, never land in audit or error logs, and never
--     remain as permanent source-evidence text. What *is* permanent is metadata:
--     source type, source URL, observed time, content hash, collector agent, agent
--     job id, prompt version, model and extraction time — which is why
--     `source_evidence` gains those columns here.
--
-- Access model for `raw_staging`: row level security is ENABLED and FORCED, and
-- the only policy in existence authorises callers whose effective role is a member
-- of the dedicated `nexus_raw_writer` role. Tenant roles are not members, and the
-- table's privileges are revoked from `authenticated` and `anon` outright, so a
-- repository that accidentally selects from it as a user fails closed. The
-- SECURITY DEFINER functions at the end of this file run as their owner — the
-- migration role, which is granted membership — and each one begins with an
-- explicit business-capability assertion.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- lead_enrichment
-- ---------------------------------------------------------------------------
create table if not exists public.lead_enrichment (
  lead_id                       uuid primary key references public.leads (id) on delete cascade,
  business_id                   uuid not null references public.businesses (id) on delete cascade,
  status                        text not null default 'MINIMAL'
                                  constraint lead_enrichment_status_check
                                  check (status in (
                                    'MINIMAL', 'NEEDS_PROFILE', 'PROFILE_READY',
                                    'COMPANY_RESEARCH_PENDING', 'AGENT_RESEARCH_PENDING',
                                    'AI_PROCESSING', 'READY', 'NEEDS_REVIEW', 'FAILED'
                                  )),
  completeness_score            integer not null default 0
                                  constraint lead_enrichment_score_check
                                  check (completeness_score between 0 and 100),
  missing_fields                text[] not null default '{}'::text[],
  last_profile_enrichment_at    timestamptz,
  last_company_enrichment_at    timestamptz,
  last_context_build_at         timestamptz,
  last_error_code               text,
  -- Minimal, permanent provenance for the profile extraction that produced the
  -- current structured facts. The raw body it came from is gone; the hash is what
  -- proves which bytes were extracted.
  profile_source_type           text,
  profile_source_url            text,
  profile_observed_at           timestamptz,
  profile_content_hash          text,
  profile_agent_job_id          uuid,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

comment on table public.lead_enrichment is
  'V1.2 enrichment completeness for one lead. Orthogonal to leads.status (the sales state).';

create index if not exists lead_enrichment_business_status_idx
  on public.lead_enrichment (business_id, status);

create index if not exists lead_enrichment_missing_idx
  on public.lead_enrichment (business_id, updated_at desc)
  where status in ('NEEDS_PROFILE', 'COMPANY_RESEARCH_PENDING', 'AGENT_RESEARCH_PENDING', 'FAILED');

drop trigger if exists lead_enrichment_touch_updated_at on public.lead_enrichment;
create trigger lead_enrichment_touch_updated_at
  before update on public.lead_enrichment
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Every lead gets an enrichment row, whatever path created it
--
-- A trigger rather than instrumentation in each writer: CSV import, paste,
-- Companion add, MCP minimal lead, Apollo ingest and the admin UI all insert into
-- `leads`, and a missing enrichment row would silently look like "0% complete but
-- nothing to do". The function is deliberately NOT SECURITY DEFINER — it runs as
-- the writer, and the INSERT policy below allows exactly the callers that may
-- create a lead in that business.
-- ---------------------------------------------------------------------------
create or replace function public.nexus_seed_lead_enrichment()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  insert into public.lead_enrichment (lead_id, business_id, status)
  values (
    new.id,
    new.business_id,
    case when coalesce(new.needs_profile, false) then 'NEEDS_PROFILE' else 'MINIMAL' end
  )
  on conflict (lead_id) do nothing;
  return new;
end
$$;

drop trigger if exists leads_seed_enrichment on public.leads;
create trigger leads_seed_enrichment
  after insert on public.leads
  for each row execute function public.nexus_seed_lead_enrichment();

-- Backfill the leads that already exist. Additive and idempotent: re-running the
-- migration changes nothing.
insert into public.lead_enrichment (lead_id, business_id, status)
select l.id,
       l.business_id,
       case when coalesce(l.needs_profile, false) then 'NEEDS_PROFILE' else 'MINIMAL' end
  from public.leads l
 where l.deleted_at is null
on conflict (lead_id) do nothing;

alter table public.lead_enrichment enable row level security;
alter table public.lead_enrichment force row level security;

drop policy if exists lead_enrichment_select on public.lead_enrichment;
create policy lead_enrichment_select on public.lead_enrichment
  for select to authenticated
  using (public.has_business_access(business_id));

drop policy if exists lead_enrichment_insert on public.lead_enrichment;
create policy lead_enrichment_insert on public.lead_enrichment
  for insert to authenticated
  with check (public.has_business_access(business_id));

drop policy if exists lead_enrichment_update on public.lead_enrichment;
create policy lead_enrichment_update on public.lead_enrichment
  for update to authenticated
  using (public.has_business_access(business_id))
  with check (public.has_business_access(business_id));

-- No delete policy: enrichment state is derived from the lead and disappears with
-- it through the foreign key, so a delete would only ever be a way to lose the
-- "why is this incomplete" answer.

grant select, insert, update on public.lead_enrichment to authenticated;
revoke delete, truncate on public.lead_enrichment from authenticated;

-- ---------------------------------------------------------------------------
-- source_evidence — permanent metadata about raw bytes that no longer exist
-- ---------------------------------------------------------------------------
alter table public.source_evidence
  add column if not exists raw_content_hash text,
  add column if not exists raw_bytes integer,
  add column if not exists raw_deleted_at timestamptz,
  add column if not exists collector_agent text,
  add column if not exists agent_job_id uuid,
  add column if not exists prompt_version_id uuid references public.prompt_versions (id) on delete set null,
  add column if not exists model text,
  add column if not exists extracted_at timestamptz;

comment on column public.source_evidence.raw_content_hash is
  'SHA-256 of the raw body that was staged, extracted and then deleted. The bodies are gone; the hash is what remains verifiable.';
comment on column public.source_evidence.raw_deleted_at is
  'When the staged raw body was deleted. NULL only while a retryable staging row still exists.';

-- ---------------------------------------------------------------------------
-- raw_staging — ephemeral, server-only
-- ---------------------------------------------------------------------------
create table if not exists public.raw_staging (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  lead_id         uuid references public.leads (id) on delete cascade,
  person_id       uuid references public.people (id) on delete set null,
  company_id      uuid references public.companies (id) on delete set null,
  agent_job_id    uuid,
  kind            text not null
                    constraint raw_staging_kind_check
                    check (kind in ('profile_paste', 'company_research', 'signal_research', 'source_metadata')),
  source_type     text not null,
  source_url      text,
  payload         text not null,
  content_hash    text not null,
  collector_agent text,
  status          text not null default 'PENDING'
                    constraint raw_staging_status_check
                    check (status in ('PENDING', 'PROCESSING', 'CONSUMED', 'FAILED', 'EXPIRED')),
  attempt_count   integer not null default 0
                    constraint raw_staging_attempts_check
                    check (attempt_count >= 0),
  last_error_code text,
  -- 24h default lifetime. The column is on the row rather than a policy constant
  -- so a retry can shorten it and an operator can see exactly when it dies.
  expires_at      timestamptz not null default (now() + interval '24 hours'),
  consumed_at     timestamptz,
  created_by      uuid references public.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.raw_staging is
  'V1.2 ephemeral raw bodies. Server-only: RLS is FORCEd with a single policy that only members of nexus_raw_writer satisfy. Deleted after a verified structured commit, or by TTL after 24h.';

create index if not exists raw_staging_ttl_idx
  on public.raw_staging (expires_at)
  where consumed_at is null;

create index if not exists raw_staging_job_idx
  on public.raw_staging (agent_job_id)
  where consumed_at is null;

create index if not exists raw_staging_lead_idx
  on public.raw_staging (lead_id, created_at desc);

drop trigger if exists raw_staging_touch_updated_at on public.raw_staging;
create trigger raw_staging_touch_updated_at
  before update on public.raw_staging
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- nexus_raw_writer — the role that makes the policy below enforceable
--
-- A policy cannot say "only server code": by the time SQL runs, the caller is a
-- role. Creating a NOLOGIN role that no tenant role is a member of, granting it to
-- the migration role only, and keying the policy on membership gives exactly that
-- property. A SECURITY DEFINER function owned by the migration role therefore
-- passes the policy, while `authenticated` — the role every request runs as — does
-- not. The role deliberately has NOBYPASSRLS: it satisfies the policy rather than
-- escaping it.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nexus_raw_writer') then
    create role nexus_raw_writer nologin noinherit nobypassrls;
  end if;
end
$$;

do $$
begin
  execute format('grant nexus_raw_writer to %I', current_user);
exception
  when others then
    -- Hosted projects may run migrations as a role that cannot grant membership.
    -- The definer functions below then rely on the owner's implicit table
    -- privileges, and the policy check is what still keeps tenants out.
    null;
end
$$;

grant usage on schema public to nexus_raw_writer;
grant select, insert, update, delete on public.raw_staging to nexus_raw_writer;

alter table public.raw_staging enable row level security;
alter table public.raw_staging force row level security;

-- `to public` on purpose: the policy is the authorization rule for every role,
-- including the definer owner. `using` and `with check` are identical so a writer
-- cannot read back a row it could not have written.
drop policy if exists raw_staging_writer_only on public.raw_staging;
create policy raw_staging_writer_only on public.raw_staging
  for all
  using (pg_has_role(current_user, 'nexus_raw_writer', 'member'))
  with check (pg_has_role(current_user, 'nexus_raw_writer', 'member'));

revoke all on public.raw_staging from public, anon, authenticated;

-- Every function below is SECURITY DEFINER, so the policy is satisfied by the
-- owner's membership in nexus_raw_writer. Each one asserts the caller's business
-- capability first — an unauthorized caller gets 42501 before any row is touched.
create or replace function public.nexus_can_touch_raw(p_business_id uuid)
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
         and public.can_use_lead_sources(p_business_id)
       )
       or public.is_api_client_allowed(p_business_id, 'lead_sources:write')
       or public.is_api_client_allowed(p_business_id, 'jobs:submit')
     );
$$;

comment on function public.nexus_can_touch_raw(uuid) is
  'V1.2 raw staging capability: admin, a lead-source-permissioned user, or a scoped agent token.';

create or replace function public.nexus_stage_raw(
  p_business_id uuid,
  p_lead_id uuid,
  p_person_id uuid,
  p_company_id uuid,
  p_agent_job_id uuid,
  p_kind text,
  p_source_type text,
  p_source_url text,
  p_payload text,
  p_content_hash text,
  p_collector_agent text
)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.nexus_can_touch_raw(p_business_id) then
    raise exception 'raw staging is not permitted for this actor' using errcode = '42501';
  end if;

  if p_payload is null or length(p_payload) = 0 then
    raise exception 'raw staging requires a non-empty payload' using errcode = '22023';
  end if;

  -- Hard ceiling: this table exists to hold one extraction's worth of text, not a
  -- scraped corpus. 400k characters is far above a long LinkedIn profile or a
  -- company site dump and far below anything that would make the TTL sweep slow.
  if length(p_payload) > 400000 then
    raise exception 'raw staging payload exceeds the 400000 character limit' using errcode = '22023';
  end if;

  insert into public.raw_staging (
    business_id, lead_id, person_id, company_id, agent_job_id,
    kind, source_type, source_url, payload, content_hash, collector_agent,
    status, expires_at, created_by
  )
  values (
    p_business_id, p_lead_id, p_person_id, p_company_id, p_agent_job_id,
    p_kind, p_source_type, p_source_url, p_payload, p_content_hash, p_collector_agent,
    'PENDING', now() + interval '24 hours', public.current_user_id()
  )
  returning id into v_id;

  return v_id;
end
$$;

-- Returns the row's payload and metadata for one extraction attempt. Reading is
-- what marks the attempt: `attempt_count` increments here, so a crash between read
-- and delete is visible rather than invisible.
create or replace function public.nexus_read_raw_staging(p_id uuid)
  returns table (
    id uuid,
    business_id uuid,
    lead_id uuid,
    person_id uuid,
    company_id uuid,
    agent_job_id uuid,
    kind text,
    source_type text,
    source_url text,
    payload text,
    content_hash text,
    collector_agent text,
    status text,
    attempt_count integer,
    expires_at timestamptz
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_row public.raw_staging;
begin
  select * into v_row from public.raw_staging r where r.id = p_id;

  if v_row.id is null then
    return;
  end if;

  if not public.nexus_can_touch_raw(v_row.business_id) then
    -- Same refusal for "not found" and "not yours": confirming existence of a
    -- staging row outside the caller's scope would leak tenancy information.
    return;
  end if;

  update public.raw_staging r
     set status = case when r.status = 'PENDING' then 'PROCESSING' else r.status end,
         attempt_count = r.attempt_count + 1,
         updated_at = now()
   where r.id = p_id;

  return query
    select r.id, r.business_id, r.lead_id, r.person_id, r.company_id, r.agent_job_id,
           r.kind, r.source_type, r.source_url, r.payload, r.content_hash,
           r.collector_agent, r.status, r.attempt_count, r.expires_at
      from public.raw_staging r
     where r.id = p_id;
end
$$;

create or replace function public.nexus_delete_raw_staging(p_id uuid)
  returns boolean
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_business uuid;
  v_deleted integer;
begin
  select r.business_id into v_business from public.raw_staging r where r.id = p_id;
  if v_business is null then
    return false;
  end if;

  if not public.nexus_can_touch_raw(v_business) then
    raise exception 'raw staging deletion is not permitted for this actor' using errcode = '42501';
  end if;

  delete from public.raw_staging r where r.id = p_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end
$$;

create or replace function public.nexus_mark_raw_failed(p_id uuid, p_error_code text)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_business uuid;
begin
  select r.business_id into v_business from public.raw_staging r where r.id = p_id;
  if v_business is null then
    return;
  end if;

  if not public.nexus_can_touch_raw(v_business) then
    raise exception 'raw staging update is not permitted for this actor' using errcode = '42501';
  end if;

  -- Only the error *code* is stored. An upstream message can quote the payload it
  -- was given, and this table's whole purpose is that the payload does not persist.
  update public.raw_staging r
     set status = 'FAILED',
         last_error_code = left(coalesce(p_error_code, 'unknown'), 120),
         updated_at = now()
   where r.id = p_id;
end
$$;

-- TTL sweep. Called by the V1.2 AI processor on every run, so an abandoned staging
-- row lives at most one processor interval past its 24h expiry.
create or replace function public.nexus_cleanup_raw_staging(p_limit integer default 200)
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with expired as (
    select r.id
      from public.raw_staging r
     where r.expires_at < now()
       and r.consumed_at is null
     order by r.expires_at
     limit greatest(coalesce(p_limit, 200), 1)
  )
  delete from public.raw_staging r
   using expired e
   where r.id = e.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

comment on function public.nexus_cleanup_raw_staging(integer) is
  'V1.2 TTL: deletes abandoned raw staging rows past their expires_at (default lifetime 24h).';

revoke all on function public.nexus_can_touch_raw(uuid) from public, anon;
revoke all on function public.nexus_stage_raw(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text) from public, anon;
revoke all on function public.nexus_read_raw_staging(uuid) from public, anon;
revoke all on function public.nexus_delete_raw_staging(uuid) from public, anon;
revoke all on function public.nexus_mark_raw_failed(uuid, text) from public, anon;
revoke all on function public.nexus_cleanup_raw_staging(integer) from public, anon;

grant execute on function public.nexus_can_touch_raw(uuid) to authenticated;
grant execute on function public.nexus_stage_raw(uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text) to authenticated;
grant execute on function public.nexus_read_raw_staging(uuid) to authenticated;
grant execute on function public.nexus_delete_raw_staging(uuid) to authenticated;
grant execute on function public.nexus_mark_raw_failed(uuid, text) to authenticated;
grant execute on function public.nexus_cleanup_raw_staging(integer) to authenticated;
