-- ============================================================================
-- NEXUS DB · 0008 — ingestion, imports, profile queue, duplicate review
--
-- Implements DB_CONTRACT.md §1.7 and invariants 5, 6
-- Spec
--   lead_sources.import_batch.must_track      (exact tracked fields)
--   lead_sources.import_batch.undo             (revert batch-exclusive records)
--   lead_sources.duplicate_review              (merge / keep separate / skip)
--   lead_sources.profile_queue_flow            (update the partial lead, never fork it)
--   api_contract.external_ingest              (envelope + idempotency key)
--   mcp_contract.write_requirements            (idempotency key when ingestion-related)
--   screen_inventory A05/A06/A07/A20
-- ============================================================================

-- ---------------------------------------------------------------------------
-- import_batches — idempotency_key unique when non-null (0010)
-- ---------------------------------------------------------------------------
create table if not exists public.import_batches (
  id                      uuid primary key default gen_random_uuid(),
  source                  text not null
                            constraint import_batches_source_check
                            check (source in ('file_csv', 'file_xlsx', 'paste_list', 'google_search', 'apollo_basic', 'external_ingest')),
  business                text,
  requested_primary_icp   text,
  created_count           integer not null default 0
                            constraint import_batches_created_check check (created_count >= 0),
  updated_count           integer not null default 0
                            constraint import_batches_updated_check check (updated_count >= 0),
  duplicate_count         integer not null default 0
                            constraint import_batches_duplicate_check check (duplicate_count >= 0),
  needs_profile_count     integer not null default 0
                            constraint import_batches_needs_profile_check check (needs_profile_count >= 0),
  failed_count            integer not null default 0
                            constraint import_batches_failed_check check (failed_count >= 0),
  skipped_count           integer not null default 0
                            constraint import_batches_skipped_check check (skipped_count >= 0),
  created_by              uuid references public.users (id),
  created_at              timestamptz not null default now(),
  business_id             uuid not null references public.businesses (id) on delete cascade,
  requested_icp_id        uuid references public.icps (id) on delete set null,
  auto_match              boolean not null default true,
  row_count               integer not null default 0
                            constraint import_batches_row_count_check check (row_count >= 0),
  status                  text not null default 'pending'
                            constraint import_batches_status_check
                            check (status in ('pending', 'running', 'completed', 'failed', 'undone')),
  undone_at               timestamptz,
  undone_by               uuid references public.users (id) on delete set null,
  idempotency_key         text,
  raw_summary             jsonb not null default '{}'::jsonb
);

comment on table public.import_batches is
  'spec lead_sources.import_batch — every ingestion requires Business + Primary ICP/Auto-match and runs dedupe before lead creation.';

create index if not exists import_batches_business_idx
  on public.import_batches (business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- import_rows
-- ---------------------------------------------------------------------------
create table if not exists public.import_rows (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references public.import_batches (id) on delete cascade,
  row_number   integer not null
                 constraint import_rows_row_number_check check (row_number >= 0),
  raw          jsonb not null default '{}'::jsonb,
  normalized   jsonb not null default '{}'::jsonb,
  result       text not null default 'pending'
                 constraint import_rows_result_check
                 check (result in ('pending', 'created', 'updated', 'duplicate', 'needs_profile', 'failed', 'skipped')),
  lead_id      uuid references public.leads (id) on delete set null,
  person_id    uuid references public.people (id) on delete set null,
  company_id   uuid references public.companies (id) on delete set null,
  message      text,
  created_at   timestamptz not null default now(),
  constraint import_rows_batch_row_key unique (batch_id, row_number)
);

create index if not exists import_rows_status_idx on public.import_rows (batch_id, result);

-- ---------------------------------------------------------------------------
-- profile_capture_queue — one open item per lead (0010)
-- ---------------------------------------------------------------------------
create table if not exists public.profile_capture_queue (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  lead_id          uuid not null references public.leads (id) on delete cascade,
  person_id        uuid references public.people (id) on delete set null,
  state            text not null default 'pending'
                     constraint profile_capture_queue_state_check
                     check (state in ('pending', 'in_progress', 'captured', 'skipped', 'failed')),
  reason           text,
  assigned_user_id uuid references public.users (id) on delete set null,
  captured_at      timestamptz,
  attempts         integer not null default 0
                     constraint profile_capture_queue_attempts_check check (attempts >= 0),
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists profile_capture_queue_business_idx
  on public.profile_capture_queue (business_id, state);

-- ---------------------------------------------------------------------------
-- duplicate_candidates
-- ---------------------------------------------------------------------------
create table if not exists public.duplicate_candidates (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  incoming_person_id  uuid references public.people (id) on delete cascade,
  existing_person_id  uuid references public.people (id) on delete cascade,
  existing_lead_id    uuid references public.leads (id) on delete set null,
  match_reason        text
                        constraint duplicate_candidates_match_reason_check
                        check (match_reason is null or match_reason in ('linkedin_url', 'company_domain', 'name_company_title', 'email', 'manual')),
  confidence          numeric(5, 4)
                        constraint duplicate_candidates_confidence_check
                        check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status              text not null default 'open'
                        constraint duplicate_candidates_status_check
                        check (status in ('open', 'merged', 'kept_separate', 'skipped')),
  resolution          text
                        constraint duplicate_candidates_resolution_check
                        check (resolution is null or resolution in ('merge', 'keep_separate', 'skip')),
  resolved_by         uuid references public.users (id) on delete set null,
  resolved_at         timestamptz,
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  constraint duplicate_candidates_resolution_check_pair
    check ((status = 'open') = (resolved_at is null))
);

create index if not exists duplicate_candidates_open_idx
  on public.duplicate_candidates (business_id, status);

-- ---------------------------------------------------------------------------
-- ingest_requests — invariant 6 (idempotency)
-- ---------------------------------------------------------------------------
create table if not exists public.ingest_requests (
  id               uuid primary key default gen_random_uuid(),
  source_client    text not null,
  business_id      uuid references public.businesses (id) on delete cascade,
  payload_type     text not null,
  idempotency_key  text not null,
  observed_at      timestamptz,
  payload          jsonb not null default '{}'::jsonb,
  content_hash     text,
  status           text not null default 'received'
                     constraint ingest_requests_status_check
                     check (status in ('received', 'processed', 'failed', 'duplicate')),
  result           jsonb not null default '{}'::jsonb,
  error            text,
  api_client_id    uuid,
  created_at       timestamptz not null default now(),
  constraint ingest_requests_idempotency_key unique (source_client, business_id, idempotency_key)
);

comment on table public.ingest_requests is
  'DB_CONTRACT.md §2 invariant 6 — the same (source_client, business_id, idempotency_key) can never be processed twice.';

create index if not exists ingest_requests_business_idx
  on public.ingest_requests (business_id, created_at desc);
