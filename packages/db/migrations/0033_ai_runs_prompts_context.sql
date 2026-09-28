-- ============================================================================
-- NEXUS DB - 0033 V1.2 AI runs, versioned prompts and context packs
--
-- Three tables that make the AI pipeline accountable without making it a
-- firehose:
--
--   * `ai_runs` is the usage/cost ledger and the cache index. One row per attempt,
--     with the normalised input hash, the prompt version, the model, the token
--     counts and the outcome. It deliberately has NO column for the request or the
--     response: the raw body is deleted after commit, and a ledger that kept a copy
--     would quietly undo that. `cache_hit` distinguishes a reuse from a call so
--     "why did this cost nothing" is answerable.
--
--   * `prompt_versions` already existed as global reference data. V1.2 extends it
--     additively with a nullable `business_id` (NULL = global default, set =
--     business override), the system instruction, sampling parameters, an output
--     ceiling and a schema reference, plus an `is_active` flag so a version can be
--     superseded without being deleted — history is the point of versioning.
--
--   * `ai_context_packs` caches the compact structured context a draft is built
--     from. The input hash is what makes the cache correct: same permanent facts +
--     same prompt version + same model reuses the pack; any change to the facts
--     invalidates it. Packs contain permanent facts only and never a raw body.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- prompt_versions — additive extension
-- ---------------------------------------------------------------------------
alter table public.prompt_versions
  add column if not exists business_id uuid references public.businesses (id) on delete cascade,
  add column if not exists system_prompt text,
  add column if not exists temperature numeric(3, 2),
  add column if not exists max_output_tokens integer,
  add column if not exists schema_ref text,
  add column if not exists is_active boolean not null default true,
  add column if not exists notes text,
  add column if not exists updated_at timestamptz not null default now();

comment on column public.prompt_versions.business_id is
  'V1.2: NULL = global default prompt, set = business override. Resolution prefers an active override, then the active global default.';

-- The V1.1 uniqueness was global (key, version). A business override with the same
-- key and version number would collide with the global default, so the constraint
-- is replaced by two partial uniques that encode the real rule. Dropping this
-- constraint destroys no data — it only widens what can be stored.
alter table public.prompt_versions
  drop constraint if exists prompt_versions_key_version_key;

create unique index if not exists prompt_versions_global_key_version
  on public.prompt_versions (key, version)
  where business_id is null;

create unique index if not exists prompt_versions_business_key_version
  on public.prompt_versions (business_id, key, version)
  where business_id is not null;

-- "At most one active version per (scope, key)" is deliberately NOT a unique index.
-- Existing deployments may already hold several rows for one key, and every one of
-- them becomes `is_active = true` the moment this column is added — so a unique
-- index here would fail on live data and block the migration. Activation is
-- therefore an application-level transaction (deactivate the siblings, activate the
-- chosen version, in one transaction) and `nexus_active_prompt` resolves the
-- highest active version, so a deployment that somehow holds two still behaves
-- deterministically rather than unpredictably.
create index if not exists prompt_versions_active_lookup
  on public.prompt_versions (key, business_id, version desc)
  where is_active;

alter table public.prompt_versions
  drop constraint if exists prompt_versions_temperature_check;
alter table public.prompt_versions
  add constraint prompt_versions_temperature_check
  check (temperature is null or (temperature >= 0 and temperature <= 2));

alter table public.prompt_versions
  drop constraint if exists prompt_versions_max_output_check;
alter table public.prompt_versions
  add constraint prompt_versions_max_output_check
  check (max_output_tokens is null or (max_output_tokens > 0 and max_output_tokens <= 32000));

drop trigger if exists prompt_versions_touch_updated_at on public.prompt_versions;
create trigger prompt_versions_touch_updated_at
  before update on public.prompt_versions
  for each row execute function public.touch_updated_at();

-- Visibility: a global prompt is readable by any signed-in actor (as in V1.1); a
-- business override only by someone with access to that business. Writing is
-- admin-only, which is what makes "activate a version" an administrative act.
drop policy if exists prompt_versions_select on public.prompt_versions;
create policy prompt_versions_select on public.prompt_versions
  for select to authenticated
  using (
    public.is_admin()
    or business_id is null
    or public.has_business_access(business_id)
  );

drop policy if exists prompt_versions_write on public.prompt_versions;
create policy prompt_versions_write on public.prompt_versions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Resolution function: the rule the application must not re-implement.
create or replace function public.nexus_active_prompt(p_key text, p_business_id uuid)
  returns table (
    id uuid,
    key text,
    version integer,
    business_id uuid,
    purpose text,
    template text,
    system_prompt text,
    model text,
    temperature numeric,
    max_output_tokens integer,
    schema_ref text
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  with candidates as (
    select p.*,
           case when p.business_id is not null then 0 else 1 end as scope_rank
      from public.prompt_versions p
     where p.key = p_key
       and p.is_active
       and (p.business_id is null or p.business_id = p_business_id)
  )
  select c.id, c.key, c.version, c.business_id, c.purpose, c.template,
         c.system_prompt, c.model, c.temperature, c.max_output_tokens, c.schema_ref
    from candidates c
   order by c.scope_rank, c.version desc
   limit 1;
$$;

comment on function public.nexus_active_prompt(text, uuid) is
  'V1.2 prompt resolution: an active business override wins, otherwise the active global default.';

-- ---------------------------------------------------------------------------
-- ai_runs — the usage / cost ledger and the cache index
-- ---------------------------------------------------------------------------
create table if not exists public.ai_runs (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  task                text not null
                        constraint ai_runs_task_check
                        check (task in (
                          'PROFILE_EXTRACTION', 'COMPANY_EXTRACTION', 'SIGNAL_EXTRACTION',
                          'ICP_QUALIFICATION', 'CONTEXT_BUILD', 'MESSAGE_DRAFT',
                          'REPLY_CLASSIFICATION'
                        )),
  lead_id             uuid references public.leads (id) on delete set null,
  person_id           uuid references public.people (id) on delete set null,
  company_id          uuid references public.companies (id) on delete set null,
  agent_job_id        uuid references public.agent_jobs (id) on delete set null,
  message_instance_id uuid references public.message_instances (id) on delete set null,
  provider            text not null default 'deepseek',
  model               text,
  prompt_key          text,
  prompt_version_id   uuid references public.prompt_versions (id) on delete set null,
  prompt_version      integer,
  input_hash          text not null,
  status              text not null default 'PENDING'
                        constraint ai_runs_status_check
                        check (status in ('PENDING', 'SUCCEEDED', 'FAILED', 'CACHED', 'SKIPPED')),
  cache_hit           boolean not null default false,
  tokens_in           integer,
  tokens_out          integer,
  estimated_cost_usd  numeric(12, 6),
  duration_ms         integer,
  attempt             integer not null default 1,
  error_code          text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  constraint ai_runs_tokens_check
    check ((tokens_in is null or tokens_in >= 0) and (tokens_out is null or tokens_out >= 0))
);

comment on table public.ai_runs is
  'V1.2 AI ledger: one row per task attempt or cache reuse. Never stores the request or the response body.';

-- The cache index. Partial on SUCCEEDED so a failed attempt can never be reused as
-- an answer, and keyed on exactly the four things that define "same input".
create unique index if not exists ai_runs_cache_key
  on public.ai_runs (business_id, task, coalesce(prompt_version_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(model, ''), input_hash)
  where status = 'SUCCEEDED' and cache_hit = false;

create index if not exists ai_runs_business_task_idx
  on public.ai_runs (business_id, task, created_at desc);

create index if not exists ai_runs_business_day_idx
  on public.ai_runs (business_id, created_at desc);

create index if not exists ai_runs_job_idx
  on public.ai_runs (agent_job_id, created_at desc);

create index if not exists ai_runs_lead_idx
  on public.ai_runs (lead_id, created_at desc);

create index if not exists ai_runs_input_hash_idx
  on public.ai_runs (business_id, task, input_hash);

alter table public.ai_runs enable row level security;
alter table public.ai_runs force row level security;

drop policy if exists ai_runs_select on public.ai_runs;
create policy ai_runs_select on public.ai_runs
  for select to authenticated
  using (public.has_business_access(business_id));

drop policy if exists ai_runs_insert on public.ai_runs;
create policy ai_runs_insert on public.ai_runs
  for insert to authenticated
  with check (public.has_business_access(business_id));

-- The processor writes the completion of a run it started, so UPDATE is allowed
-- inside the same business scope. DELETE is not: a ledger that can be edited is
-- not a ledger.
drop policy if exists ai_runs_update on public.ai_runs;
create policy ai_runs_update on public.ai_runs
  for update to authenticated
  using (public.has_business_access(business_id))
  with check (public.has_business_access(business_id));

grant select, insert, update on public.ai_runs to authenticated;
revoke delete, truncate on public.ai_runs from authenticated;

-- ---------------------------------------------------------------------------
-- ai_context_packs
-- ---------------------------------------------------------------------------
create table if not exists public.ai_context_packs (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  lead_id             uuid not null references public.leads (id) on delete cascade,
  version             integer not null default 1
                        constraint ai_context_packs_version_check
                        check (version > 0),
  input_hash          text not null,
  pack                jsonb not null,
  -- The permanent facts the pack was built from, hashed. Stored beside the hash so
  -- a cache miss can be explained without re-reading a raw body that no longer
  -- exists. Contains no raw text.
  source_summary      jsonb not null default '{}'::jsonb,
  generated_by_run_id uuid references public.ai_runs (id) on delete set null,
  model               text,
  prompt_version_id   uuid references public.prompt_versions (id) on delete set null,
  created_by          uuid references public.users (id),
  created_at          timestamptz not null default now(),
  constraint ai_context_packs_lead_hash_key unique (lead_id, input_hash)
);

comment on table public.ai_context_packs is
  'V1.2 cached AI context for a lead: permanent facts only, keyed by the hash of those facts.';

create index if not exists ai_context_packs_lead_idx
  on public.ai_context_packs (lead_id, created_at desc);

create index if not exists ai_context_packs_business_idx
  on public.ai_context_packs (business_id, created_at desc);

alter table public.ai_context_packs enable row level security;
alter table public.ai_context_packs force row level security;

drop policy if exists ai_context_packs_select on public.ai_context_packs;
create policy ai_context_packs_select on public.ai_context_packs
  for select to authenticated
  using (public.has_business_access(business_id));

drop policy if exists ai_context_packs_insert on public.ai_context_packs;
create policy ai_context_packs_insert on public.ai_context_packs
  for insert to authenticated
  with check (public.has_business_access(business_id));

drop policy if exists ai_context_packs_update on public.ai_context_packs;
create policy ai_context_packs_update on public.ai_context_packs
  for update to authenticated
  using (public.has_business_access(business_id))
  with check (public.has_business_access(business_id));

drop policy if exists ai_context_packs_delete on public.ai_context_packs;
create policy ai_context_packs_delete on public.ai_context_packs
  for delete to authenticated
  using (public.has_business_access(business_id));

grant select, insert, update, delete on public.ai_context_packs to authenticated;

revoke all on function public.nexus_active_prompt(text, uuid) from public, anon;
grant execute on function public.nexus_active_prompt(text, uuid) to authenticated;
