-- ============================================================================
-- NEXUS DB - 0030 V1.2 channel accounts and person contact points
--
-- V1.1 modelled outreach around a single LinkedIn identity. V1.2 must support
-- four outreach channels — linkedin, email, instagram, upwork — without losing
-- any historical sender attribution and without a destructive rename.
--
-- Two additive changes:
--
--   1. `outreach_identities.channel` states which outreach channel an account
--      actually sends on, backfilled from the legacy `platform`. The platform
--      CHECK is widened (never narrowed) so existing rows keep validating and a
--      stored `platform` value is preserved verbatim for history and reporting.
--      `public.channel_accounts` is a SECURITY INVOKER view over the same rows,
--      so the product vocabulary can move to "Channel Accounts" while the
--      underlying table, its RLS policies, its triggers and every foreign key
--      that references it stay exactly as they are.
--
--   2. `person_contact_points` records the contact points a canonical Person is
--      reachable at, with provenance and confidence. The canonical Person row is
--      unchanged; email(s) and social handles live here rather than in new
--      columns on `people`, so a person can accumulate several addresses from
--      several sources without overwriting the confirmed one.
--
-- Discovery sources and outreach channels are deliberately separate concepts:
-- nothing here constrains which channel a lead discovered on one source may be
-- contacted through.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- outreach_identities.channel
-- ---------------------------------------------------------------------------
alter table public.outreach_identities
  add column if not exists channel text;

-- Backfill from the legacy platform value. `twitter` has no V1.2 channel, so it
-- maps to 'other' — the row survives, it simply is not one of the four channels
-- the product now schedules outreach on.
update public.outreach_identities
   set channel = case platform
                   when 'linkedin' then 'linkedin'
                   when 'email'    then 'email'
                   when 'instagram' then 'instagram'
                   when 'upwork'   then 'upwork'
                   else 'other'
                 end
 where channel is null;

alter table public.outreach_identities
  alter column channel set default 'linkedin';
alter table public.outreach_identities
  alter column channel set not null;

alter table public.outreach_identities
  drop constraint if exists outreach_identities_channel_check;
alter table public.outreach_identities
  add constraint outreach_identities_channel_check
  check (channel in ('linkedin', 'email', 'instagram', 'upwork', 'other'));

-- Widen, never narrow: instagram and upwork become first-class platforms while
-- every previously valid value keeps validating.
alter table public.outreach_identities
  drop constraint if exists outreach_identities_platform_check;
alter table public.outreach_identities
  add constraint outreach_identities_platform_check
  check (platform in ('linkedin', 'email', 'instagram', 'upwork', 'twitter', 'other'));

comment on column public.outreach_identities.channel is
  'V1.2 outreach channel (linkedin|email|instagram|upwork|other). `platform` is retained for historical attribution.';

create index if not exists outreach_identities_channel_idx
  on public.outreach_identities (channel, status)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- channel_accounts — the product-facing name for an outreach identity
--
-- SECURITY INVOKER is required: the view must not become a way around the RLS
-- policies on `outreach_identities`. A caller sees exactly the rows the table
-- policy already allows.
-- ---------------------------------------------------------------------------
create or replace view public.channel_accounts
  with (security_invoker = true) as
select
  i.id,
  i.channel,
  i.platform,
  i.display_name,
  i.profile_url,
  i.normalized_profile_url,
  i.managed_by_user_id,
  i.status,
  i.daily_target,
  i.daily_sent_count,
  i.notes,
  i.created_at,
  i.updated_at,
  i.deleted_at
from public.outreach_identities i;

comment on view public.channel_accounts is
  'V1.2 vocabulary for outreach_identities: one account per (channel, display_name). Inherits the table RLS through security_invoker.';

grant select on public.channel_accounts to authenticated;

-- ---------------------------------------------------------------------------
-- person_contact_points
-- ---------------------------------------------------------------------------
create table if not exists public.person_contact_points (
  id                uuid primary key default gen_random_uuid(),
  person_id         uuid not null references public.people (id) on delete cascade,
  kind              text not null
                      constraint person_contact_points_kind_check
                      check (kind in ('email', 'linkedin', 'instagram', 'upwork', 'phone', 'website', 'other')),
  value             text not null,
  -- Lower-cased email, canonicalised profile URL, digits-only phone. Uniqueness
  -- is on the normalised form so `Sarah@Acme.com` cannot be stored twice, while
  -- the original `value` is preserved for display and evidence.
  normalized_value  text not null,
  label             text,
  is_primary        boolean not null default false,
  confidence        numeric(5, 4) not null default 0.5000
                      constraint person_contact_points_confidence_check
                      check (confidence >= 0 and confidence <= 1),
  source            text not null,
  source_url        text,
  observed_at       timestamptz not null default now(),
  -- Set when a human confirmed the value in the product. AI extraction must never
  -- flip this to true, and merge precedence treats a confirmed value as
  -- authoritative (V1.2 merge-safety rule 1).
  confirmed_by_user boolean not null default false,
  agent_job_id      uuid,
  created_by        uuid references public.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  constraint person_contact_points_value_key unique (person_id, kind, normalized_value)
);

comment on table public.person_contact_points is
  'V1.2 contact points for a canonical Person (email, LinkedIn, Instagram, Upwork, phone, site) with provenance and confidence.';

create index if not exists person_contact_points_person_idx
  on public.person_contact_points (person_id, kind)
  where deleted_at is null;

create index if not exists person_contact_points_normalized_idx
  on public.person_contact_points (kind, normalized_value)
  where deleted_at is null;

-- One primary address per (person, kind): the display rule is "the primary email",
-- and two primaries would make the choice depend on row order.
create unique index if not exists person_contact_points_one_primary
  on public.person_contact_points (person_id, kind)
  where is_primary and deleted_at is null;

alter table public.person_contact_points enable row level security;
alter table public.person_contact_points force row level security;

-- Visibility follows the canonical person: whoever may see the person may see the
-- way to reach them. `person_visible` is SECURITY DEFINER, so this policy never
-- recurses through the leads policy.
drop policy if exists person_contact_points_select on public.person_contact_points;
create policy person_contact_points_select on public.person_contact_points
  for select to authenticated
  using (public.person_visible(person_id));

drop policy if exists person_contact_points_insert on public.person_contact_points;
create policy person_contact_points_insert on public.person_contact_points
  for insert to authenticated
  with check (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  );

drop policy if exists person_contact_points_update on public.person_contact_points;
create policy person_contact_points_update on public.person_contact_points
  for update to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.user_business_access a
       where a.user_id = public.current_user_id() and a.can_use_lead_sources
    )
    or public.acting_api_client_id() is not null
  );

drop policy if exists person_contact_points_delete on public.person_contact_points;
create policy person_contact_points_delete on public.person_contact_points
  for delete to authenticated
  using (public.is_admin());

-- 0014 granted on "all tables in schema public", which only covered the tables that
-- existed then; this one is newer, so its base grants are stated here.
grant select, insert, update on public.person_contact_points to authenticated;
revoke delete, truncate on public.person_contact_points from authenticated;
