-- ============================================================================
-- NEXUS DB · 0009 — integrations, automation, audit, saved views, settings
--
-- Implements DB_CONTRACT.md §1.8, invariants 20
-- Spec
--   integrations.*                            (narrow authenticated gateway, no
--                                              raw DB credentials for agents)
--   mcp_contract.forbidden_tool                (database.execute_sql is forbidden)
--   mcp_contract.write_requirements            (actor/client identity + audit)
--   security_and_reliability.rules             (service role is server-only)
--   data_model.critical_fields.audit_events    (exact audit column set)
--   screen_inventory A18/A19/A21/A22
--   companion_extension.list_state_preservation (saved views)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- api_clients — scoped service tokens. Only a hash is ever stored.
-- ---------------------------------------------------------------------------
create table if not exists public.api_clients (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  kind                 text not null default 'rest_ingest'
                         constraint api_clients_kind_check
                         check (kind in ('mcp', 'rest_ingest', 'webhook', 'internal_worker')),
  token_hash           text not null,
  token_prefix         text,
  scopes               text[] not null default array[]::text[]
                         constraint api_clients_no_sql_scope_check
                         check (not (scopes && array['database.execute_sql', 'execute_sql', 'sql:execute']::text[])),
  business_ids         uuid[] not null default array[]::uuid[],
  is_active            boolean not null default true,
  last_used_at         timestamptz,
  expires_at           timestamptz,
  rate_limit_per_minute integer not null default 60
                         constraint api_clients_rate_limit_check check (rate_limit_per_minute > 0),
  created_by           uuid references public.users (id),
  created_at           timestamptz not null default now(),
  revoked_at           timestamptz,
  constraint api_clients_token_hash_key unique (token_hash)
);

comment on table public.api_clients is
  'DB_CONTRACT.md §1.8/§5 — api_clients.token_hash is the only stored credential; no plaintext token column exists. Scopes can never grant arbitrary SQL.';

-- used by ingest_requests / audit_events / agent_runs
alter table public.ingest_requests
  drop constraint if exists ingest_requests_api_client_fk;
alter table public.ingest_requests
  add constraint ingest_requests_api_client_fk
  foreign key (api_client_id) references public.api_clients (id) on delete set null;

-- ---------------------------------------------------------------------------
-- webhook_endpoints / webhook_deliveries
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_endpoints (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  name              text not null,
  url               text not null,
  secret_hash       text not null,
  events            text[] not null default array[]::text[],
  is_active         boolean not null default true,
  last_status       text,
  last_delivery_at  timestamptz,
  created_by        uuid references public.users (id),
  created_at        timestamptz not null default now()
);

create table if not exists public.webhook_deliveries (
  id             uuid primary key default gen_random_uuid(),
  endpoint_id    uuid not null references public.webhook_endpoints (id) on delete cascade,
  event          text not null,
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'pending'
                   constraint webhook_deliveries_status_check
                   check (status in ('pending', 'delivered', 'failed', 'dropped')),
  attempts       integer not null default 0
                   constraint webhook_deliveries_attempts_check check (attempts >= 0),
  response_code  integer,
  error          text,
  created_at     timestamptz not null default now(),
  delivered_at   timestamptz
);

create index if not exists webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);

-- ---------------------------------------------------------------------------
-- automation_configs / agent_runs
-- ---------------------------------------------------------------------------
create table if not exists public.automation_configs (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  name            text not null,
  runner          text not null
                    constraint automation_configs_runner_check
                    check (runner in ('browseros', 'opencode', 'n8n', 'other')),
  purpose         text,
  run_mode        text not null default 'manual'
                    constraint automation_configs_run_mode_check
                    check (run_mode in ('manual', 'scheduled', 'continuous')),
  schedule        text,
  source_type     text
                    constraint automation_configs_source_type_check
                    check (source_type is null or source_type in ('manual_add', 'manual_companion', 'file_csv', 'file_xlsx', 'paste_list', 'google_search', 'apollo_basic', 'external_ingest', 'mcp_agent', 'research_agent')),
  icp_id          uuid references public.icps (id) on delete set null,
  data_contract   jsonb not null default '{}'::jsonb,
  is_active       boolean not null default true,
  last_run_at     timestamptz,
  created_by      uuid references public.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.agent_runs (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses (id) on delete cascade,
  automation_config_id  uuid references public.automation_configs (id) on delete set null,
  api_client_id         uuid references public.api_clients (id) on delete set null,
  actor_user_id         uuid references public.users (id) on delete set null,
  agent_name            text not null,
  objective             text,
  state                 text not null default 'running'
                          constraint agent_runs_state_check
                          check (state in ('running', 'succeeded', 'failed', 'cancelled')),
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  summary               text,
  result                jsonb not null default '{}'::jsonb,
  error                 text,
  stats                 jsonb not null default '{}'::jsonb
);

create index if not exists agent_runs_business_idx on public.agent_runs (business_id, started_at desc);

-- ---------------------------------------------------------------------------
-- audit_events — append-only (invariant 20)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_events (
  id              uuid primary key default gen_random_uuid(),
  actor_type      text not null default 'system'
                    constraint audit_events_actor_type_check
                    check (actor_type in ('user', 'api_client', 'system', 'agent')),
  actor_id        uuid,
  business_id     uuid references public.businesses (id) on delete set null,
  entity_type     text not null,
  entity_id       uuid,
  action          text not null,
  before_json     jsonb,
  after_json      jsonb,
  source_client   text,
  api_client_id   uuid references public.api_clients (id) on delete set null,
  ip              text,
  user_agent      text,
  correlation_id  uuid,
  created_at      timestamptz not null default now()
);

comment on table public.audit_events is
  'spec security_and_reliability.rules — audit history is append-only and immutable in meaning.';

create index if not exists audit_events_business_idx
  on public.audit_events (business_id, created_at desc);
create index if not exists audit_events_entity_idx
  on public.audit_events (entity_type, entity_id, created_at desc);
create index if not exists audit_events_actor_idx
  on public.audit_events (actor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- saved_views — Companion list-state preservation
-- ---------------------------------------------------------------------------
create table if not exists public.saved_views (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  owner_user_id  uuid not null references public.users (id) on delete cascade,
  scope          text not null default 'leads'
                   constraint saved_views_scope_check
                   check (scope in ('leads', 'today', 'companion_leads')),
  name           text not null,
  filters        jsonb not null default '{}'::jsonb,
  sort           jsonb not null default '{}'::jsonb,
  is_shared      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint saved_views_owner_name_key unique (owner_user_id, business_id, scope, name)
);

-- ---------------------------------------------------------------------------
-- platform_settings — mirrors screen_inventory A22
-- ---------------------------------------------------------------------------
create table if not exists public.platform_settings (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references public.businesses (id) on delete cascade,
  key          text not null,
  value        jsonb not null default 'null'::jsonb,
  updated_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint platform_settings_business_key_key unique (business_id, key)
);

comment on table public.platform_settings is
  'spec screen_inventory A22 — security, retention, soft-delete, DNC suppression, uniqueness defaults, reply pause, dormant defaults. business_id NULL = global.';
