-- ============================================================================
-- NEXUS DB · 0002 — tenancy: users, teams, businesses, domains, access
--
-- Implements DB_CONTRACT.md §1.1
-- Spec
--   roles_and_permissions.roles                     (admin | manager | user)
--   business_units.*                                (business-scoped records)
--   admin_self_assignment_and_domains.*             (business domains, self-assignment)
--   data_model.indexes_and_uniqueness               (domain uniqueness)
--   screen_inventory A15/A16/A29/A30
--
-- ASSUMPTION: users.status values are not enumerated in the spec or in
-- packages/core/src/vocabulary.ts; the smallest reversible set is used and
-- documented in packages/db/README.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users — profile row keyed by auth.users.id (DB_CONTRACT.md §0)
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  full_name       text,
  role            text not null default 'user'
                    constraint users_role_check check (role in ('admin', 'manager', 'user')),
  status          text not null default 'active'
                    constraint users_status_check
                    check (status in ('active', 'invited', 'suspended', 'disabled')),
  avatar_url      text,
  timezone        text not null default 'UTC',
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

comment on table public.users is
  'DB_CONTRACT.md §1.1 — profile row; the credential row lives in auth.users with the same UUID.';

create unique index if not exists users_email_lower_key
  on public.users (lower(email));

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
create table if not exists public.businesses (
  id              uuid primary key default gen_random_uuid(),
  key             text not null,
  name            text not null,
  focus           text,
  regions         text[] not null default array[]::text[],
  status          text not null default 'active'
                    constraint businesses_status_check
                    check (status in ('active', 'archived', 'template')),
  is_template     boolean not null default false,
  settings        jsonb not null default '{}'::jsonb,
  notes           text,
  created_by      uuid references public.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint businesses_key_key unique (key),
  constraint businesses_key_slug_check check (key ~ '^[a-z0-9][a-z0-9-]*$')
);

comment on table public.businesses is
  'DB_CONTRACT.md §1.1 — one row per business unit; `key` is the URL slug used by /b/:businessSlug.';

-- ---------------------------------------------------------------------------
-- business_domains (invariants 12 + 13 — see 0010 for the partial unique)
-- ---------------------------------------------------------------------------
create table if not exists public.business_domains (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses (id) on delete cascade,
  domain             text not null,
  normalized_domain  text,
  domain_type        text not null default 'primary'
                       constraint business_domains_type_check
                       check (domain_type in ('primary', 'alias', 'parent_source', 'service')),
  is_default         boolean not null default false,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint business_domains_normalized_unique unique (normalized_domain)
);

comment on table public.business_domains is
  'spec admin_self_assignment_and_domains.business_domains — one primary business context per registered domain; never auto-merge leads across businesses.';

create index if not exists business_domains_business_idx
  on public.business_domains (business_id);

-- ---------------------------------------------------------------------------
-- user_business_access — the tenant predicate source
-- ---------------------------------------------------------------------------
create table if not exists public.user_business_access (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users (id) on delete cascade,
  business_id           uuid not null references public.businesses (id) on delete cascade,
  access_level          text not null default 'user'
                          constraint user_business_access_level_check
                          check (access_level in ('admin', 'manager', 'user')),
  can_manage_leads      boolean not null default true,
  can_use_lead_sources  boolean not null default false,
  can_use_profile_queue boolean not null default false,
  can_delete_leads      boolean not null default false,
  created_by            uuid references public.users (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint user_business_access_pair_key unique (user_id, business_id)
);

comment on table public.user_business_access is
  'DB_CONTRACT.md §1.1 — an explicit grant is required; visibility is never implied.';

create index if not exists user_business_access_business_idx
  on public.user_business_access (business_id);

-- ---------------------------------------------------------------------------
-- user_lead_scope — optional per-user lead scoping
-- ---------------------------------------------------------------------------
create table if not exists public.user_lead_scope (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  business_id  uuid not null references public.businesses (id) on delete cascade,
  mode         text not null default 'all'
                 constraint user_lead_scope_mode_check
                 check (mode in ('all', 'assigned', 'own')),
  icp_ids      uuid[] not null default array[]::uuid[],
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint user_lead_scope_pair_key unique (user_id, business_id)
);

-- ---------------------------------------------------------------------------
-- teams / team_members (business_id NULL = cross-business team)
-- ---------------------------------------------------------------------------
create table if not exists public.teams (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references public.businesses (id) on delete cascade,
  name         text not null,
  description  text,
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create table if not exists public.team_members (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  team_role   text not null default 'member'
                constraint team_members_role_check
                check (team_role in ('lead', 'manager', 'member')),
  created_at  timestamptz not null default now(),
  constraint team_members_pair_key unique (team_id, user_id)
);

create index if not exists team_members_user_idx on public.team_members (user_id);
