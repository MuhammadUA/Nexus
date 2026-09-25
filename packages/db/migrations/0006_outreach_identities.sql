-- ============================================================================
-- NEXUS DB · 0006 — outreach identities and browser sessions
--
-- Implements DB_CONTRACT.md §1.5
-- Spec
--   identity_model.outreach_identity.fields      (exact field list)
--   identity_model.browser_session.fields        (exact field list)
--   identity_model.conversation_ownership        (first sender owns the channel)
--   identity_model.duplicate_outreach_warning     (prior sender must be visible)
--   roles_and_permissions.same_user_multiple_browsers
--   admin_self_assignment_and_domains.admin_self_assignment
--   DB_CONTRACT.md §2 invariant 14/15
--
-- ASSUMPTION: the "concurrent use of the same outreach identity" setting is
-- enforced by a partial unique index on active browser sessions (0010); allowing
-- concurrency requires dropping that index. Documented in README.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- outreach_identities
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_identities (
  id                          uuid primary key default gen_random_uuid(),
  platform                    text not null default 'linkedin'
                                constraint outreach_identities_platform_check
                                check (platform in ('linkedin', 'email', 'twitter', 'other')),
  display_name                text not null,
  profile_url                 text,
  managed_by_user_id          uuid references public.users (id) on delete set null,
  status                      text not null default 'active'
                                constraint outreach_identities_status_check
                                check (status in ('active', 'paused', 'retired')),
  daily_target                integer not null default 0
                                constraint outreach_identities_daily_target_check
                                check (daily_target >= 0),
  optional_browser_profile_id text,
  normalized_profile_url      text,
  daily_sent_count            integer not null default 0
                                constraint outreach_identities_daily_sent_check
                                check (daily_sent_count >= 0),
  daily_count_reset_at        timestamptz,
  notes                       text,
  created_by                  uuid references public.users (id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  deleted_at                  timestamptz
);

comment on table public.outreach_identities is
  'spec identity_model — CRM lead owner, actual sender identity and business are separate dimensions and may differ.';

create index if not exists outreach_identities_owner_idx
  on public.outreach_identities (managed_by_user_id, status);

-- ---------------------------------------------------------------------------
-- outreach_identity_business_access — invariant 14
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_identity_business_access (
  outreach_identity_id uuid not null references public.outreach_identities (id) on delete cascade,
  business_id          uuid not null references public.businesses (id) on delete cascade,
  created_by           uuid references public.users (id),
  created_at           timestamptz not null default now(),
  primary key (outreach_identity_id, business_id)
);

comment on table public.outreach_identity_business_access is
  'DB_CONTRACT.md §2 invariant 14 — each outreach identity has its own business access; Companion visibility is the intersection with user access.';

-- ---------------------------------------------------------------------------
-- browser_sessions — invariant 15
-- ---------------------------------------------------------------------------
create table if not exists public.browser_sessions (
  id                                 uuid primary key default gen_random_uuid(),
  user_id                            uuid not null references public.users (id) on delete cascade,
  browser_fingerprint_or_install_id  text not null,
  outreach_identity_id               uuid references public.outreach_identities (id) on delete set null,
  default_business_id                uuid references public.businesses (id) on delete set null,
  last_active_at                     timestamptz not null default now(),
  status                             text not null default 'active'
                                       constraint browser_sessions_status_check
                                       check (status in ('active', 'idle', 'revoked')),
  user_agent                         text,
  created_at                         timestamptz not null default now(),
  revoked_at                         timestamptz
);

comment on table public.browser_sessions is
  'spec identity_model.browser_session.rule — binding a browser does not change canonical lead ownership.';

create index if not exists browser_sessions_user_idx on public.browser_sessions (user_id, status);

-- ---------------------------------------------------------------------------
-- identity_transfers — explicit confirmation + audit event required
-- ---------------------------------------------------------------------------
create table if not exists public.identity_transfers (
  id                   uuid primary key default gen_random_uuid(),
  outreach_identity_id uuid not null references public.outreach_identities (id) on delete cascade,
  from_user_id         uuid references public.users (id) on delete set null,
  to_user_id           uuid references public.users (id) on delete set null,
  actor_user_id        uuid references public.users (id) on delete set null,
  confirmed            boolean not null default false,
  note                 text,
  created_at           timestamptz not null default now(),
  constraint identity_transfers_confirmation_check
    check (confirmed = true or from_user_id is null)
);

comment on table public.identity_transfers is
  'spec admin_self_assignment_and_domains.admin_self_assignment — occupying an identity owned by someone else requires explicit confirmation.';
