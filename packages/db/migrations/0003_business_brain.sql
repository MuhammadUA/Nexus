-- ============================================================================
-- NEXUS DB · 0003 — Business Brain and knowledge
--
-- Implements DB_CONTRACT.md §1.2
-- Spec
--   business_brain_and_knowledge.*        (assets, fields, ingestion, versioning,
--                                          claim policy, retrieval)
--   signals_and_scoring.configurable_per_icp ("scores are configuration")
--   messaging_rules.*                     (approved offers, CTA style)
--   screen_inventory A11/A12/A14
--
-- ASSUMPTION: knowledge_assets.current_version_id is a forward reference to
-- knowledge_asset_versions; the FK is added in 0010 once both tables exist.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- personas
-- ---------------------------------------------------------------------------
create table if not exists public.personas (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  name         text not null,
  description  text,
  pain_points  text[] not null default array[]::text[],
  goals        text[] not null default array[]::text[],
  approved     boolean not null default false,
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create index if not exists personas_business_idx on public.personas (business_id);

-- ---------------------------------------------------------------------------
-- offers
-- ---------------------------------------------------------------------------
create table if not exists public.offers (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  name         text not null,
  description  text,
  positioning  text,
  cta_style    text,
  approved     boolean not null default false,
  version      integer not null default 1
                 constraint offers_version_check check (version > 0),
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create index if not exists offers_business_idx on public.offers (business_id);

-- ---------------------------------------------------------------------------
-- services
-- ---------------------------------------------------------------------------
create table if not exists public.services (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  name         text not null,
  description  text,
  category     text,
  approved     boolean not null default false,
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create index if not exists services_business_idx on public.services (business_id);

-- ---------------------------------------------------------------------------
-- value_propositions (persona_id / icp_id nullable; icp FK added in 0010)
-- ---------------------------------------------------------------------------
create table if not exists public.value_propositions (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  persona_id        uuid references public.personas (id) on delete set null,
  icp_id            uuid,
  statement         text not null,
  proof_required    boolean not null default false,
  approved          boolean not null default false,
  created_by        uuid references public.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create index if not exists value_propositions_business_idx
  on public.value_propositions (business_id);

-- ---------------------------------------------------------------------------
-- prompt_versions (global reference data)
-- ---------------------------------------------------------------------------
create table if not exists public.prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  version     integer not null constraint prompt_versions_version_check check (version > 0),
  purpose     text,
  template    text not null,
  model       text,
  created_by  uuid references public.users (id),
  created_at  timestamptz not null default now(),
  constraint prompt_versions_key_version_key unique (key, version)
);

-- ---------------------------------------------------------------------------
-- knowledge_assets (+ versions, extractions, tags)
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_assets (
  id                           uuid primary key default gen_random_uuid(),
  business_id                  uuid not null references public.businesses (id) on delete cascade,
  type                         text not null
                                 constraint knowledge_assets_type_check
                                 check (type in (
                                   'Portfolio', 'Case Study', 'Service', 'Offer', 'Pricing',
                                   'Testimonial', 'Process', 'Web Page', 'Document',
                                   'Video / YouTube', 'Other proof'
                                 )),
  url                          text,
  title                        text,
  description                  text,
  tags                         text[] not null default array[]::text[],
  ai_use_allowed               boolean not null default false,
  may_mention_client_name      boolean not null default false,
  may_mention_numeric_results  boolean not null default false,
  approval_state               text not null default 'draft'
                                 constraint knowledge_assets_approval_state_check
                                 check (approval_state in (
                                   'draft', 'extracting', 'needs_review',
                                   'approved', 'rejected', 'superseded'
                                 )),
  current_version_id           uuid,
  created_by                   uuid references public.users (id),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  deleted_at                   timestamptz
);

comment on table public.knowledge_assets is
  'spec business_brain_and_knowledge — outbound may use only approved factual claims; claims never invented.';

create index if not exists knowledge_assets_business_idx
  on public.knowledge_assets (business_id, approval_state);

create table if not exists public.knowledge_asset_versions (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.knowledge_assets (id) on delete cascade,
  version       integer not null constraint knowledge_asset_versions_version_check check (version > 0),
  content_hash  text not null,
  raw_content   text,
  extracted     jsonb not null default '{}'::jsonb,
  created_by    uuid references public.users (id),
  created_at    timestamptz not null default now(),
  constraint knowledge_asset_versions_asset_version_key unique (asset_id, version)
);

create index if not exists knowledge_asset_versions_asset_idx
  on public.knowledge_asset_versions (asset_id);

create table if not exists public.asset_extractions (
  id                uuid primary key default gen_random_uuid(),
  asset_version_id  uuid not null references public.knowledge_asset_versions (id) on delete cascade,
  kind              text not null
                      constraint asset_extractions_kind_check
                      check (kind in ('case_study', 'youtube', 'generic')),
  fields            jsonb not null default '{}'::jsonb,
  confidence        numeric(5, 4)
                      constraint asset_extractions_confidence_check
                      check (confidence is null or (confidence >= 0 and confidence <= 1)),
  model             text,
  prompt_version_id uuid references public.prompt_versions (id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists asset_extractions_version_idx
  on public.asset_extractions (asset_version_id);

create table if not exists public.asset_tags (
  asset_id  uuid not null references public.knowledge_assets (id) on delete cascade,
  tag       text not null,
  weight    numeric(6, 3) not null default 1,
  primary key (asset_id, tag)
);

-- ---------------------------------------------------------------------------
-- scoring_rules (spec signals_and_scoring — scores are configuration)
-- ---------------------------------------------------------------------------
create table if not exists public.scoring_rules (
  id           uuid primary key default gen_random_uuid(),
  target_type  text not null
                 constraint scoring_rules_target_type_check
                 check (target_type in ('icp', 'business', 'global')),
  target_id    uuid,
  signal_kind  text not null
                 constraint scoring_rules_signal_kind_check
                 check (signal_kind in (
                   'hiring', 'contractor_need', 'content_output', 'geography_size',
                   'rfp_tender', 'funding', 'technology', 'leadership_change',
                   'negative_recruitment', 'negative_wedding_only',
                   'negative_stale_vacancy', 'negative_geography', 'custom'
                 )),
  polarity     text not null
                 constraint scoring_rules_polarity_check
                 check (polarity in ('positive', 'negative', 'neutral')),
  points       integer not null,
  label        text,
  is_active    boolean not null default true,
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint scoring_rules_target_check
    check ((target_type = 'global' and target_id is null) or (target_type <> 'global'))
);

create index if not exists scoring_rules_target_idx
  on public.scoring_rules (target_type, target_id, is_active);
