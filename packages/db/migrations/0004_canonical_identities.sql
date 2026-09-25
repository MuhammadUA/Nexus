-- ============================================================================
-- NEXUS DB · 0004 — canonical global identities
--
-- Implements DB_CONTRACT.md §1.3
-- Spec
--   identity_model.canonical_global_entities   (Company, Person, SocialProfile)
--   lead_invariants                            (normalized LinkedIn URL / company
--                                               domain are the strongest dedupe keys;
--                                               rediscovery adds evidence, never a
--                                               duplicate Person/Company)
--   integrations.youtube_linkedin_unification  (no separate lead databases)
--   security_and_reliability.rules             (provenance, observed_at,
--                                               captured_at, confidence, hash)
--
-- These tables are GLOBAL (no business_id). Visibility is derived from the
-- business-scoped leads that reference them — see public.person_visible() /
-- public.company_visible() in 0001 and the policies in 0013.
--
-- ASSUMPTION: social_profiles.platform reuses the OUTREACH_PLATFORMS value list
-- from packages/core/src/vocabulary.ts; adding a platform is a data migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
create table if not exists public.companies (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  normalized_name        text,
  normalized_domain      text,
  primary_domain         text,
  industry               text,
  employee_count         integer
                           constraint companies_employee_count_check
                           check (employee_count is null or employee_count >= 0),
  hq_country             text,
  linkedin_url           text,
  normalized_linkedin_url text,
  description            text,
  created_by             uuid references public.users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);

comment on table public.companies is
  'DB_CONTRACT.md §1.3 — canonical/global; normalized_domain is the strongest company dedupe key.';

-- ---------------------------------------------------------------------------
-- people
-- ---------------------------------------------------------------------------
create table if not exists public.people (
  id                      uuid primary key default gen_random_uuid(),
  full_name               text not null,
  normalized_name         text,
  first_name              text,
  last_name               text,
  headline                text,
  job_title               text,
  location                text,
  primary_email           text,
  normalized_linkedin_url text,
  linkedin_url            text,
  company_id              uuid references public.companies (id) on delete set null,
  profile_captured_at     timestamptz,
  created_by              uuid references public.users (id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);

comment on table public.people is
  'DB_CONTRACT.md §1.3 — canonical/global; one Person may be a Lead in many businesses.';

create index if not exists people_normalized_name_idx on public.people (normalized_name);
create index if not exists people_company_idx on public.people (company_id);

-- ---------------------------------------------------------------------------
-- social_profiles — exactly one owner (person XOR company)
-- ---------------------------------------------------------------------------
create table if not exists public.social_profiles (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid references public.people (id) on delete cascade,
  company_id      uuid references public.companies (id) on delete cascade,
  platform        text not null
                    constraint social_profiles_platform_check
                    check (platform in ('linkedin', 'email', 'twitter', 'other')),
  profile_url     text not null,
  normalized_url  text not null,
  handle          text,
  source          text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint social_profiles_owner_check
    check (((person_id is not null)::integer + (company_id is not null)::integer) = 1),
  constraint social_profiles_platform_url_key unique (platform, normalized_url)
);

create index if not exists social_profiles_person_idx on public.social_profiles (person_id);
create index if not exists social_profiles_company_idx on public.social_profiles (company_id);

-- ---------------------------------------------------------------------------
-- signals — business_id NULL means a global signal
-- ---------------------------------------------------------------------------
create table if not exists public.signals (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references public.businesses (id) on delete cascade,
  company_id   uuid references public.companies (id) on delete cascade,
  person_id    uuid references public.people (id) on delete cascade,
  lead_id      uuid,
  kind         text not null
                 constraint signals_kind_check
                 check (kind in (
                   'hiring', 'contractor_need', 'content_output', 'geography_size',
                   'rfp_tender', 'funding', 'technology', 'leadership_change',
                   'negative_recruitment', 'negative_wedding_only',
                   'negative_stale_vacancy', 'negative_geography', 'custom'
                 )),
  polarity     text not null default 'neutral'
                 constraint signals_polarity_check
                 check (polarity in ('positive', 'negative', 'neutral')),
  strength     integer not null default 0
                 constraint signals_strength_check
                 check (strength between -100 and 100),
  label        text,
  detail       text,
  observed_at  timestamptz not null default now(),
  expires_at   timestamptz,
  is_active    boolean not null default true,
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  constraint signals_subject_check
    check (company_id is not null or person_id is not null or lead_id is not null)
);

comment on table public.signals is
  'DB_CONTRACT.md §2 invariant 5 — signals stay append-only; rediscovery adds a row rather than mutating history.';

create index if not exists signals_business_kind_idx on public.signals (business_id, kind, is_active);
create index if not exists signals_person_idx on public.signals (person_id, observed_at desc);
create index if not exists signals_company_idx on public.signals (company_id, observed_at desc);
create index if not exists signals_lead_idx on public.signals (lead_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- source_evidence — provenance is mandatory (invariant 18)
-- ---------------------------------------------------------------------------
create table if not exists public.source_evidence (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  person_id         uuid references public.people (id) on delete set null,
  company_id        uuid references public.companies (id) on delete set null,
  lead_id           uuid,
  source            text not null,
  source_url        text,
  raw_text_or_json  text,
  content_hash      text not null,
  observed_at       timestamptz not null,
  captured_at       timestamptz not null default now(),
  confidence        numeric(5, 4) not null
                      constraint source_evidence_confidence_check
                      check (confidence >= 0 and confidence <= 1),
  created_by        uuid references public.users (id),
  created_at        timestamptz not null default now(),
  constraint source_evidence_business_hash_key unique (business_id, content_hash)
);

comment on table public.source_evidence is
  'DB_CONTRACT.md §2 invariants 5 + 18 — rediscovery inserts new evidence; source/observed_at/content_hash/confidence are NOT NULL.';

create index if not exists source_evidence_person_idx on public.source_evidence (person_id);
create index if not exists source_evidence_lead_idx on public.source_evidence (lead_id);
create index if not exists source_evidence_observed_idx
  on public.source_evidence (business_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- research_snapshots
-- ---------------------------------------------------------------------------
create table if not exists public.research_snapshots (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  lead_id           uuid,
  person_id         uuid references public.people (id) on delete set null,
  company_id        uuid references public.companies (id) on delete set null,
  summary           text,
  findings          jsonb not null default '{}'::jsonb,
  model             text,
  prompt_version_id uuid references public.prompt_versions (id) on delete set null,
  created_by        uuid references public.users (id),
  created_at        timestamptz not null default now()
);

create index if not exists research_snapshots_lead_idx
  on public.research_snapshots (lead_id, created_at desc);
