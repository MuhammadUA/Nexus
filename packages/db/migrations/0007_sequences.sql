-- ============================================================================
-- NEXUS DB · 0007 — sequence engine and conversations
--
-- Implements DB_CONTRACT.md §1.6
-- Spec
--   sequence_engine.entities                 (all ten entities)
--   sequence_engine.default_steps            (Message 1 / FU1 / FU2 / FU3 delays)
--   sequence_engine.sequence_step_instruction_fields
--   sequence_engine.message_states           (DYNAMIC / LOCKED / SENT)
--   sequence_engine.generation_timing        (do not pre-generate follow-ups)
--   sequence_engine.publish_behavior         (sent immutable, locked untouched,
--                                             dynamic eligible -> needs regeneration)
--   lead_lifecycle.after_followup_3          (Dormant ~60 days, configurable)
--   data_model.indexes_and_uniqueness        (message event timeline index)
--
-- ASSUMPTION: conversations has no `updated_at` in the contract but the table is
-- touched on every message; it is included and maintained by the shared
-- touch_updated_at() trigger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- sequences / sequence_versions
-- ---------------------------------------------------------------------------
create table if not exists public.sequences (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses (id) on delete cascade,
  name               text not null,
  description        text,
  is_default         boolean not null default false,
  status             text not null default 'draft'
                       constraint sequences_status_check
                       check (status in ('draft', 'active', 'paused', 'archived')),
  current_version_id uuid,
  created_by         uuid references public.users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create index if not exists sequences_business_idx on public.sequences (business_id, status);

create table if not exists public.sequence_versions (
  id              uuid primary key default gen_random_uuid(),
  sequence_id     uuid not null references public.sequences (id) on delete cascade,
  version         integer not null
                    constraint sequence_versions_version_check check (version > 0),
  status          text not null default 'draft'
                    constraint sequence_versions_status_check
                    check (status in ('draft', 'published', 'archived')),
  published_at    timestamptz,
  published_by    uuid references public.users (id) on delete set null,
  change_summary  text,
  impact_preview  jsonb not null default '{}'::jsonb,
  created_by      uuid references public.users (id),
  created_at      timestamptz not null default now(),
  constraint sequence_versions_sequence_version_key unique (sequence_id, version),
  constraint sequence_versions_publish_check
    check (status <> 'published' or published_at is not null)
);

create table if not exists public.sequence_steps (
  id                   uuid primary key default gen_random_uuid(),
  sequence_version_id  uuid not null references public.sequence_versions (id) on delete cascade,
  step_order           integer not null
                         constraint sequence_steps_order_check check (step_order > 0),
  kind                 text not null
                         constraint sequence_steps_kind_check
                         check (kind in ('connection', 'message', 'followup', 'reactivation')),
  name                 text not null,
  delay_days           integer not null default 0
                         constraint sequence_steps_delay_check check (delay_days >= 0),
  delay_basis          text not null default 'after_previous'
                         constraint sequence_steps_delay_basis_check
                         check (delay_basis in ('immediate', 'after_previous', 'after_enrollment', 'after_connection')),
  goal                 text,
  allowed_context      text[] not null default array[]::text[],
  word_max             integer
                         constraint sequence_steps_word_max_check
                         check (word_max is null or word_max > 0),
  cta_style            text,
  prohibited_phrases   text[] not null default array[]::text[],
  proof_policy         text,
  tone                 text,
  generation_mode      text not null default 'ai'
                         constraint sequence_steps_generation_mode_check
                         check (generation_mode in ('ai', 'manual', 'hybrid')),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint sequence_steps_version_order_key unique (sequence_version_id, step_order)
);

comment on table public.sequence_steps is
  'spec sequence_engine.sequence_step_instruction_fields — goal, allowed_context, word_max, cta_style, prohibited_phrases, proof_policy, tone, generation_mode.';

-- ---------------------------------------------------------------------------
-- sequence_enrollments — invariant 10 via the partial unique in 0010
-- ---------------------------------------------------------------------------
create table if not exists public.sequence_enrollments (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  lead_id             uuid not null references public.leads (id) on delete cascade,
  sequence_id         uuid not null references public.sequences (id) on delete cascade,
  sequence_version_id uuid not null references public.sequence_versions (id) on delete restrict,
  state               text not null default 'active'
                        constraint sequence_enrollments_state_check
                        check (state in ('active', 'completed', 'paused', 'cancelled', 'dormant', 'reactivation_due')),
  current_step_order  integer not null default 0
                        constraint sequence_enrollments_step_check check (current_step_order >= 0),
  started_at          timestamptz not null default now(),
  completed_at        timestamptz,
  paused_at           timestamptz,
  pause_reason        text,
  dormant_at          timestamptz,
  reactivation_due_at timestamptz,
  created_by          uuid references public.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists sequence_enrollments_business_idx
  on public.sequence_enrollments (business_id, state);

-- ---------------------------------------------------------------------------
-- conversations — first sender identity owns the channel
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  lead_id                uuid not null references public.leads (id) on delete cascade,
  channel                text not null default 'linkedin'
                           constraint conversations_channel_check
                           check (channel in ('linkedin', 'email', 'phone', 'other')),
  sender_identity_id     uuid references public.outreach_identities (id) on delete set null,
  default_owner_user_id  uuid references public.users (id) on delete set null,
  last_outbound_at       timestamptz,
  last_inbound_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint conversations_lead_channel_key unique (lead_id, channel)
);

create index if not exists conversations_sender_idx on public.conversations (sender_identity_id);

-- ---------------------------------------------------------------------------
-- conversation_outcomes — drives DNC + reply pause triggers (invariants 8, 9)
-- ---------------------------------------------------------------------------
create table if not exists public.conversation_outcomes (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  lead_id          uuid not null references public.leads (id) on delete cascade,
  business_id      uuid not null references public.businesses (id) on delete cascade,
  outcome          text not null
                     constraint conversation_outcomes_outcome_check
                     check (outcome in (
                       'Interested', 'Positive / needs info', 'Maybe later',
                       'No current need', 'Not interested', 'Wrong person',
                       'Already has supplier', 'Do not contact', 'Other'
                     )),
  is_terminal      boolean not null default false,
  reason           text,
  source_reply_id  uuid,
  actor_user_id    uuid references public.users (id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists conversation_outcomes_lead_idx
  on public.conversation_outcomes (lead_id, created_at desc);

-- ---------------------------------------------------------------------------
-- business_context_versions — the frozen Business Brain snapshot a message used
-- ---------------------------------------------------------------------------
create table if not exists public.business_context_versions (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  version      integer not null
                 constraint business_context_versions_version_check check (version > 0),
  snapshot     jsonb not null default '{}'::jsonb,
  reason       text,
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  constraint business_context_versions_business_version_key unique (business_id, version)
);

-- ---------------------------------------------------------------------------
-- message_instances
-- ---------------------------------------------------------------------------
create table if not exists public.message_instances (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid not null references public.conversations (id) on delete cascade,
  sequence_step_id     uuid references public.sequence_steps (id) on delete set null,
  state                text not null default 'DYNAMIC'
                         constraint message_instances_state_check
                         check (state in ('DYNAMIC', 'LOCKED', 'SENT')),
  current_version_id   uuid,
  due_at               timestamptz,
  sent_at              timestamptz,
  business_id          uuid not null references public.businesses (id) on delete cascade,
  lead_id              uuid not null references public.leads (id) on delete cascade,
  step_order           integer not null default 0
                         constraint message_instances_step_order_check check (step_order >= 0),
  step_kind            text not null default 'message'
                         constraint message_instances_step_kind_check
                         check (step_kind in ('connection', 'message', 'followup', 'reactivation')),
  invalidated_at       timestamptz,
  regeneration_reason  text,
  snoozed_until        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint message_instances_sent_check
    check ((state = 'SENT') = (sent_at is not null)),
  constraint message_instances_invalidated_check
    check (invalidated_at is null or regeneration_reason is not null)
);

create index if not exists message_instances_lead_idx
  on public.message_instances (lead_id, due_at);
create index if not exists message_instances_due_idx
  on public.message_instances (business_id, state, due_at);
create index if not exists message_instances_step_idx
  on public.message_instances (sequence_step_id);

-- ---------------------------------------------------------------------------
-- message_versions — immutable once the instance is SENT (invariant 7)
-- ---------------------------------------------------------------------------
create table if not exists public.message_versions (
  id                          uuid primary key default gen_random_uuid(),
  message_instance_id         uuid not null references public.message_instances (id) on delete cascade,
  content                     text not null,
  generated_by_model          text,
  prompt_version_id           uuid references public.prompt_versions (id) on delete set null,
  sequence_version_id         uuid references public.sequence_versions (id) on delete set null,
  business_context_version_id uuid references public.business_context_versions (id) on delete set null,
  asset_version_refs          uuid[] not null default array[]::uuid[],
  created_by                  uuid references public.users (id) on delete set null,
  created_at                  timestamptz not null default now(),
  version_no                  integer
                                constraint message_versions_version_no_check
                                check (version_no is null or version_no > 0),
  subject                     text,
  is_manual_edit              boolean not null default false,
  constraint message_versions_instance_version_key unique (message_instance_id, version_no),
  constraint message_versions_audit_refs_check
    check (
      created_by is not null
      or generated_by_model is not null
      or public.acting_api_client_id() is not null
    )
);

comment on table public.message_versions is
  'DB_CONTRACT.md §2 invariant 19 — created_by is required unless the version was generated by a model or an api_client.';

create index if not exists message_versions_instance_idx
  on public.message_versions (message_instance_id, created_at desc);

-- ---------------------------------------------------------------------------
-- message_events — the append-only message timeline
-- ---------------------------------------------------------------------------
create table if not exists public.message_events (
  id                   uuid primary key default gen_random_uuid(),
  message_instance_id  uuid not null references public.message_instances (id) on delete cascade,
  event_type           text not null
                         constraint message_events_event_type_check
                         check (event_type in (
                           'generated', 'regenerated', 'edited', 'locked', 'unlocked',
                           'copied', 'sent', 'snoozed', 'invalidated', 'reverted',
                           'failed'
                         )),
  actor_user_id        uuid references public.users (id) on delete set null,
  outreach_identity_id uuid references public.outreach_identities (id) on delete set null,
  source_client        text,
  note                 text,
  business_id          uuid not null references public.businesses (id) on delete cascade,
  lead_id              uuid not null references public.leads (id) on delete cascade,
  message_version_id   uuid references public.message_versions (id) on delete set null,
  payload              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

-- data_model.indexes_and_uniqueness: "Message event timeline indexed by
-- lead/conversation + created_at"
create index if not exists message_events_lead_timeline_idx
  on public.message_events (lead_id, created_at desc);
create index if not exists message_events_instance_timeline_idx
  on public.message_events (message_instance_id, created_at desc);
