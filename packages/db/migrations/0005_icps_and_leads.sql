-- ============================================================================
-- NEXUS DB · 0005 — ICPs and the business-scoped CRM core
--
-- Implements DB_CONTRACT.md §1.4 and the lead invariants of §2
-- Spec
--   lead_invariants.*                     (one active lead per person/business,
--                                          one primary ICP, audited ICP change)
--   lead_lifecycle.states                 (packed into the leads.status CHECK)
--   lead_sources.*                        (source_type vocabulary)
--   tasks_and_my_day.task_fields          (exact task fields)
--   reply_and_notes.*                     (internal note separate from inbound)
--   screen_inventory A03/A04/A09/A12
--
-- ASSUMPTION: interactions.direction values are not enumerated by the spec or by
-- packages/core/src/vocabulary.ts; ('outbound','inbound','internal') is the
-- smallest reversible set and is documented in README.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- icps
-- ---------------------------------------------------------------------------
create table if not exists public.icps (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references public.businesses (id) on delete cascade,
  name                 text not null,
  description          text,
  criteria             jsonb not null default '{}'::jsonb,
  is_default           boolean not null default false,
  is_active            boolean not null default true,
  scoring_overrides    jsonb not null default '{}'::jsonb,
  default_sequence_id  uuid,
  routing              jsonb not null default '{}'::jsonb,
  created_by           uuid references public.users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

comment on table public.icps is
  'spec screen_inventory A12 — company types, markets, buyers, signals, scoring, exclusions, routing.';

create index if not exists icps_business_idx on public.icps (business_id, is_active);

-- ---------------------------------------------------------------------------
-- leads — the exact data_model.critical_fields.leads column set, plus the
-- operational columns listed in DB_CONTRACT.md §1.4.
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  person_id              uuid not null references public.people (id) on delete cascade,
  company_id             uuid references public.companies (id) on delete set null,
  primary_icp_id         uuid references public.icps (id) on delete set null,
  owner_user_id          uuid references public.users (id) on delete set null,
  outreach_identity_id   uuid,
  status                 text not null default 'new'
                           constraint leads_status_check
                           check (status in (
                             'new', 'needs_profile', 'ready', 'connection_due',
                             'connection_sent', 'connection_accepted', 'message_due',
                             'followup_due', 'replied', 'paused', 'cooldown', 'dormant',
                             'reactivation_due', 'interested', 'wrong_person',
                             'do_not_contact', 'archived', 'deleted'
                           )),
  source_type            text
                           constraint leads_source_type_check
                           check (source_type is null or source_type in (
                             'manual_add', 'manual_companion', 'file_csv', 'file_xlsx',
                             'paste_list', 'google_search', 'apollo_basic',
                             'external_ingest', 'mcp_agent', 'research_agent'
                           )),
  source_url             text,
  sequence_enrollment_id uuid,
  next_action_type       text not null default 'none'
                           constraint leads_next_action_type_check
                           check (next_action_type in (
                             'capture_profile', 'connection', 'message_1', 'followup_1',
                             'followup_2', 'followup_3', 'reactivation', 'review', 'task',
                             'none'
                           )),
  next_action_at         timestamptz,
  needs_profile          boolean not null default false,
  lost_reason            text,
  is_dnc                 boolean not null default false,
  import_batch_id        uuid,
  created_by             uuid references public.users (id),
  deleted_by             uuid references public.users (id),
  archived_at            timestamptz,
  last_activity_at       timestamptz,
  duplicate_of_lead_id   uuid references public.leads (id) on delete set null,
  deleted_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.leads is
  'DB_CONTRACT.md §1.4 — one active lead per (business_id, person_id); the partial unique lives in 0010.';

create index if not exists leads_business_status_idx on public.leads (business_id, status);
create index if not exists leads_owner_idx on public.leads (owner_user_id, status);
create index if not exists leads_person_idx on public.leads (person_id);
create index if not exists leads_next_action_idx on public.leads (business_id, next_action_at);

-- ---------------------------------------------------------------------------
-- lead_icp_matches — pk (lead_id, icp_id); one primary per lead (invariant 2)
-- ---------------------------------------------------------------------------
create table if not exists public.lead_icp_matches (
  lead_id     uuid not null references public.leads (id) on delete cascade,
  icp_id      uuid not null references public.icps (id) on delete cascade,
  is_primary  boolean not null default false,
  match_score numeric(6, 2),
  reason      text,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.users (id),
  primary key (lead_id, icp_id)
);

comment on table public.lead_icp_matches is
  'spec lead_invariants — a person may match multiple ICPs, but only one match may be primary.';

-- ---------------------------------------------------------------------------
-- lead_assignments
-- ---------------------------------------------------------------------------
create table if not exists public.lead_assignments (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads (id) on delete cascade,
  business_id   uuid not null references public.businesses (id) on delete cascade,
  from_user_id  uuid references public.users (id) on delete set null,
  to_user_id    uuid references public.users (id) on delete set null,
  reason        text,
  actor_user_id uuid references public.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists lead_assignments_lead_idx
  on public.lead_assignments (lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- notes (internal note is separate from the captured inbound text)
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  lead_id        uuid references public.leads (id) on delete cascade,
  person_id      uuid references public.people (id) on delete cascade,
  author_user_id uuid references public.users (id) on delete set null,
  body           text not null,
  is_internal    boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint notes_subject_check check (lead_id is not null or person_id is not null)
);

create index if not exists notes_lead_idx on public.notes (lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- tasks — the exact tasks_and_my_day.task_fields set, plus operational columns
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid references public.leads (id) on delete cascade,
  business_id    uuid not null references public.businesses (id) on delete cascade,
  owner_user_id  uuid references public.users (id) on delete set null,
  type           text not null default 'follow_up'
                   constraint tasks_type_check
                   check (type in (
                     'follow_up', 'connection', 'message', 'research', 'reply',
                     'profile_capture', 'reactivation', 'admin', 'other'
                   )),
  title          text not null,
  due_at         timestamptz,
  priority       text not null default 'normal'
                   constraint tasks_priority_check
                   check (priority in ('low', 'normal', 'high', 'urgent')),
  reminder_at    timestamptz,
  status         text not null default 'open'
                   constraint tasks_status_check
                   check (status in ('open', 'done', 'cancelled', 'snoozed')),
  note           text,
  source         text not null default 'user'
                   constraint tasks_source_check
                   check (source in ('user', 'admin', 'system', 'agent', 'sequence')),
  completed_at   timestamptz,
  snoozed_until  timestamptz,
  created_by     uuid references public.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

comment on table public.tasks is
  'spec tasks_and_my_day — My Day derives connections / accepted+message1 / follow-ups / overdue / custom tasks from this table plus the sequence engine.';

-- data_model.indexes_and_uniqueness: "Tasks indexed by owner_user_id + status + due_at"
create index if not exists tasks_owner_status_due_idx
  on public.tasks (owner_user_id, status, due_at);
create index if not exists tasks_business_due_idx
  on public.tasks (business_id, status, due_at);

-- ---------------------------------------------------------------------------
-- interactions — the canonical timeline
-- ---------------------------------------------------------------------------
create table if not exists public.interactions (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references public.businesses (id) on delete cascade,
  lead_id              uuid references public.leads (id) on delete cascade,
  person_id            uuid references public.people (id) on delete set null,
  conversation_id      uuid,
  type                 text not null
                         constraint interactions_type_check
                         check (type in (
                           'outbound_message', 'inbound_reply', 'internal_note',
                           'connection_event', 'sequence_state_change', 'task_event',
                           'profile_capture', 'signal', 'assignment', 'identity_transfer',
                           'import', 'system'
                         )),
  actor_user_id        uuid references public.users (id) on delete set null,
  outreach_identity_id uuid,
  direction            text not null default 'internal'
                         constraint interactions_direction_check
                         check (direction in ('outbound', 'inbound', 'internal')),
  summary              text,
  payload              jsonb not null default '{}'::jsonb,
  source_client        text,
  occurred_at          timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

comment on table public.interactions is
  'spec reply_and_notes.history_rule — the timeline distinguishes outbound messages, inbound replies, internal notes, tasks, connection events, sequence state changes and sender identity.';

create index if not exists interactions_lead_idx
  on public.interactions (lead_id, occurred_at desc);
create index if not exists interactions_business_idx
  on public.interactions (business_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- cooldowns — business-specific pause (NOT a DNC suppression)
-- ---------------------------------------------------------------------------
create table if not exists public.cooldowns (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  lead_id      uuid references public.leads (id) on delete cascade,
  person_id    uuid references public.people (id) on delete cascade,
  reason       text,
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz,
  is_active    boolean not null default true,
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  constraint cooldowns_window_check check (ends_at is null or ends_at >= starts_at)
);

create index if not exists cooldowns_active_idx
  on public.cooldowns (business_id, is_active, ends_at);

-- ---------------------------------------------------------------------------
-- contact_suppressions — business_id NULL = global across every identity
-- ---------------------------------------------------------------------------
create table if not exists public.contact_suppressions (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references public.people (id) on delete cascade,
  channel         text not null
                    constraint contact_suppressions_channel_check
                    check (channel in ('linkedin', 'email', 'phone', 'other')),
  reason          text,
  source_reply_id uuid,
  active          boolean not null default true,
  business_id     uuid references public.businesses (id) on delete cascade,
  created_by      uuid references public.users (id),
  revoked_at      timestamptz,
  revoked_by      uuid references public.users (id),
  evidence        text,
  created_at      timestamptz not null default now()
);

comment on table public.contact_suppressions is
  'spec sequence_engine.do_not_contact — explicit DNC creates a global person+channel suppression; ordinary "Not interested" does NOT.';

create index if not exists contact_suppressions_person_idx
  on public.contact_suppressions (person_id, channel, active);

-- ---------------------------------------------------------------------------
-- opportunities / rfps
-- ---------------------------------------------------------------------------
create table if not exists public.opportunities (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  lead_id           uuid references public.leads (id) on delete cascade,
  name              text not null,
  stage             text not null default 'identified'
                      constraint opportunities_stage_check
                      check (stage in ('identified', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  value             numeric(14, 2),
  currency          text not null default 'USD',
  expected_close_at timestamptz,
  created_by        uuid references public.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create index if not exists opportunities_business_stage_idx
  on public.opportunities (business_id, stage);

create table if not exists public.rfps (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null references public.businesses (id) on delete cascade,
  lead_id                  uuid references public.leads (id) on delete set null,
  company_id               uuid references public.companies (id) on delete set null,
  title                    text not null,
  source_url               text,
  deadline_at              timestamptz,
  min_days_before_deadline integer not null default 2
                             constraint rfps_min_days_check check (min_days_before_deadline >= 0),
  state                    text not null default 'discovered'
                             constraint rfps_state_check
                             check (state in ('discovered', 'reviewing', 'bidding', 'submitted', 'won', 'lost', 'ignored')),
  detail                   jsonb not null default '{}'::jsonb,
  created_by               uuid references public.users (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz
);

comment on table public.rfps is
  'spec business_units.examples (Lavish Foods) — only surface tenders with at least 2-3 days before the deadline.';

create index if not exists rfps_business_state_idx on public.rfps (business_id, state, deadline_at);
